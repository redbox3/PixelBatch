// Camera RAW support: reads the full-size JPEG the camera embeds in TIFF-based RAW files
// (Nikon NEF/NRW, Canon CR2, Sony ARW/SR2, Pentax PEF, Adobe DNG, ...).
const fsp = require('fs').promises;

const RAW_EXT = ['.nef', '.nrw', '.cr2', '.arw', '.sr2', '.dng', '.pef'];

async function readAt(fh, offset, length) {
  const buf = Buffer.alloc(length);
  const { bytesRead } = await fh.read(buf, 0, length, offset);
  return buf.subarray(0, bytesRead);
}

// Walks the TIFF IFD tree (IFD chain plus SubIFDs and the EXIF IFD) and lists every JPEG it points at.
async function findJpegs(fh, size) {
  const head = await readAt(fh, 0, 8);
  const le = head.toString('latin1', 0, 2) === 'II';
  if (!le && head.toString('latin1', 0, 2) !== 'MM') throw new Error('Not a TIFF-based RAW file');
  const u16 = (b, o) => (le ? b.readUInt16LE(o) : b.readUInt16BE(o));
  const u32 = (b, o) => (le ? b.readUInt32LE(o) : b.readUInt32BE(o));
  const found = [];
  let orientation = 1;
  const seen = new Set();
  const queue = [{ off: u32(head, 4), chain: true, top: true }];

  while (queue.length && seen.size < 64) {
    const { off, chain, top } = queue.shift();
    if (!off || off >= size || seen.has(off)) continue;
    seen.add(off);
    const count = u16(await readAt(fh, off, 2), 0);
    if (count > 1000) continue;
    const ifd = await readAt(fh, off + 2, count * 12 + 4);
    const tags = {};
    for (let i = 0; i < count; i++) {
      const e = i * 12;
      const tag = u16(ifd, e), type = u16(ifd, e + 2), n = u32(ifd, e + 4);
      const small = type === 3 ? u16(ifd, e + 8) : u32(ifd, e + 8);
      tags[tag] = { type, n, value: n === 1 ? small : u32(ifd, e + 8), raw: e + 8 };
      if ((tag === 0x14a || tag === 0x8769) && type !== 0) {
        // SubIFDs (several offsets, stored elsewhere when there is more than one) and the EXIF IFD.
        if (n === 1) queue.push({ off: u32(ifd, e + 8) });
        else {
          const list = await readAt(fh, u32(ifd, e + 8), n * 4);
          for (let k = 0; k < n; k++) queue.push({ off: u32(list, k * 4) });
        }
      }
    }
    if (top && tags[0x112]) orientation = tags[0x112].value;
    if (tags[0x201] && tags[0x202]) found.push({ offset: tags[0x201].value, length: tags[0x202].value });
    // A strip-stored JPEG (Compression 6/7) in a single strip.
    if (tags[0x103] && [6, 7].includes(tags[0x103].value) && tags[0x111]?.n === 1 && tags[0x117]?.n === 1 && !tags[0x201]) {
      found.push({ offset: tags[0x111].value, length: tags[0x117].value, maybeLossless: tags[0x103].value === 7 });
    }
    if (chain) queue.push({ off: u32(ifd, count * 12), chain: true, top: false });
  }
  return { jpegs: found.filter(j => j.offset + j.length <= size && j.length > 1024), orientation };
}

// Minimal EXIF APP1 segment holding only an Orientation tag, so sharp's autoOrient rotates the preview.
function orientationApp1(orientation) {
  const tiff = Buffer.alloc(26);
  tiff.write('II', 0, 'latin1');
  tiff.writeUInt16LE(42, 2);
  tiff.writeUInt32LE(8, 4);
  tiff.writeUInt16LE(1, 8);
  tiff.writeUInt16LE(0x112, 10);
  tiff.writeUInt16LE(3, 12);
  tiff.writeUInt32LE(1, 14);
  tiff.writeUInt16LE(orientation, 18);
  tiff.writeUInt32LE(0, 22);
  const body = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
  const head = Buffer.from([0xff, 0xe1, 0, 0]);
  head.writeUInt16BE(body.length + 2, 2);
  return Buffer.concat([head, body]);
}

// Largest decodable embedded JPEG, with the RAW file's orientation applied as EXIF.
async function extractPreview(file) {
  const fh = await fsp.open(file, 'r');
  try {
    const { size } = await fh.stat();
    const { jpegs, orientation } = await findJpegs(fh, size);
    // Lossless (Compression 7) strips are RAW sensor data, not a viewable JPEG.
    const candidates = jpegs.filter(j => !j.maybeLossless).sort((a, b) => b.length - a.length);
    for (const j of candidates) {
      const data = await readAt(fh, j.offset, j.length);
      if (data[0] !== 0xff || data[1] !== 0xd8) continue;
      if (orientation > 1 && orientation <= 8) return Buffer.concat([data.subarray(0, 2), orientationApp1(orientation), data.subarray(2)]);
      return data;
    }
    throw new Error('No embedded preview found in this RAW file');
  } finally { await fh.close(); }
}

const isRaw = file => RAW_EXT.some(e => file.toLowerCase().endsWith(e));

module.exports = { RAW_EXT, isRaw, extractPreview };

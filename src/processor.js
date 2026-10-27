// Image processing engine: no Electron dependencies, so it can be tested with plain Node.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const sharp = require('sharp');

sharp.cache({ memory: 256, files: 0 });

const INPUT_EXT = ['.jpg', '.jpeg', '.jpe', '.jfif', '.png', '.webp', '.gif', '.avif', '.tif', '.tiff', '.svg', '.pdf'];
const ANIMATABLE = ['gif', 'webp'];
const LOSSY_Q = ['jpeg', 'webp', 'avif'];
const EXT = { jpeg: 'jpg', png: 'png', webp: 'webp', avif: 'avif', gif: 'gif', tiff: 'tif', bmp: 'bmp', ico: 'ico' };
const FIT = { contain: 'inside', pad: 'contain', cover: 'cover', fill: 'fill', outside: 'outside' };

let mupdfPromise;
const getMupdf = () => (mupdfPromise ||= import('mupdf'));

// ---------- scanning ----------

function isSupported(file) {
  return INPUT_EXT.includes(path.extname(file).toLowerCase());
}

async function walk(dir, recursive, out) {
  let entries;
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { if (recursive) await walk(full, recursive, out); }
    else if (isSupported(full)) out.push(full);
  }
}

// Expands a mix of files and folders into a flat, de-duplicated list of supported files.
// `root` is remembered so the output can mirror the source folder structure.
async function scanPaths(paths, recursive = true) {
  const results = [];
  for (const p of paths) {
    let st;
    try { st = await fsp.stat(p); } catch { continue; }
    if (st.isDirectory()) {
      const files = [];
      await walk(p, recursive, files);
      files.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
      for (const f of files) results.push({ path: f, root: p });
    } else if (isSupported(p)) {
      results.push({ path: p, root: path.dirname(p) });
    }
  }
  const seen = new Set();
  const unique = results.filter(r => !seen.has(r.path) && seen.add(r.path));
  return Promise.all(unique.map(async r => {
    const st = await fsp.stat(r.path);
    return { ...r, name: path.basename(r.path), ext: path.extname(r.path).slice(1).toLowerCase(), bytes: st.size, mtime: st.mtimeMs };
  }));
}

// ---------- PDF ----------

function parsePageSpec(spec, count) {
  spec = String(spec || 'all').trim().toLowerCase();
  if (spec === 'all' || spec === '') return [...Array(count).keys()];
  if (spec === 'first') return [0];
  if (spec === 'last') return [count - 1];
  const pages = new Set();
  for (const part of spec.split(',')) {
    const m = part.trim().match(/^(\d+)\s*(?:-\s*(\d+|end))?$/);
    if (!m) continue;
    const a = parseInt(m[1], 10);
    const b = m[2] ? (m[2] === 'end' ? count : parseInt(m[2], 10)) : a;
    for (let i = Math.min(a, b); i <= Math.max(a, b); i++) if (i >= 1 && i <= count) pages.add(i - 1);
  }
  return [...pages].sort((x, y) => x - y);
}

async function openPdf(file) {
  const mupdf = await getMupdf();
  const doc = mupdf.Document.openDocument(await fsp.readFile(file), 'application/pdf');
  if (doc.needsPassword()) { doc.destroy(); throw new Error('PDF is password protected'); }
  return { mupdf, doc };
}

function renderPdfPage(mupdf, doc, index, scale, alpha) {
  const page = doc.loadPage(index);
  try {
    const pix = page.toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceRGB, alpha, true);
    const png = Buffer.from(pix.asPNG());
    pix.destroy();
    return png;
  } finally { page.destroy(); }
}

// ---------- geometry ----------

// The scale a vector source (SVG/PDF, in 72dpi units) must be rasterised at so that
// the largest requested output is rendered crisply rather than upscaled.
function vectorScale(w, h, preset) {
  const sizes = activeSizes(preset);
  const fallback = (preset.vectorDpi || 150) / 72;
  if (preset.fit === 'none' || !sizes.length || !w || !h) return fallback;
  let scale = 0;
  for (const s of sizes) {
    const sx = s.width ? s.width / w : 0;
    const sy = s.height ? s.height / h : 0;
    let need;
    if (sx && sy) need = (preset.fit === 'contain' || preset.fit === 'pad') ? Math.min(sx, sy) : Math.max(sx, sy);
    else need = sx || sy || fallback;
    scale = Math.max(scale, need);
  }
  scale = Math.min(Math.max(scale * 1.02, 0.05), 40);
  const maxPixels = 120e6;
  if (w * h * scale * scale > maxPixels) scale = Math.sqrt(maxPixels / (w * h));
  return scale;
}

// Predicts output dimensions (used for watermark sizing and dry-run naming).
function predictSize(w, h, size, preset) {
  if (!size || preset.fit === 'none' || (!size.width && !size.height)) return { width: w, height: h };
  const enlarge = !!preset.enlarge;
  let W = size.width, H = size.height;
  if (!W) W = Math.round(w * H / h);
  if (!H) H = Math.round(h * W / w);
  const fit = (!size.width || !size.height) ? 'contain' : preset.fit;
  if (fit === 'contain' || fit === 'outside') {
    let r = fit === 'contain' ? Math.min(W / w, H / h) : Math.max(W / w, H / h);
    if (!enlarge) r = Math.min(r, 1);
    return { width: Math.max(1, Math.round(w * r)), height: Math.max(1, Math.round(h * r)) };
  }
  if (!enlarge && (W > w || H > h) && fit !== 'pad') {
    const r = Math.min(1, Math.min(w / W, h / H));
    return { width: Math.round(W * r), height: Math.round(H * r) };
  }
  return { width: W, height: H };
}

function activeSizes(preset) {
  return (preset.sizes || []).filter(s => s.enabled !== false && (s.width || s.height));
}

// ---------- colour helpers ----------

function parseColor(hex, transparent) {
  const m = String(hex || '#ffffff').replace('#', '').match(/^([0-9a-f]{6})$/i);
  const v = m ? parseInt(m[1], 16) : 0xffffff;
  return { r: (v >> 16) & 255, g: (v >> 8) & 255, b: v & 255, alpha: transparent ? 0 : 1 };
}

function escapeXml(s) {
  return String(s).replace(/[<>&'"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
}

const GRAVITY = { tl: 'northwest', tc: 'north', tr: 'northeast', ml: 'west', c: 'centre', mr: 'east', bl: 'southwest', bc: 'south', br: 'southeast' };

async function watermarkLayers(wm, width, height) {
  const layers = [];
  if (!wm || !wm.enabled) return layers;
  const opacity = Math.min(1, Math.max(0, (wm.opacity ?? 50) / 100));
  const gravity = GRAVITY[wm.position] || 'southeast';
  const margin = Math.round(Math.min(width, height) * 0.03);
  if (wm.type === 'image' && wm.imagePath) {
    const targetW = Math.max(8, Math.round(width * (wm.scale || 20) / 100));
    let logo = await sharp(wm.imagePath, { density: 300 })
      .resize({ width: Math.min(targetW, width - 2 * margin), height: height - 2 * margin, fit: 'inside' })
      .ensureAlpha().png().toBuffer();
    const meta = await sharp(logo).metadata();
    logo = await sharp(logo)
      .composite([{ input: Buffer.from([255, 255, 255, Math.round(opacity * 255)]), raw: { width: 1, height: 1, channels: 4 }, tile: true, blend: 'dest-in' }])
      .extend({ top: margin, bottom: margin, left: margin, right: margin, background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png().toBuffer();
    if (meta.width + 2 * margin <= width && meta.height + 2 * margin <= height) layers.push({ input: logo, gravity });
  } else if (wm.text) {
    let fontSize = Math.max(8, Math.round(width * (wm.scale || 4) / 100));
    const estW = t => Math.ceil(t.length * fontSize * 0.62) + 2 * margin;
    while (estW(wm.text) > width && fontSize > 6) fontSize--;
    const boxW = Math.min(width, estW(wm.text));
    const boxH = Math.min(height, Math.ceil(fontSize * 1.5) + 2 * margin);
    const color = parseColor(wm.color || '#ffffff');
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${boxW}" height="${boxH}">
      <text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" font-family="Segoe UI, Helvetica, Arial, sans-serif"
        font-size="${fontSize}" font-weight="600" fill="rgb(${color.r},${color.g},${color.b})" fill-opacity="${opacity}"
        stroke="rgba(0,0,0,${opacity * 0.35})" stroke-width="${Math.max(1, fontSize / 28)}">${escapeXml(wm.text)}</text></svg>`;
    layers.push({ input: Buffer.from(svg), gravity });
  }
  return layers;
}

// ---------- encoding ----------

function resolveFormat(preset, srcFormat) {
  if (preset.format && preset.format !== 'original') return preset.format;
  const map = { jpg: 'jpeg', jpeg: 'jpeg', jpe: 'jpeg', jfif: 'jpeg', png: 'png', webp: 'webp', gif: 'gif', avif: 'avif', heif: 'avif', tif: 'tiff', tiff: 'tiff' };
  return map[srcFormat] || 'png';
}

function applyEncoder(img, fmt, p, q, colours) {
  switch (fmt) {
    case 'jpeg': return img.jpeg({ quality: q, mozjpeg: true, progressive: p.progressive !== false, chromaSubsampling: q >= 90 ? '4:4:4' : '4:2:0' });
    case 'png': return img.png({ compressionLevel: 9, adaptiveFiltering: true, palette: !!colours || !!p.pngPalette, quality: q, colours: colours || p.pngColours || 256, progressive: false });
    case 'webp': return img.webp({ quality: q, lossless: !!p.webpLossless, effort: 4, alphaQuality: Math.max(q, 80), loop: 0 });
    case 'avif': return img.avif({ quality: q, effort: 4 });
    case 'gif': return img.gif({ colours: colours || p.gifColours || 256, dither: (p.gifDither ?? 100) / 100, effort: 7, loop: 0, interFrameMaxError: p.gifLossy || 0 });
    case 'tiff': return img.tiff({ compression: p.tiffCompression || 'lzw', quality: q });
    default: return img.png();
  }
}

// 32-bit BGRA bottom-up BMP with a BITMAPV4 header so alpha is preserved.
function encodeBmp(data, width, height) {
  const rowBytes = width * 4;
  const header = 14 + 108;
  const buf = Buffer.alloc(header + rowBytes * height);
  buf.write('BM', 0);
  buf.writeUInt32LE(buf.length, 2);
  buf.writeUInt32LE(header, 10);
  buf.writeUInt32LE(108, 14);
  buf.writeInt32LE(width, 18);
  buf.writeInt32LE(height, 22);
  buf.writeUInt16LE(1, 26);
  buf.writeUInt16LE(32, 28);
  buf.writeUInt32LE(3, 30); // BI_BITFIELDS
  buf.writeUInt32LE(rowBytes * height, 34);
  buf.writeInt32LE(2835, 38); buf.writeInt32LE(2835, 42);
  buf.writeUInt32LE(0x00ff0000, 54); buf.writeUInt32LE(0x0000ff00, 58);
  buf.writeUInt32LE(0x000000ff, 62); buf.writeUInt32LE(0xff000000, 66);
  buf.write('BGRs', 70, 'latin1');
  for (let y = 0; y < height; y++) {
    const src = (height - 1 - y) * rowBytes;
    let dst = header + y * rowBytes;
    for (let x = 0; x < rowBytes; x += 4) {
      buf[dst++] = data[src + x + 2]; buf[dst++] = data[src + x + 1];
      buf[dst++] = data[src + x]; buf[dst++] = data[src + x + 3];
    }
  }
  return buf;
}

// ICO containing PNG-encoded images (Vista+ format) at the requested icon sizes.
async function encodeIco(pngBuffer, iconSizes) {
  const sizes = [...new Set((iconSizes && iconSizes.length ? iconSizes : [16, 32, 48, 256]).map(Number).filter(n => n > 0 && n <= 256))].sort((a, b) => a - b);
  const images = await Promise.all(sizes.map(s =>
    sharp(pngBuffer).resize(s, s, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer()));
  const head = Buffer.alloc(6 + 16 * images.length);
  head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(images.length, 4);
  let offset = head.length;
  images.forEach((img, i) => {
    const o = 6 + i * 16;
    head[o] = sizes[i] >= 256 ? 0 : sizes[i];
    head[o + 1] = sizes[i] >= 256 ? 0 : sizes[i];
    head.writeUInt16LE(1, o + 4); head.writeUInt16LE(32, o + 6);
    head.writeUInt32LE(img.length, o + 8); head.writeUInt32LE(offset, o + 12);
    offset += img.length;
  });
  return Buffer.concat([head, ...images]);
}

// Encodes `img` (a sharp pipeline) honouring quality or a target file size.
async function encode(img, fmt, p) {
  const warnings = [];
  const quality = Math.round(p.quality || 82);
  if (fmt === 'bmp') {
    const { data, info } = await img.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    return { buffer: encodeBmp(data, info.width, info.height), width: info.width, height: info.height, quality: null, warnings };
  }
  if (fmt === 'ico') {
    const { data, info } = await img.png().toBuffer({ resolveWithObject: true });
    return { buffer: await encodeIco(data, p.icoSizes), width: info.width, height: info.height, quality: null, warnings };
  }

  const target = p.targetEnabled && p.targetKB > 0 ? p.targetKB * 1024 : 0;
  const run = async (q, colours) => {
    const { data, info } = await applyEncoder(img.clone(), fmt, p, q, colours).toBuffer({ resolveWithObject: true });
    return { buffer: data, width: info.width, height: info.pageHeight || info.height, quality: q, colours };
  };

  if (!target) return { ...(await run(quality)), warnings };

  if (LOSSY_Q.includes(fmt) && !(fmt === 'webp' && p.webpLossless)) {
    // Binary search for the highest quality that fits under the target.
    const minQ = Math.max(1, p.targetMinQuality || 10);
    let best = await run(quality);
    if (best.buffer.length <= target) return { ...best, warnings };
    let lo = minQ, hi = quality - 1, fit = null, smallest = best;
    while (lo <= hi) {
      const mid = Math.floor((lo + hi) / 2);
      const r = await run(mid);
      if (r.buffer.length < smallest.buffer.length) smallest = r;
      if (r.buffer.length <= target) { fit = r; lo = mid + 1; } else hi = mid - 1;
    }
    if (fit) return { ...fit, warnings };
    warnings.push(`Could not reach ${p.targetKB} KB (smallest ${Math.round(smallest.buffer.length / 1024)} KB at quality ${smallest.quality}). Try a smaller size.`);
    return { ...smallest, warnings };
  }

  if (fmt === 'png' || fmt === 'gif') {
    let r = await run(quality);
    if (r.buffer.length <= target) return { ...r, warnings };
    for (const colours of [256, 128, 64, 32, 16, 8, 4]) {
      r = await run(quality, colours);
      if (r.buffer.length <= target) return { ...r, warnings };
    }
    warnings.push(`Could not reach ${p.targetKB} KB with ${fmt.toUpperCase()} (got ${Math.round(r.buffer.length / 1024)} KB). Try JPG/WebP or a smaller size.`);
    return { ...r, warnings };
  }

  const r = await run(quality);
  if (r.buffer.length > target) warnings.push(`Target size is not supported for ${fmt.toUpperCase()}.`);
  return { ...r, warnings };
}

// ---------- pipeline ----------

// Yields the rasterised sources for an input file: one per PDF page, otherwise one.
async function loadSources(file, preset, { previewPage } = {}) {
  const ext = path.extname(file).slice(1).toLowerCase();
  const fmt = resolveFormat(preset, ext);
  if (ext === 'pdf') {
    const { mupdf, doc } = await openPdf(file);
    try {
      const count = doc.countPages();
      let pages = parsePageSpec(preset.pdfPages, count);
      if (previewPage != null) pages = [Math.min(previewPage, count - 1)];
      const alpha = !!preset.pdfTransparent && !['jpeg', 'bmp'].includes(fmt);
      return pages.map(i => {
        const page = doc.loadPage(i);
        const [x0, y0, x1, y1] = page.getBounds();
        page.destroy();
        const scale = vectorScale(x1 - x0, y1 - y0, preset);
        return { input: renderPdfPage(mupdf, doc, i, scale, alpha), opts: {}, page: i + 1, pageCount: count, srcFormat: 'pdf' };
      });
    } finally { doc.destroy(); }
  }
  if (ext === 'svg') {
    const meta = await sharp(file).metadata();
    const density = Math.min(72 * vectorScale(meta.width, meta.height, preset), 100000);
    return [{ input: file, opts: { density }, page: null, pageCount: 1, srcFormat: 'svg' }];
  }
  const animated = !!preset.keepAnimation && ANIMATABLE.includes(fmt) && ANIMATABLE.includes(ext);
  return [{ input: file, opts: { animated }, page: null, pageCount: 1, srcFormat: ext }];
}

function applyGeometry(img, preset) {
  if (preset.autoOrient !== false) img = img.autoOrient();
  if (preset.rotate) img = img.rotate(Number(preset.rotate), { background: parseColor(preset.background, preset.transparentBg) });
  if (preset.flipV) img = img.flip();
  if (preset.flipH) img = img.flop();
  return img;
}

function applyTone(img, preset) {
  if (preset.grayscale) img = img.grayscale();
  if (preset.brightness && preset.brightness !== 100 || preset.saturation && preset.saturation !== 100) {
    img = img.modulate({ brightness: (preset.brightness || 100) / 100, saturation: (preset.saturation || 100) / 100 });
  }
  if (preset.sharpen) img = img.sharpen({ sigma: 0.5 + preset.sharpen / 50 });
  return img;
}

async function renderVariant(src, size, preset) {
  const fmt = resolveFormat(preset, src.srcFormat);
  let img = sharp(src.input, { ...src.opts, failOn: 'none', limitInputPixels: false });
  const meta = await img.metadata();
  const animated = (meta.pages || 1) > 1 && src.opts.animated;
  const srcW = meta.autoOrient?.width || meta.width;
  const srcH = animated ? (meta.pageHeight || meta.height) : (meta.autoOrient?.height || meta.height);

  img = applyGeometry(img, preset);

  const swap = preset.rotate && Math.abs(Number(preset.rotate)) % 180 === 90;
  const baseW = swap ? srcH : srcW, baseH = swap ? srcW : srcH;

  if (size && preset.fit !== 'none' && (size.width || size.height)) {
    const oneSide = !size.width || !size.height;
    img = img.resize({
      width: size.width || null,
      height: size.height || null,
      fit: oneSide ? 'inside' : FIT[preset.fit] || 'inside',
      position: preset.position || 'centre',
      background: parseColor(preset.background, preset.transparentBg && !['jpeg', 'bmp'].includes(fmt)),
      withoutEnlargement: !preset.enlarge,
      kernel: 'lanczos3',
    });
  }

  img = applyTone(img, preset);
  if (fmt === 'jpeg' || (!preset.transparentBg && preset.flattenAlpha)) img = img.flatten({ background: parseColor(preset.background) });

  const warnings = [];
  if (preset.watermark?.enabled) {
    if (animated) warnings.push('Watermark skipped on animated output.');
    else {
      const out = predictSize(baseW, baseH, size, preset);
      const layers = await watermarkLayers(preset.watermark, out.width, out.height);
      if (layers.length) {
        // Composite needs the final dimensions, so materialise the resize first.
        const { data, info } = await img.raw().toBuffer({ resolveWithObject: true });
        const layersFit = await watermarkLayers(preset.watermark, info.width, info.height);
        img = sharp(data, { raw: { width: info.width, height: info.height, channels: info.channels } }).composite(layersFit);
      }
    }
  }

  if (preset.keepMetadata) img = img.keepMetadata();
  else if (preset.keepIcc !== false) img = img.withIccProfile('srgb');

  const result = await encode(img, fmt, preset);
  return { ...result, format: fmt, ext: EXT[fmt], animated, srcWidth: srcW, srcHeight: srcH, warnings: [...warnings, ...result.warnings] };
}

// ---------- naming ----------

function pad(n, w) { return String(n).padStart(w, '0'); }

function buildName(pattern, ctx, rename) {
  const now = ctx.date || new Date();
  const tokens = {
    name: ctx.name,
    ext: ctx.srcExt,
    folder: ctx.folder,
    preset: ctx.preset,
    size: ctx.size?.label || '',
    suffix: ctx.size?.suffix ?? '',
    w: ctx.width ?? '',
    h: ctx.height ?? '',
    page: ctx.pageCount > 1 ? `_p${ctx.page}` : '',
    p: ctx.page ?? '',
    date: `${now.getFullYear()}-${pad(now.getMonth() + 1, 2)}-${pad(now.getDate(), 2)}`,
    time: `${pad(now.getHours(), 2)}${pad(now.getMinutes(), 2)}${pad(now.getSeconds(), 2)}`,
    fmt: ctx.format || '',
  };
  let out = String(pattern || '{name}{suffix}{page}').replace(/\{(\w+)(?::(\d+))?\}/g, (m, key, width) => {
    if (key === 'n') return width ? pad(ctx.index, +width) : String(ctx.index);
    if (key in tokens) return String(tokens[key]);
    return m;
  });
  if (rename?.find) {
    try { out = out.replace(new RegExp(rename.find, rename.findRegex ? 'g' : 'gi'), rename.replace || ''); }
    catch { out = out.split(rename.find).join(rename.replace || ''); }
  }
  if (rename?.spaces === 'dash') out = out.replace(/\s+/g, '-');
  else if (rename?.spaces === 'underscore') out = out.replace(/\s+/g, '_');
  if (rename?.case === 'lower') out = out.toLowerCase();
  else if (rename?.case === 'upper') out = out.toUpperCase();
  else if (rename?.case === 'slug') out = out.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9._-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  out = out.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '');
  return out || 'image';
}

function outputDirFor(file, preset, size) {
  let dir = preset.outputDir;
  if (preset.keepStructure && file.root) {
    const rel = path.relative(file.root, path.dirname(file.path));
    if (rel && !rel.startsWith('..')) dir = path.join(dir, path.basename(file.root), rel);
    else dir = path.join(dir, path.basename(file.root));
  }
  if (preset.subfolderPerSize && size?.label) dir = path.join(dir, buildName(size.label, {}, {}));
  return dir;
}

async function reservePath(target, conflict, reserved) {
  const exists = async p => reserved.has(p.toLowerCase()) || await fsp.access(p).then(() => true, () => false);
  if (!(await exists(target))) { reserved.add(target.toLowerCase()); return target; }
  if (conflict === 'overwrite' && !reserved.has(target.toLowerCase())) { reserved.add(target.toLowerCase()); return target; }
  if (conflict === 'skip' && !reserved.has(target.toLowerCase())) return null;
  const { dir, name, ext } = path.parse(target);
  for (let i = 1; i < 10000; i++) {
    const p = path.join(dir, `${name} (${i})${ext}`);
    if (!(await exists(p))) { reserved.add(p.toLowerCase()); return p; }
  }
  throw new Error('Too many name conflicts');
}

// ---------- public API ----------

// Processes one input file into every enabled size (and every PDF page).
async function processFile(file, preset, index, reserved) {
  const results = [];
  const sizes = preset.fit === 'none' || !activeSizes(preset).length ? [null] : activeSizes(preset);
  const base = path.parse(file.path);
  const ctxBase = { name: base.name, srcExt: base.ext.slice(1), folder: path.basename(base.dir), preset: preset.name, index };

  if (preset.mode === 'rename') {
    let meta = {};
    if (file.ext !== 'pdf') { try { meta = await sharp(file.path).metadata(); } catch {} }
    const name = buildName(preset.renamePattern, { ...ctxBase, width: meta.width, height: meta.height, format: file.ext }, preset.rename);
    const dir = outputDirFor(file, preset, null);
    await fsp.mkdir(dir, { recursive: true });
    const target = await reservePath(path.join(dir, `${name}.${preset.rename?.lowerExt ? file.ext.toLowerCase() : base.ext.slice(1)}`), preset.conflict, reserved);
    if (!target) return [{ input: file.path, skipped: true }];
    if (preset.renameMove) await fsp.rename(file.path, target).catch(async () => { await fsp.copyFile(file.path, target); await fsp.unlink(file.path); });
    else await fsp.copyFile(file.path, target);
    return [{ input: file.path, output: target, bytes: file.bytes, width: meta.width, height: meta.height, warnings: [] }];
  }

  const sources = await loadSources(file.path, preset);
  for (const src of sources) {
    for (const size of sizes) {
      const r = await renderVariant(src, size, preset);
      const name = buildName(preset.renamePattern, { ...ctxBase, size, width: r.width, height: r.height, page: src.page, pageCount: src.pageCount, format: r.ext }, preset.rename);
      const dir = outputDirFor(file, preset, size);
      await fsp.mkdir(dir, { recursive: true });
      const target = await reservePath(path.join(dir, `${name}.${r.ext}`), preset.conflict, reserved);
      if (!target) { results.push({ input: file.path, skipped: true, size: size?.label }); continue; }
      await fsp.writeFile(target, r.buffer);
      if (preset.preserveDates) await fsp.utimes(target, new Date(), new Date(file.mtime)).catch(() => {});
      results.push({ input: file.path, output: target, bytes: r.buffer.length, width: r.width, height: r.height, quality: r.quality, size: size?.label, warnings: r.warnings });
    }
  }
  return results;
}

// Renders a single variant in memory for the preview pane.
async function preview(filePath, preset, { sizeIndex = 0, page = 0 } = {}) {
  const sizes = activeSizes(preset);
  const size = preset.fit === 'none' || !sizes.length ? null : sizes[Math.min(sizeIndex, sizes.length - 1)];
  const [src] = await loadSources(filePath, preset, { previewPage: page });
  const r = await renderVariant(src, size, preset);
  // Chromium cannot display TIFF; show a PNG stand-in but report the real file size.
  let display = r.buffer, displayType = `image/${r.format === 'jpeg' ? 'jpeg' : r.format}`;
  if (r.format === 'tiff') { display = await sharp(r.buffer).png().toBuffer(); displayType = 'image/png'; }
  if (r.format === 'ico') displayType = 'image/x-icon';
  const base = path.parse(filePath);
  const name = buildName(preset.renamePattern, { name: base.name, srcExt: base.ext.slice(1), folder: path.basename(base.dir), preset: preset.name, index: preset.renameStart ?? 1, size, width: r.width, height: r.height, page: src.page, pageCount: src.pageCount, format: r.ext }, preset.rename);
  return { data: display, type: displayType, bytes: r.buffer.length, width: r.width, height: r.height, format: r.format, quality: r.quality, animated: r.animated, warnings: r.warnings, fileName: `${name}.${r.ext}`, pageCount: src.pageCount, sizeLabel: size?.label || 'Original size' };
}

// Small thumbnail plus basic metadata for the file grid.
async function thumbnail(filePath, max = 320) {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  if (ext === 'pdf') {
    const { mupdf, doc } = await openPdf(filePath);
    try {
      const page = doc.loadPage(0);
      const [x0, y0, x1, y1] = page.getBounds();
      page.destroy();
      const w = x1 - x0, h = y1 - y0;
      const png = renderPdfPage(mupdf, doc, 0, Math.min(4, max / Math.max(w, h)), false);
      const data = await sharp(png).webp({ quality: 75 }).toBuffer();
      return { data, type: 'image/webp', width: Math.round(w), height: Math.round(h), pages: doc.countPages(), format: 'pdf' };
    } finally { doc.destroy(); }
  }
  const img = sharp(filePath, { density: ext === 'svg' ? 144 : undefined, failOn: 'none', limitInputPixels: false });
  const meta = await img.metadata();
  const data = await img.autoOrient().resize(max, max, { fit: 'inside', withoutEnlargement: true }).webp({ quality: 75 }).toBuffer();
  return { data, type: 'image/webp', width: meta.autoOrient?.width || meta.width, height: meta.autoOrient?.height || meta.pageHeight || meta.height, pages: meta.pages || 1, format: meta.format, animated: (meta.pages || 1) > 1 && ext !== 'tif' && ext !== 'tiff' };
}

// Downscaled original for the "before" side of the preview.
async function original(filePath, page = 0, max = 2000) {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  if (ext === 'pdf') {
    const { mupdf, doc } = await openPdf(filePath);
    try {
      const p = doc.loadPage(Math.min(page, doc.countPages() - 1));
      const [x0, y0, x1, y1] = p.getBounds();
      p.destroy();
      const png = renderPdfPage(mupdf, doc, Math.min(page, doc.countPages() - 1), Math.min(6, max / Math.max(x1 - x0, y1 - y0)), false);
      return { data: png, type: 'image/png' };
    } finally { doc.destroy(); }
  }
  if (['gif', 'webp'].includes(ext)) {
    const meta = await sharp(filePath).metadata();
    if ((meta.pages || 1) > 1) return { data: await fsp.readFile(filePath), type: `image/${ext}` };
  }
  const data = await sharp(filePath, { density: ext === 'svg' ? 144 : undefined, failOn: 'none', limitInputPixels: false })
    .autoOrient().resize(max, max, { fit: 'inside', withoutEnlargement: true }).png({ compressionLevel: 3 }).toBuffer();
  return { data, type: 'image/png' };
}

// ---------- combining: contact sheets & PDF documents ----------

const zlib = require('zlib');
const MM = 72 / 25.4;
const PAGE = { a3: [841.89, 1190.55], a4: [595.28, 841.89], a5: [419.53, 595.28], letter: [612, 792], legal: [612, 1008], tabloid: [792, 1224] };
const PAGE_LABEL = { a3: 'A3', a4: 'A4', a5: 'A5', letter: 'Letter', legal: 'Legal', tabloid: 'Tabloid', image: 'Fit to image' };
const clampInt = (v, lo, hi, d) => { const n = Math.round(Number(v)); return Number.isFinite(n) && n > 0 ? Math.min(hi, Math.max(lo, n)) : d; };
const isCombine = preset => preset.mode === 'sheet' || preset.mode === 'pdf';

function groupFiles(files, by) {
  if (by !== 'folder') return [{ name: path.basename(path.dirname(files[0].path)), files }];
  const groups = new Map();
  for (const f of files) {
    const dir = path.dirname(f.path);
    if (!groups.has(dir)) groups.set(dir, []);
    groups.get(dir).push(f);
  }
  return [...groups].map(([dir, list]) => ({ name: path.basename(dir), files: list }));
}

// Loads every page/frame of the given files, rasterising vectors to roughly `target` px.
async function collectItems(files, preset, targetW, targetH, onError = () => {}) {
  const loadPreset = { ...preset, fit: 'contain', sizes: [{ width: targetW, height: targetH }], keepAnimation: false, format: 'png' };
  const items = [];
  for (const f of files) {
    try {
      for (const src of await loadSources(f.path, loadPreset)) {
        items.push({ file: f, src, caption: src.pageCount > 1 ? `${f.name} — p${src.page}` : f.name });
      }
    } catch (err) { onError(f, err); }
  }
  return items;
}

function cellPipeline(src, preset) {
  const img = sharp(src.input, { ...src.opts, animated: false, failOn: 'none', limitInputPixels: false });
  return applyTone(applyGeometry(img, preset), preset);
}

function captionSvg(text, w, h, size, hex, { weight = 400, anchor = 'middle' } = {}) {
  const max = Math.max(1, Math.floor((w - 4) / (size * 0.56)));
  const t = text.length > max ? `${text.slice(0, max - 1)}…` : text;
  const c = parseColor(hex);
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><text x="${anchor === 'middle' ? w / 2 : 0}" y="${h / 2}"
    dominant-baseline="middle" text-anchor="${anchor}" font-family="Segoe UI, Helvetica, Arial, sans-serif" font-size="${size}" font-weight="${weight}"
    fill="rgb(${c.r},${c.g},${c.b})">${escapeXml(t)}</text></svg>`);
}

function sheetLayout(s, count) {
  const cols = clampInt(s.columns, 1, 50, 4);
  const cellW = clampInt(s.cellWidth, 16, 4000, 400);
  const cellH = clampInt(s.cellHeight, 16, 4000, Math.round(cellW * 0.75));
  const gap = Math.max(0, Math.round(s.gap ?? 16));
  const margin = Math.max(0, Math.round(s.margin ?? 32));
  const capSize = clampInt(s.captionSize, 6, 200, 14);
  const capH = s.captions ? Math.ceil(capSize * 1.9) : 0;
  const titleSize = Math.round(capSize * 1.7);
  const headH = s.title ? Math.ceil(titleSize * 2.2) : 0;
  const rowH = cellH + capH + gap;
  // Keep sheets under 16000px tall: WebP and many viewers cannot open anything larger.
  const maxRows = Math.max(1, Math.floor((16000 - 2 * margin - headH + gap) / rowH));
  let rows = s.rows > 0 ? Math.round(s.rows) : Math.max(1, Math.ceil(count / cols));
  const capped = rows > maxRows;
  rows = Math.min(rows, maxRows);
  return { cols, rows, cellW, cellH, gap, margin, capSize, capH, titleSize, headH, capped,
    W: 2 * margin + cols * cellW + (cols - 1) * gap, H: 2 * margin + headH + rows * rowH - gap };
}

// A sheet that is not full (e.g. the last one) drops its empty rows.
function shrinkToFit(s, L, count) {
  const rows = Math.min(L.rows, Math.max(1, Math.ceil(count / L.cols)));
  return rows === L.rows ? L : sheetLayout({ ...s, rows }, count);
}

async function buildSheet(items, L, preset, sheetNo, sheetCount, onError = () => {}) {
  const s = preset.sheet || {};
  const layers = [];
  if (s.title) {
    const title = sheetCount > 1 ? `${s.title}  (${sheetNo}/${sheetCount})` : s.title;
    layers.push({ input: captionSvg(title, L.W - 2 * L.margin, L.headH, L.titleSize, s.captionColor, { weight: 600, anchor: 'start' }), left: L.margin, top: L.margin });
  }
  for (const [k, item] of items.entries()) {
    const x = L.margin + (k % L.cols) * (L.cellW + L.gap);
    const y = L.margin + L.headH + Math.floor(k / L.cols) * (L.cellH + L.capH + L.gap);
    try {
      const { data, info } = await cellPipeline(item.src, preset)
        .resize({ width: L.cellW, height: L.cellH, fit: s.fit === 'cover' ? 'cover' : 'inside', position: preset.position || 'centre' })
        .png().toBuffer({ resolveWithObject: true });
      layers.push({ input: data, left: x + Math.floor((L.cellW - info.width) / 2), top: y + Math.floor((L.cellH - info.height) / 2) });
    } catch (err) { onError(item.file, err); continue; }
    if (s.captions) layers.push({ input: captionSvg(item.caption, L.cellW, L.capH, L.capSize, s.captionColor), left: x, top: y + L.cellH });
  }
  const bg = parseColor(s.background || '#ffffff');
  return sharp({ create: { width: L.W, height: L.H, channels: 3, background: { r: bg.r, g: bg.g, b: bg.b } } }).composite(layers);
}

// Minimal PDF writer: JPEG (DCT) or Flate images plus Helvetica text.
class PdfBuilder {
  constructor() {
    this.objs = [];
    this.pages = [];
    this.catalog = this.alloc();
    this.pagesId = this.alloc();
    this.font = this.add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  }
  alloc() { this.objs.push(null); return this.objs.length; }
  set(id, dict, stream) {
    this.objs[id - 1] = stream ? Buffer.concat([Buffer.from(`${dict}\nstream\n`, 'latin1'), stream, Buffer.from('\nendstream', 'latin1')]) : Buffer.from(dict, 'latin1');
  }
  add(dict, stream) { const id = this.alloc(); this.set(id, dict, stream); return id; }
  image(im) {
    return this.add(`<< /Type /XObject /Subtype /Image /Width ${im.width} /Height ${im.height} /ColorSpace /${im.channels === 1 ? 'DeviceGray' : 'DeviceRGB'} /BitsPerComponent 8 /Filter /${im.filter} /Length ${im.data.length} >>`, im.data);
  }
  page(w, h, content, images) {
    const c = zlib.deflateSync(Buffer.from(content, 'latin1'));
    const cid = this.add(`<< /Length ${c.length} /Filter /FlateDecode >>`, c);
    const xo = Object.entries(images).map(([n, id]) => `/${n} ${id} 0 R`).join(' ');
    this.pages.push(this.add(`<< /Type /Page /Parent ${this.pagesId} 0 R /MediaBox [0 0 ${num(w)} ${num(h)}] /Resources << /Font << /F1 ${this.font} 0 R >> /XObject << ${xo} >> >> /Contents ${cid} 0 R >>`));
  }
  toBuffer(title) {
    this.set(this.catalog, `<< /Type /Catalog /Pages ${this.pagesId} 0 R >>`);
    this.set(this.pagesId, `<< /Type /Pages /Kids [${this.pages.map(p => `${p} 0 R`).join(' ')}] /Count ${this.pages.length} >>`);
    const d = new Date();
    const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1, 2)}${pad(d.getDate(), 2)}${pad(d.getHours(), 2)}${pad(d.getMinutes(), 2)}${pad(d.getSeconds(), 2)}`;
    const info = this.add(`<< /Producer (PixelBatch) /Title (${pdfStr(title || '')}) /CreationDate (D:${stamp}) >>`);
    const chunks = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
    let offset = chunks[0].length;
    const offsets = [];
    this.objs.forEach((o, i) => {
      offsets.push(offset);
      const head = Buffer.from(`${i + 1} 0 obj\n`, 'latin1'), tail = Buffer.from('\nendobj\n', 'latin1');
      chunks.push(head, o, tail);
      offset += head.length + o.length + tail.length;
    });
    const xref = `xref\n0 ${this.objs.length + 1}\n0000000000 65535 f \n${offsets.map(o => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
    chunks.push(Buffer.from(`${xref}trailer\n<< /Size ${this.objs.length + 1} /Root ${this.catalog} 0 R /Info ${info} 0 R >>\nstartxref\n${offset}\n%%EOF\n`, 'latin1'));
    return Buffer.concat(chunks);
  }
}

const num = n => String(Math.round(n * 100) / 100);
// WinAnsi code points for common typographic characters outside Latin-1.
const WIN_ANSI = { '€': '\x80', '…': '\x85', '‘': '\x91', '’': '\x92', '“': '\x93', '”': '\x94', '•': '\x95', '–': '\x96', '—': '\x97', '™': '\x99' };
const pdfStr = s => String(s).replace(/[\\()]/g, '\\$&').replace(/[€…‘’“”•–—™]/g, c => WIN_ANSI[c]).replace(/[^\x20-\xff\x80-\x9f]/g, '?');

function pdfText(str, x, y, size, maxW, align, hex) {
  const max = Math.max(1, Math.floor(maxW / (size * 0.52)));
  const s = str.length > max ? `${str.slice(0, max - 1)}…` : str;
  const w = s.length * size * 0.52;
  const left = align === 'center' ? x - w / 2 : align === 'right' ? x - w : x;
  const c = parseColor(hex || '#333333');
  return `BT /F1 ${num(size)} Tf ${num(c.r / 255)} ${num(c.g / 255)} ${num(c.b / 255)} rg ${num(left)} ${num(y)} Td (${pdfStr(s)}) Tj ET\n`;
}

// Rasterises one item for embedding, downsampled to the PDF's maximum DPI for the box it fills.
async function pdfImage(src, boxW, boxH, preset, fit) {
  const o = preset.pdf || {};
  const dpi = clampInt(o.maxDpi, 72, 600, 200);
  const maxW = Math.max(1, Math.round(boxW / 72 * dpi)), maxH = Math.max(1, Math.round(boxH / 72 * dpi));
  const img = cellPipeline(src, preset)
    .resize({ width: maxW, height: maxH, fit: fit === 'cover' ? 'cover' : 'inside', position: preset.position || 'centre', withoutEnlargement: fit !== 'cover' })
    .flatten({ background: '#ffffff' });
  if (o.lossless) {
    const { data, info } = await img.raw().toBuffer({ resolveWithObject: true });
    return { width: info.width, height: info.height, channels: info.channels, filter: 'FlateDecode', data: zlib.deflateSync(data) };
  }
  const { data, info } = await img.jpeg({ quality: clampInt(o.quality, 1, 100, 85), mozjpeg: true }).toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, channels: info.channels, filter: 'DCTDecode', data };
}

const fitBox = (w, h, bw, bh) => { const r = Math.min(bw / w, bh / h); return [w * r, h * r]; };

async function buildPdf(items, preset, { maxPages = Infinity, title = '', onItem = () => {}, onError = () => {}, isCancelled = () => false } = {}) {
  const o = preset.pdf || {};
  const pdf = new PdfBuilder();
  const margin = Math.max(0, o.marginMm ?? 10) * MM;
  const dpi = clampInt(o.maxDpi, 72, 600, 200);
  const color = o.captionColor || '#333333';
  const pageFor = landscape => { const [w, h] = PAGE[o.pageSize] || PAGE.a4; return landscape ? [h, w] : [w, h]; };
  const headH = o.title ? 26 : 0, footH = o.pageNumbers ? 20 : 0;
  const decorate = (pw, ph, pageNo, pageCount) => {
    let c = '';
    if (o.title) c += pdfText(o.title, margin, ph - margin - 14, 13, pw - 2 * margin, 'left', color);
    if (o.pageNumbers) c += pdfText(`${pageNo} / ${pageCount}`, pw / 2, margin - 2 > 6 ? Math.max(8, margin / 2) : 8, 9, pw, 'center', '#777777');
    return c;
  };

  if (o.layout === 'grid') {
    const cols = clampInt(o.columns, 1, 12, 3), rows = clampInt(o.rows, 1, 20, 4);
    const per = cols * rows, pageCount = Math.ceil(items.length / per);
    const [pw, ph] = pageFor(o.orientation === 'landscape');
    const gap = Math.max(0, o.gapMm ?? 5) * MM;
    const capSize = 8, capH = o.captions ? 14 : 0;
    const cellW = (pw - 2 * margin - (cols - 1) * gap) / cols;
    const cellH = (ph - 2 * margin - headH - footH - (rows - 1) * gap) / rows - capH;
    if (cellW < 10 || cellH < 10) throw new Error('Too many columns/rows for this page size and margin.');
    for (let p = 0; p < Math.min(pageCount, maxPages) && !isCancelled(); p++) {
      let content = decorate(pw, ph, p + 1, pageCount);
      const images = {};
      for (const [k, item] of items.slice(p * per, (p + 1) * per).entries()) {
        const x = margin + (k % cols) * (cellW + gap);
        const top = margin + headH + Math.floor(k / cols) * (cellH + capH + gap);
        try {
          const im = await pdfImage(item.src, cellW, cellH, preset, o.fit);
          const [dw, dh] = fitBox(im.width, im.height, cellW, cellH);
          images[`Im${k}`] = pdf.image(im);
          content += `q ${num(dw)} 0 0 ${num(dh)} ${num(x + (cellW - dw) / 2)} ${num(ph - top - (cellH + dh) / 2)} cm /Im${k} Do Q\n`;
          if (o.captions) content += pdfText(item.caption, x + cellW / 2, ph - top - cellH - capH + 4, capSize, cellW, 'center', color);
        } catch (err) { onError(item.file, err); }
        onItem(item);
      }
      pdf.page(pw, ph, content, images);
    }
    return { buffer: pdf.toBuffer(title), pages: pdf.pages.length, pageCount, pageW: pw, pageH: ph };
  }

  const pageCount = items.length;
  let pw = 0, ph = 0;
  for (const [i, item] of items.slice(0, maxPages).entries()) {
    if (isCancelled()) break;
    try {
      const meta = await cellPipeline(item.src, preset).toBuffer({ resolveWithObject: true }).then(r => r.info);
      const landscape = o.orientation === 'landscape' || (o.orientation !== 'portrait' && meta.width > meta.height);
      const capH = o.captions ? 18 : 0;
      if (o.pageSize === 'image') {
        const w = meta.width * 72 / dpi, h = meta.height * 72 / dpi;
        [pw, ph] = [w + 2 * margin, h + 2 * margin + headH + footH + capH];
      } else [pw, ph] = pageFor(landscape);
      const boxW = pw - 2 * margin, boxH = ph - 2 * margin - headH - footH - capH;
      const im = await pdfImage(item.src, boxW, boxH, preset, o.fit);
      const [dw, dh] = fitBox(im.width, im.height, boxW, boxH);
      const top = margin + headH + (boxH - dh) / 2;
      let content = decorate(pw, ph, i + 1, pageCount);
      content += `q ${num(dw)} 0 0 ${num(dh)} ${num(margin + (boxW - dw) / 2)} ${num(ph - top - dh)} cm /Im0 Do Q\n`;
      if (o.captions) content += pdfText(item.caption, pw / 2, ph - top - dh - 13, 9, boxW, 'center', color);
      pdf.page(pw, ph, content, { Im0: pdf.image(im) });
    } catch (err) { onError(item.file, err); }
    onItem(item);
  }
  return { buffer: pdf.toBuffer(title), pages: pdf.pages.length, pageCount, pageW: pw, pageH: ph };
}

function combineTarget(preset) {
  if (preset.mode === 'sheet') {
    const L = sheetLayout(preset.sheet || {}, 1);
    return [L.cellW, L.cellH];
  }
  const o = preset.pdf || {};
  const dpi = clampInt(o.maxDpi, 72, 600, 200);
  const [w, h] = PAGE[o.pageSize] || PAGE.a4;
  const long = Math.ceil(Math.max(w, h) / 72 * dpi);
  return [long, long];
}

function combineName(preset, group, index, page, pageCount, ext) {
  const name = buildName(preset.combineName || '{folder}{page}', { name: group.name, folder: group.name, preset: preset.name, index, page, pageCount, format: ext }, preset.rename);
  return `${name}.${ext}`;
}

// Combines files into contact sheets or PDF documents (one per group).
async function processCombine(files, preset, onFile = () => {}, isCancelled = () => false) {
  const results = [], warnings = [], failed = new Map();
  const reserved = new Set();
  const onError = (f, err) => { if (!failed.has(f.path)) failed.set(f.path, err.message); };
  let index = Number(preset.renameStart ?? 1);
  await fsp.mkdir(preset.outputDir, { recursive: true });
  const [tw, th] = combineTarget(preset);

  for (const group of groupFiles(files, preset.groupBy)) {
    if (isCancelled()) break;
    const items = await collectItems(group.files, preset, tw, th, onError);
    const remaining = new Map();
    for (const it of items) remaining.set(it.file.path, (remaining.get(it.file.path) || 0) + 1);
    for (const f of group.files) if (!remaining.has(f.path)) onFile(f, 'error', failed.get(f.path) || 'Could not read file');
    const placed = item => {
      const left = remaining.get(item.file.path) - 1;
      remaining.set(item.file.path, left);
      if (left === 0) onFile(item.file, failed.has(item.file.path) ? 'error' : 'done', failed.get(item.file.path));
    };
    if (!items.length) continue;

    const write = async (fileName, buffer, extra) => {
      const target = await reservePath(path.join(preset.outputDir, fileName), preset.conflict, reserved);
      if (!target) return results.push({ skipped: true });
      await fsp.writeFile(target, buffer);
      results.push({ output: target, bytes: buffer.length, ...extra });
    };

    if (preset.mode === 'sheet') {
      const L = sheetLayout(preset.sheet || {}, items.length);
      if (L.capped && !(preset.sheet?.rows > 0)) warnings.push(`${group.name}: split into several sheets to stay under 16000 px tall.`);
      const per = L.cols * L.rows, sheetCount = Math.ceil(items.length / per);
      const fmt = resolveFormat(preset, 'jpg');
      for (let s = 0; s < sheetCount && !isCancelled(); s++) {
        const chunk = items.slice(s * per, (s + 1) * per);
        const sheetL = shrinkToFit(preset.sheet || {}, L, chunk.length);
        const r = await encode(await buildSheet(chunk, sheetL, preset, s + 1, sheetCount, onError), fmt, preset);
        warnings.push(...r.warnings.map(w => `${group.name}: ${w}`));
        await write(combineName(preset, group, index++, s + 1, sheetCount, EXT[fmt]), r.buffer, { width: r.width, height: r.height });
        chunk.forEach(placed);
      }
    } else {
      const r = await buildPdf(items, preset, { title: preset.pdf?.title || group.name, onItem: placed, onError, isCancelled });
      if (r.pages) await write(combineName(preset, group, index++, 1, 1, 'pdf'), r.buffer, { pages: r.pages });
    }
  }
  return { results, warnings, failed };
}

// Renders the sheet / PDF page that contains the selected file.
async function previewCombine(files, preset, selected = 0) {
  if (!files.length) throw new Error('No files');
  selected = Math.min(Math.max(0, selected), files.length - 1);
  const [tw, th] = combineTarget(preset);
  const group = { name: path.basename(path.dirname(files[preset.groupBy === 'folder' ? selected : 0].path)) };
  const warnings = [];
  const onError = (f, err) => warnings.push(`${f.name}: ${err.message}`);

  if (preset.mode === 'sheet') {
    const s = preset.sheet || {};
    const cols = clampInt(s.columns, 1, 50, 4);
    const per = s.rows > 0 ? cols * Math.round(s.rows) : Math.min(files.length, sheetLayout(s, files.length).rows * cols);
    const start = Math.floor(selected / per) * per;
    const items = (await collectItems(files.slice(start, start + per), preset, tw, th, onError)).slice(0, per);
    const L = shrinkToFit(s, sheetLayout(s, s.rows > 0 ? per : items.length), items.length);
    const count = Math.ceil(files.length / per);
    const fmt = resolveFormat(preset, 'jpg');
    const r = await encode(await buildSheet(items, L, preset, start / per + 1, count, onError), fmt, preset);
    let data = r.buffer, type = `image/${fmt}`;
    if (fmt === 'tiff') { data = await sharp(r.buffer).png().toBuffer(); type = 'image/png'; }
    else if (fmt === 'bmp' || fmt === 'ico') { data = await encodePng(r, fmt); type = 'image/png'; }
    return { data, type, bytes: r.buffer.length, width: r.width, height: r.height, format: fmt, quality: r.quality, warnings: [...warnings, ...r.warnings],
      fileName: combineName(preset, group, Number(preset.renameStart ?? 1), start / per + 1, count, EXT[fmt]), note: `Sheet ${start / per + 1} of ${count}`, pageCount: 1 };
  }

  const o = preset.pdf || {};
  const per = o.layout === 'grid' ? clampInt(o.columns, 1, 12, 3) * clampInt(o.rows, 1, 20, 4) : 1;
  const start = Math.floor(selected / per) * per;
  const items = await collectItems(files.slice(start, start + per), preset, tw, th, onError);
  const r = await buildPdf(items, preset, { maxPages: 1, title: o.title || group.name, onError });
  if (!r.pages) throw new Error(warnings[0] || 'Nothing to render');
  const mupdf = await getMupdf();
  const doc = mupdf.Document.openDocument(r.buffer, 'application/pdf');
  let data;
  try { data = renderPdfPage(mupdf, doc, 0, Math.min(3, 1800 / Math.max(r.pageW, r.pageH)), false); } finally { doc.destroy(); }
  const count = Math.ceil(files.length / per);
  return { data, type: 'image/png', bytes: r.buffer.length, width: Math.round(r.pageW), height: Math.round(r.pageH), format: 'pdf', warnings,
    dims: `${PAGE_LABEL[o.pageSize] || 'A4'} · ${Math.round(r.pageW / MM)} × ${Math.round(r.pageH / MM)} mm`,
    fileName: combineName(preset, group, Number(preset.renameStart ?? 1), 1, 1, 'pdf'), note: `Page ${start / per + 1} of ${count} · size shown is for this page`, pageCount: 1 };
}

// BMP/ICO buffers are not decodable by sharp, so re-encode the sheet as PNG for display.
async function encodePng(r, fmt) {
  if (fmt === 'bmp') {
    const w = r.width, h = r.height, raw = Buffer.alloc(w * h * 4), off = 122;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const s = off + ((h - 1 - y) * w + x) * 4, d = (y * w + x) * 4;
      raw[d] = r.buffer[s + 2]; raw[d + 1] = r.buffer[s + 1]; raw[d + 2] = r.buffer[s]; raw[d + 3] = r.buffer[s + 3];
    }
    return sharp(raw, { raw: { width: w, height: h, channels: 4 } }).png().toBuffer();
  }
  const count = r.buffer.readUInt16LE(4), last = 6 + (count - 1) * 16;
  return r.buffer.subarray(r.buffer.readUInt32LE(last + 12), r.buffer.readUInt32LE(last + 12) + r.buffer.readUInt32LE(last + 8));
}

module.exports = { isCombine, processCombine, previewCombine, INPUT_EXT, scanPaths, processFile, preview, thumbnail, original, buildName, parsePageSpec, predictSize, activeSizes };

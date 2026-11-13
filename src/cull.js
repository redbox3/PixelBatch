// "Pick best shots": groups similar photos (taken close together and looking alike) and
// scores each one for sharpness and exposure so the best of every group can be kept.
const sharp = require('sharp');
const exifr = require('exifr');
const { imageInput } = require('./processor');

const ANALYSE_PX = 1024;
const GRID = 6;

// Capture time in ms (with sub-seconds, so burst frames keep their order), or null.
async function captureTime(file) {
  try {
    const e = await exifr.parse(file, { pick: ['DateTimeOriginal', 'CreateDate', 'SubSecTimeOriginal'], reviveValues: true });
    const d = e?.DateTimeOriginal || e?.CreateDate;
    if (!(d instanceof Date)) return null;
    const sub = e.SubSecTimeOriginal ? Number(`0.${String(e.SubSecTimeOriginal).trim()}`) * 1000 : 0;
    return d.getTime() + (Number.isFinite(sub) ? sub : 0);
  } catch { return null; }
}

// 64-bit difference hash: each bit says whether a pixel is brighter than its right-hand neighbour.
async function dHash(input) {
  const px = await sharp(input).autoOrient().grayscale().resize(9, 8, { fit: 'fill' }).raw().toBuffer();
  let hash = 0n;
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) hash = (hash << 1n) | (px[y * 9 + x] > px[y * 9 + x + 1] ? 1n : 0n);
  return hash;
}

const hamming = (a, b) => { let x = a ^ b, n = 0; while (x) { x &= x - 1n; n++; } return n; };

// Sharpness = variance of the Laplacian in the sharpest tiles (where the subject is), so a
// shallow-focus portrait is not marked down for its blurred background.
function sharpnessOf(gray, w, h) {
  const tiles = [];
  const tw = Math.floor(w / GRID), th = Math.floor(h / GRID);
  for (let ty = 0; ty < GRID; ty++) for (let tx = 0; tx < GRID; tx++) {
    let sum = 0, sum2 = 0, n = 0;
    for (let y = Math.max(1, ty * th); y < Math.min(h - 1, (ty + 1) * th); y += 1) {
      const row = y * w;
      for (let x = Math.max(1, tx * tw); x < Math.min(w - 1, (tx + 1) * tw); x += 1) {
        const i = row + x;
        const lap = gray[i - 1] + gray[i + 1] + gray[i - w] + gray[i + w] - 4 * gray[i];
        sum += lap; sum2 += lap * lap; n++;
      }
    }
    if (n) tiles.push(sum2 / n - (sum / n) ** 2);
  }
  tiles.sort((a, b) => b - a);
  const top = tiles.slice(0, 3);
  return top.reduce((a, b) => a + b, 0) / top.length;
}

// 0..1: penalises blown highlights, crushed shadows and very dark or bright frames.
function exposureOf(gray) {
  let hi = 0, lo = 0, sum = 0;
  for (const v of gray) { if (v >= 250) hi++; else if (v <= 5) lo++; sum += v; }
  const n = gray.length, mean = sum / n / 255;
  const score = 1 - Math.min(1, (hi / n) * 6) * 0.6 - Math.min(1, (lo / n) * 3) * 0.25 - Math.max(0, Math.abs(mean - 0.45) - 0.2) * 0.8;
  return { exposure: Math.max(0, Math.min(1, score)), highlights: hi / n, shadows: lo / n, brightness: mean };
}

async function analyseOne(file) {
  const input = await imageInput(file.path);
  const { data, info } = await sharp(input, { failOn: 'none', limitInputPixels: false })
    .autoOrient().resize(ANALYSE_PX, ANALYSE_PX, { fit: 'inside', withoutEnlargement: true })
    .grayscale().raw().toBuffer({ resolveWithObject: true });
  const [hash, time, thumb] = await Promise.all([
    dHash(input),
    captureTime(file.path),
    sharp(input, { failOn: 'none' }).autoOrient().resize(320, 320, { fit: 'inside' }).webp({ quality: 70 }).toBuffer(),
  ]);
  return { path: file.path, name: file.name, hash, time, thumb, sharpness: sharpnessOf(data, info.width, info.height), ...exposureOf(data) };
}

// Strictness → how many of the 64 fingerprint bits may differ between neighbouring shots.
const THRESHOLD = { strict: 6, normal: 12, loose: 18 };

function group(items, { similarity = 'normal', maxGapSeconds = 60 } = {}) {
  const limit = THRESHOLD[similarity] ?? THRESHOLD.normal;
  const sorted = [...items].sort((a, b) => (a.time ?? Infinity) - (b.time ?? Infinity) || a.name.localeCompare(b.name, undefined, { numeric: true }));
  const groups = [];
  let current = null;
  for (const it of sorted) {
    const prev = current?.at(-1);
    const gapOk = !prev || prev.time == null || it.time == null || maxGapSeconds <= 0 || Math.abs(it.time - prev.time) <= maxGapSeconds * 1000;
    // Compare with the previous shot and the group's first, so a slow pan does not chain unrelated scenes together.
    if (prev && gapOk && hamming(it.hash, prev.hash) <= limit && hamming(it.hash, current[0].hash) <= limit * 1.6) current.push(it);
    else groups.push(current = [it]);
  }
  return groups;
}

// Scores each shot against its group (sharpness relative to the group's sharpest) and picks the best `keep`.
function pick(groups, { keep = 1 } = {}) {
  const all = groups.flat().map(i => i.sharpness).sort((a, b) => a - b);
  const median = all[Math.floor(all.length / 2)] || 1;
  return groups.map((g, gi) => {
    const best = Math.max(...g.map(i => i.sharpness)) || 1;
    const scored = g.map(i => ({ ...i, score: Math.round(100 * (0.7 * (i.sharpness / best) + 0.3 * i.exposure)), blurry: i.sharpness < median * 0.25 }));
    const ranked = [...scored].sort((a, b) => b.score - a.score);
    const picks = new Set(ranked.slice(0, Math.max(1, keep)).map(i => i.path));
    return { id: gi + 1, items: scored.map(i => ({ ...i, pick: picks.has(i.path), rank: ranked.indexOf(i) + 1 })) };
  });
}

async function analyse(files, onProgress = () => {}, isCancelled = () => false, concurrency = 3) {
  const results = [], errors = [];
  let next = 0, done = 0;
  const worker = async () => {
    while (!isCancelled() && next < files.length) {
      const f = files[next++];
      try { results.push(await analyseOne(f)); }
      catch (err) { errors.push({ path: f.path, name: f.name, error: err.message }); }
      onProgress(++done, files.length, f.name);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  return { items: results, errors };
}

// The renderer receives plain data: hashes as strings, thumbnails as bytes.
const forRenderer = groups => groups.map(g => ({ ...g, items: g.items.map(({ hash, ...i }) => i) }));

module.exports = { analyse, group, pick, forRenderer, hamming };

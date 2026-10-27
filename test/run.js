const P = require('../src/processor');
const path = require('path');
const out = path.resolve(__dirname, 'out');
const base = { name: 'T', fit: 'contain', sizes: [{ label: 'Large', width: 1200, height: 1200, suffix: '_L' }, { label: 'Thumb', width: 200, height: null, suffix: '_T' }],
  format: 'webp', quality: 80, keepAnimation: true, renamePattern: '{n:3}_{name}{suffix}_{w}x{h}{page}', renameStart: 1, rename: { spaces: 'dash', case: 'lower' },
  outputDir: out, conflict: 'increment', keepStructure: true, subfolderPerSize: true, pdfPages: 'all',
  watermark: { enabled: true, type: 'text', text: '© ProAVL', position: 'br', opacity: 60, scale: 4 } };
const variants = [
  { ...base, name: 'webp', outputDir: out + '/webp' },
  { ...base, name: 'jpg-target', format: 'jpeg', targetEnabled: true, targetKB: 30, outputDir: out + '/jpg', subfolderPerSize: false },
  { ...base, name: 'gif', format: 'gif', outputDir: out + '/gif', watermark: {} },
  { ...base, name: 'pad', fit: 'pad', format: 'png', sizes: [{ label: 'Sq', width: 500, height: 500, suffix: '' }], background: '#00ff00', outputDir: out + '/pad' },
  { ...base, name: 'cover', fit: 'cover', position: 'attention', format: 'avif', sizes: [{ label: 'Wide', width: 800, height: 300, suffix: '' }], outputDir: out + '/avif' },
  { ...base, name: 'bmp', format: 'bmp', outputDir: out + '/bmp', watermark: {} },
  { ...base, name: 'ico', format: 'ico', outputDir: out + '/ico', sizes: [{ label: 'i', width: 256, height: 256 }] , watermark: {} },
  { ...base, name: 'tiff', format: 'tiff', fit: 'none', outputDir: out + '/tiff', watermark: {}, rotate: 90, grayscale: true },
  { ...base, name: 'rename', mode: 'rename', renamePattern: 'Event {date} {n:4}', outputDir: out + '/rename' },
];
(async () => {
  const files = await P.scanPaths([path.resolve(__dirname, 'in')], true);
  console.log(files.map(f => f.name + ' ' + f.bytes).join(' | '));
  for (const v of variants) {
    const reserved = new Set();
    for (const [i, f] of files.entries()) {
      try {
        const rs = await P.processFile(f, v, i + 1, reserved);
        for (const r of rs) console.log(v.name.padEnd(10), path.relative(out, r.output || ''), r.width + 'x' + r.height, Math.round(r.bytes / 1024) + 'KB', r.quality ?? '', (r.warnings || []).join(';'));
      } catch (e) { console.log(v.name, f.name, 'ERROR', e.message); }
    }
  }
  const pv = await P.preview(files[0].path, variants[1]);
  console.log('preview', pv.fileName, pv.bytes, pv.width, pv.height, pv.type);
  for (const f of files) { const t = await P.thumbnail(f.path); console.log('thumb', f.name, t.width, t.height, t.pages, t.data.length); }
  console.log(P.parsePageSpec('1-3, 5, 9-end', 10));
})();

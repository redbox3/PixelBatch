const P = require('../src/processor');
const D = require('../src/defaultPresets');
const path = require('path');
const out = path.resolve(__dirname, 'out', 'combine');
(async () => {
  const files = await P.scanPaths([path.resolve(__dirname, 'in')], true);
  const sheet = D.withDefaults({ ...D.find(p => p.mode === 'sheet'), outputDir: out, groupBy: 'all' });
  sheet.sheet = { ...sheet.sheet, columns: 3, rows: 2, cellWidth: 300, cellHeight: 220 };
  const pdf1 = D.withDefaults({ ...D.find(p => p.mode === 'pdf'), outputDir: out, combineName: 'single' });
  pdf1.pdf = { ...pdf1.pdf, captions: true, pageNumbers: true, title: 'Single layout' };
  const pdf2 = D.withDefaults({ ...pdf1, combineName: 'grid' });
  pdf2.pdf = { ...pdf2.pdf, layout: 'grid', columns: 2, rows: 3, captions: true, title: 'Grid layout', fit: 'cover' };
  const pdf3 = D.withDefaults({ ...pdf1, combineName: 'fit-image', groupBy: 'folder' });
  pdf3.pdf = { ...pdf3.pdf, pageSize: 'image', lossless: true, captions: false, title: '', pageNumbers: false };
  for (const p of [sheet, pdf1, pdf2, pdf3]) {
    const r = await P.processCombine(files, p, (f, st, e) => st !== 'done' && console.log('  file', f.name, st, e));
    console.log(p.mode, JSON.stringify(r.results.map(x => [path.basename(x.output), x.bytes, x.width || x.pages])), r.warnings);
  }
  const pv = await P.previewCombine(files, sheet, 4);
  console.log('preview sheet', pv.note, pv.fileName, pv.width, pv.height, pv.bytes);
  const pv2 = await P.previewCombine(files, pdf2, 0);
  console.log('preview pdf', pv2.note, pv2.dims, pv2.fileName, pv2.bytes);
  require('fs').writeFileSync(path.join(out, 'preview-grid.png'), pv2.data);
  // Validate PDFs open in mupdf and count pages.
  const mupdf = await import('mupdf');
  for (const f of require('fs').readdirSync(out).filter(f => f.endsWith('.pdf'))) {
    const doc = mupdf.Document.openDocument(require('fs').readFileSync(path.join(out, f)), 'application/pdf');
    console.log('valid pdf', f, doc.countPages());
  }
})().catch(e => console.log('FAIL', e));

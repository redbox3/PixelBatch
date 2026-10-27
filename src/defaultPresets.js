// Starter presets shown on first launch. Every field the UI edits has a default here.
const base = {
  mode: 'convert',
  sizes: [],
  fit: 'contain',
  position: 'centre',
  enlarge: false,
  background: '#ffffff',
  transparentBg: true,
  format: 'original',
  quality: 82,
  targetEnabled: false,
  targetKB: 200,
  targetMinQuality: 10,
  keepAnimation: true,
  progressive: true,
  pngPalette: false,
  pngColours: 256,
  webpLossless: false,
  gifColours: 256,
  gifDither: 100,
  gifLossy: 0,
  tiffCompression: 'lzw',
  icoSizes: [16, 32, 48, 256],
  autoOrient: true,
  rotate: 0,
  flipH: false,
  flipV: false,
  grayscale: false,
  sharpen: 0,
  brightness: 100,
  saturation: 100,
  keepMetadata: false,
  preserveDates: false,
  pdfPages: 'all',
  pdfTransparent: false,
  vectorDpi: 150,
  watermark: { enabled: false, type: 'text', text: '© Your Company', imagePath: '', position: 'br', opacity: 60, scale: 4, color: '#ffffff' },
  renamePattern: '{name}{suffix}{page}',
  renameStart: 1,
  rename: { case: 'none', spaces: 'keep', find: '', replace: '' },
  renameMove: false,
  outputDir: '',
  keepStructure: false,
  subfolderPerSize: false,
  conflict: 'increment',
  // Contact sheet and PDF modes
  combineName: '{folder}{page}',
  groupBy: 'all',
  sheet: { columns: 4, rows: 0, cellWidth: 400, cellHeight: 300, gap: 16, margin: 32, fit: 'contain', captions: true, captionSize: 14, captionColor: '#333333', title: '', background: '#ffffff' },
  pdf: { pageSize: 'a4', orientation: 'auto', marginMm: 10, layout: 'single', fit: 'contain', columns: 3, rows: 4, gapMm: 5, captions: false, captionColor: '#333333', title: '', pageNumbers: false, quality: 85, maxDpi: 200, lossless: false },
};

// Fills in fields added in later versions so older saved presets keep working.
function withDefaults(p) {
  return {
    ...base, ...p,
    sheet: { ...base.sheet, ...p.sheet },
    pdf: { ...base.pdf, ...p.pdf },
    watermark: { ...base.watermark, ...p.watermark },
    rename: { ...base.rename, ...p.rename },
  };
}

const size = (label, width, height, suffix) => ({ label, width, height, suffix: suffix ?? `_${label.toLowerCase()}`, enabled: true });

const presets = [
  { ...base, name: 'Web set (WebP)', format: 'webp', quality: 80,
    sizes: [size('Large', 1920, 1920), size('Medium', 1200, 1200), size('Thumb', 400, 400)] },
  { ...base, name: 'Email JPG under 250 KB', format: 'jpeg', quality: 85, targetEnabled: true, targetKB: 250, transparentBg: false,
    sizes: [size('Email', 1600, 1600, '')] },
  { ...base, name: 'Social squares (crop)', fit: 'cover', position: 'attention', format: 'jpeg', quality: 88, transparentBg: false,
    sizes: [size('Square', 1080, 1080, '_1080sq'), size('Portrait', 1080, 1350, '_1080x1350'), size('Story', 1080, 1920, '_story')] },
  { ...base, name: 'Animated GIF 480', format: 'gif', gifColours: 128, keepAnimation: true,
    sizes: [size('480', 480, null, '_480')] },
  { ...base, name: 'PDF / SVG to PNG 300dpi', fit: 'none', format: 'png', vectorDpi: 300, pdfPages: 'all' },
  { ...base, name: 'Contact sheet 5 × 6', mode: 'sheet', format: 'jpeg', quality: 85, combineName: '{folder}_contact-sheet{page}', groupBy: 'folder',
    sheet: { ...base.sheet, columns: 5, rows: 6, cellWidth: 360, cellHeight: 270, title: 'Contact sheet' } },
  { ...base, name: 'Images to PDF (A4)', mode: 'pdf', combineName: '{folder}', groupBy: 'all',
    pdf: { ...base.pdf, pageSize: 'a4', orientation: 'auto', layout: 'single', marginMm: 10 } },
  { ...base, name: 'Rename only', mode: 'rename', renamePattern: '{folder}_{n:3}', rename: { case: 'lower', spaces: 'dash', find: '', replace: '' } },
];

module.exports = presets;
module.exports.base = base;
module.exports.withDefaults = withDefaults;

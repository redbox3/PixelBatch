const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const P = require('./processor');
const defaults = require('./defaultPresets');
const { withDefaults } = defaults;

let win;
let cancelled = false;
const thumbCache = new Map();

const presetsFile = () => path.join(app.getPath('userData'), 'presets.json');

// A folder that is not a full path on this platform (e.g. a D:\ path on a Mac) is replaced with one in Pictures.
const withOutputDir = p => path.isAbsolute(p.outputDir || '') ? p : { ...p, outputDir: path.join(app.getPath('pictures'), 'PixelBatch', p.name) };

function loadPresets() {
  try {
    const list = JSON.parse(fs.readFileSync(presetsFile(), 'utf8'));
    if (Array.isArray(list) && list.length) return list.map(withDefaults).map(withOutputDir);
  } catch {}
  return defaults.map(withOutputDir);
}

function savePresets(list) {
  fs.mkdirSync(path.dirname(presetsFile()), { recursive: true });
  fs.writeFileSync(presetsFile(), JSON.stringify(list, null, 2));
  return true;
}

function createWindow() {
  win = new BrowserWindow({
    width: 1560, height: 980, minWidth: 1100, minHeight: 700,
    title: 'PixelBatch',
    backgroundColor: '#16181d',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

Menu.setApplicationMenu(Menu.buildFromTemplate([
  ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
  { label: 'File', submenu: [
    { label: 'Add Files…', accelerator: 'CmdOrCtrl+O', click: () => win?.webContents.send('menu', 'addFiles') },
    { label: 'Add Folder…', accelerator: 'CmdOrCtrl+Shift+O', click: () => win?.webContents.send('menu', 'addFolder') },
    { type: 'separator' },
    { label: 'Process', accelerator: 'CmdOrCtrl+Enter', click: () => win?.webContents.send('menu', 'process') },
    { type: 'separator' },
    process.platform === 'darwin' ? { role: 'close' } : { role: 'quit' },
  ] },
  { role: 'editMenu' },
  { label: 'View', submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'togglefullscreen' }] },
]));

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });

const handle = (ch, fn) => ipcMain.handle(ch, async (e, ...args) => {
  try { return { ok: true, value: await fn(...args) }; }
  catch (err) { return { ok: false, error: err.message || String(err) }; }
});

handle('presets:load', () => loadPresets());
handle('presets:save', list => savePresets(list));
handle('presets:defaults', () => defaults);

handle('dialog:files', async () => {
  const r = await dialog.showOpenDialog(win, {
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Images, SVG & PDF', extensions: P.INPUT_EXT.map(e => e.slice(1)) }, { name: 'All files', extensions: ['*'] }],
  });
  return r.canceled ? [] : r.filePaths;
});
handle('dialog:folder', async title => {
  const r = await dialog.showOpenDialog(win, { title, properties: ['openDirectory', 'createDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});
handle('dialog:image', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: [{ name: 'Images', extensions: ['png', 'svg', 'webp', 'jpg', 'jpeg'] }] });
  return r.canceled ? null : r.filePaths[0];
});
handle('presets:export', async preset => {
  const r = await dialog.showSaveDialog(win, { defaultPath: `${preset.name}.pixelbatch.json`, filters: [{ name: 'PixelBatch preset', extensions: ['json'] }] });
  if (r.canceled) return false;
  fs.writeFileSync(r.filePath, JSON.stringify(preset, null, 2));
  return true;
});
handle('presets:import', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'], filters: [{ name: 'PixelBatch preset', extensions: ['json'] }] });
  if (r.canceled) return [];
  return r.filePaths.flatMap(f => { const d = JSON.parse(fs.readFileSync(f, 'utf8')); return Array.isArray(d) ? d : [d]; });
});

handle('scan', (paths, recursive) => P.scanPaths(paths, recursive));

handle('thumb', async (file, mtime) => {
  const key = `${file}|${mtime}`;
  if (!thumbCache.has(key)) thumbCache.set(key, P.thumbnail(file).catch(err => { thumbCache.delete(key); throw err; }));
  return thumbCache.get(key);
});
handle('original', (file, page) => P.original(file, page));
handle('preview', (file, preset, opts) => P.preview(file, preset, opts));
handle('previewCombine', (files, preset, selected) => P.previewCombine(files, preset, selected));

handle('buildName', (pattern, ctx, rename) => P.buildName(pattern, ctx, rename));
handle('open', p => shell.openPath(p));
handle('reveal', p => shell.showItemInFolder(p));

handle('cancel', () => { cancelled = true; return true; });

async function processCombined(files, preset) {
  const startedAt = Date.now();
  let finished = 0;
  const onFile = (f, status, error) => {
    finished++;
    win.webContents.send('progress', { path: f.path, status, error, done: finished, total: files.length });
  };
  const { results, warnings, failed } = await P.processCombine(files, preset, onFile, () => cancelled);
  const written = results.filter(r => !r.skipped);
  return {
    done: files.length - failed.size, failed: failed.size, outputs: written.length,
    inBytes: files.reduce((a, f) => a + f.bytes, 0), outBytes: written.reduce((a, r) => a + r.bytes, 0),
    errors: [...failed].map(([p, msg]) => `${path.basename(p)}: ${msg}`), warnings,
    files: written.map(r => r.output), cancelled, seconds: (Date.now() - startedAt) / 1000,
  };
}

handle('process', async (files, preset) => {
  cancelled = false;
  if (!preset.outputDir) throw new Error('Choose an output folder first.');
  fs.mkdirSync(preset.outputDir, { recursive: true });
  if (P.isCombine(preset)) return processCombined(files, preset);
  const reserved = new Set();
  const start = Number(preset.renameStart ?? 1);
  const concurrency = Math.max(1, Math.min(preset.mode === 'rename' ? 8 : 4, os.cpus().length - 1));
  const summary = { done: 0, failed: 0, outputs: 0, inBytes: 0, outBytes: 0, errors: [], warnings: [], startedAt: Date.now() };
  let next = 0;
  const worker = async () => {
    while (!cancelled && next < files.length) {
      const i = next++;
      const f = files[i];
      try {
        const rs = await P.processFile(f, preset, start + i, reserved);
        summary.inBytes += f.bytes;
        for (const r of rs) {
          if (r.skipped) continue;
          summary.outputs++;
          summary.outBytes += r.bytes || 0;
          for (const w of r.warnings || []) summary.warnings.push(`${f.name}: ${w}`);
        }
        summary.done++;
        win.webContents.send('progress', { index: i, path: f.path, status: 'done', results: rs, done: summary.done + summary.failed, total: files.length });
      } catch (err) {
        summary.failed++;
        summary.errors.push(`${f.name}: ${err.message}`);
        win.webContents.send('progress', { index: i, path: f.path, status: 'error', error: err.message, done: summary.done + summary.failed, total: files.length });
      }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  summary.cancelled = cancelled;
  summary.seconds = (Date.now() - summary.startedAt) / 1000;
  return summary;
});

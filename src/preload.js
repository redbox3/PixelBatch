const { contextBridge, ipcRenderer, webUtils } = require('electron');

const call = async (ch, ...args) => {
  const r = await ipcRenderer.invoke(ch, ...args);
  if (!r.ok) throw new Error(r.error);
  return r.value;
};

contextBridge.exposeInMainWorld('api', {
  platform: process.platform,
  pathForFile: file => webUtils.getPathForFile(file),
  loadPresets: () => call('presets:load'),
  savePresets: list => call('presets:save', list),
  defaultPresets: () => call('presets:defaults'),
  exportPreset: p => call('presets:export', p),
  importPresets: () => call('presets:import'),
  pickFiles: () => call('dialog:files'),
  pickFolder: title => call('dialog:folder', title),
  pickImage: () => call('dialog:image'),
  scan: (paths, recursive) => call('scan', paths, recursive),
  thumb: (file, mtime) => call('thumb', file, mtime),
  original: (file, page) => call('original', file, page),
  preview: (file, preset, opts) => call('preview', file, preset, opts),
  previewCombine: (files, preset, selected) => call('previewCombine', files, preset, selected),
  process: (files, preset) => call('process', files, preset),
  cancel: () => call('cancel'),
  buildName: (pattern, ctx, rename) => call('buildName', pattern, ctx, rename),
  open: p => call('open', p),
  reveal: p => call('reveal', p),
  onProgress: fn => ipcRenderer.on('progress', (e, d) => fn(d)),
  onMenu: fn => ipcRenderer.on('menu', (e, d) => fn(d)),
});

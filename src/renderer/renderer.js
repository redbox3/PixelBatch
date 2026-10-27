'use strict';
// `api` is the global exposed by preload.js.
const $ = sel => document.querySelector(sel);
const $$ = sel => [...document.querySelectorAll(sel)];

const state = {
  presets: [],
  current: 0,
  draft: null,
  dirty: false,
  files: [],
  selected: -1,
  page: 0,
  pageCount: 1,
  sizeIndex: 0,
  running: false,
  view: 'grid',
  lastSummary: null,
};

const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

const clone = o => JSON.parse(JSON.stringify(o));
// Images in pixels (with stored DPI, if any); PDF pages in points plus the mm equivalent.
const MM_PT = 72 / 25.4;
function fmtDims(m, compact) {
  if (!m) return '…';
  const x = compact ? '×' : ' × ';
  if (m.unit === 'pt') return `${m.width}${x}${m.height} pt (${Math.round(m.width / MM_PT)}${x}${Math.round(m.height / MM_PT)} mm)`;
  return `${m.width}${x}${m.height} px${m.dpi && !compact ? ` · ${m.dpi} dpi` : ''}`;
}
const fmtBytes = b =>b == null ? '–' : b < 1024 ? `${b} B` : b < 1048576 ? `${(b / 1024).toFixed(b < 10240 ? 1 : 0)} KB` : `${(b / 1048576).toFixed(2)} MB`;
const FORMAT_LABEL = { jpeg: 'JPG', jpg: 'JPG', png: 'PNG', webp: 'WebP', avif: 'AVIF', gif: 'GIF', tiff: 'TIFF', tif: 'TIFF', bmp: 'BMP', ico: 'ICO', svg: 'SVG', pdf: 'PDF' };
const fmtLabel = f => FORMAT_LABEL[String(f).toLowerCase()] || String(f).toUpperCase();

function toast(msg, ms = 2400) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, ms);
}

function askText(title, value = '') {
  return new Promise(resolve => {
    const dlg = $('#dlgText');
    $('#dlgTextTitle').textContent = title;
    const input = $('#dlgTextInput');
    input.value = value;
    dlg.returnValue = '';
    dlg.onclose = () => resolve(dlg.returnValue === 'ok' && input.value.trim() ? input.value.trim() : null);
    dlg.showModal();
    input.select();
  });
}

// ---------- path helpers for nested bindings ----------

const getPath = (obj, p) => p.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
function setPath(obj, p, v) {
  const keys = p.split('.');
  let o = obj;
  for (const k of keys.slice(0, -1)) o = (o[k] ??= {});
  o[keys.at(-1)] = v;
}

// ---------- presets ----------

async function initPresets() {
  state.presets = await api.loadPresets();
  const last = store.get('presetName', null);
  const idx = state.presets.findIndex(p => p.name === last);
  selectPreset(idx >= 0 ? idx : 0, true);
}

function renderPresetSelect() {
  const sel = $('#presetSelect');
  sel.innerHTML = '';
  state.presets.forEach((p, i) => {
    const o = document.createElement('option');
    o.value = i; o.textContent = p.name;
    sel.appendChild(o);
  });
  sel.value = state.current;
}

function selectPreset(i, force) {
  if (!force && state.dirty && !confirm('Discard unsaved changes to this preset?')) { $('#presetSelect').value = state.current; return; }
  state.current = Math.max(0, Math.min(i, state.presets.length - 1));
  state.draft = clone(state.presets[state.current]);
  state.sizeIndex = 0;
  setDirty(false);
  renderPresetSelect();
  store.set('presetName', state.draft.name);
  renderForm();
  schedulePreview();
}

function setDirty(d) {
  state.dirty = d;
  $('#dirtyDot').hidden = !d;
}

async function persist() {
  await api.savePresets(state.presets);
}

async function savePreset() {
  state.presets[state.current] = clone(state.draft);
  await persist();
  setDirty(false);
  toast(`Saved “${state.draft.name}”`);
}

async function saveAs() {
  const name = await askText('Save preset as', `${state.draft.name} copy`);
  if (!name) return;
  const p = clone(state.draft);
  p.name = uniqueName(name);
  state.presets.push(p);
  await persist();
  selectPreset(state.presets.length - 1, true);
  toast(`Saved “${p.name}”`);
}

function uniqueName(name) {
  let n = name, i = 2;
  while (state.presets.some(p => p.name === n)) n = `${name} ${i++}`;
  return n;
}

async function presetAction(act) {
  $('#presetMenu').hidden = true;
  if (act === 'new') {
    const name = await askText('New preset name', 'My preset');
    if (!name) return;
    const defaults = await api.defaultPresets();
    const base = clone(defaults[0]);
    Object.assign(base, { name: uniqueName(name), sizes: [{ label: 'Large', width: 1920, height: 1920, suffix: '_large', enabled: true }], format: 'jpeg', outputDir: state.draft.outputDir });
    state.presets.push(base);
    await persist();
    selectPreset(state.presets.length - 1, true);
  } else if (act === 'duplicate') {
    const p = clone(state.draft); p.name = uniqueName(`${p.name} copy`);
    state.presets.push(p); await persist(); selectPreset(state.presets.length - 1, true);
  } else if (act === 'rename') {
    const name = await askText('Rename preset', state.draft.name);
    if (!name) return;
    const finalName = name === state.presets[state.current].name ? name : uniqueName(name);
    state.draft.name = state.presets[state.current].name = finalName;
    await persist(); renderPresetSelect(); store.set('presetName', state.draft.name);
  } else if (act === 'revert') {
    selectPreset(state.current, true);
  } else if (act === 'delete') {
    if (state.presets.length <= 1) return toast('Keep at least one preset');
    if (!confirm(`Delete preset “${state.draft.name}”?`)) return;
    state.presets.splice(state.current, 1);
    await persist(); selectPreset(Math.max(0, state.current - 1), true);
  } else if (act === 'export') {
    if (await api.exportPreset(state.draft)) toast('Preset exported');
  } else if (act === 'import') {
    const list = await api.importPresets();
    const defaults = await api.defaultPresets();
    for (const p of list) state.presets.push({ ...clone(defaults[0]), ...p, name: uniqueName(p.name || 'Imported') });
    if (list.length) { await persist(); selectPreset(state.presets.length - 1, true); toast(`Imported ${list.length} preset(s)`); }
  } else if (act === 'restore') {
    const defaults = await api.defaultPresets();
    for (const p of defaults) state.presets.push({ ...clone(p), name: uniqueName(p.name), outputDir: state.draft.outputDir });
    await persist(); renderPresetSelect(); toast('Starter presets added');
  }
}

// ---------- settings form ----------

const SHOW = {
  cover: p => p.fit === 'cover',
  resize: p => p.fit !== 'none',
  quality: p => ['jpeg', 'avif', 'original'].includes(p.format) || (p.format === 'webp' && !p.webpLossless) || (p.format === 'tiff' && p.tiffCompression === 'jpeg') || (p.format === 'png' && p.pngPalette),
  target: p => ['jpeg', 'webp', 'avif', 'png', 'gif', 'original'].includes(p.format),
  targetOn: p => p.targetEnabled,
  jpeg: p => ['jpeg', 'original'].includes(p.format),
  png: p => ['png', 'original'].includes(p.format),
  pngPalette: p => p.pngPalette,
  webp: p => p.format === 'webp',
  gif: p => ['gif', 'original'].includes(p.format),
  anim: p => ['gif', 'webp', 'original'].includes(p.format),
  tiff: p => p.format === 'tiff',
  ico: p => p.format === 'ico',
  wm: p => p.watermark?.enabled,
  wmText: p => (p.watermark?.type || 'text') === 'text',
  wmImage: p => p.watermark?.type === 'image',
  renameMode: p => p.mode === 'rename',
  sheetCaptions: p => p.sheet?.captions,
  pdfFixedPage: p => p.pdf?.pageSize !== 'image',
  pdfGrid: p => p.pdf?.layout === 'grid',
  pdfLossy: p => !p.pdf?.lossless,
};

const isCombine = p => p.mode === 'sheet' || p.mode === 'pdf';

// Mirrors sheetLayout() in processor.js to show the sheet size while editing.
function sheetDimsText(s) {
  const cols = Math.max(1, s.columns || 4), cellW = s.cellWidth || 400, cellH = s.cellHeight || 300;
  const gap = s.gap ?? 16, margin = s.margin ?? 32, cap = s.captions ? Math.ceil((s.captionSize || 14) * 1.9) : 0;
  const head = s.title ? Math.ceil(Math.round((s.captionSize || 14) * 1.7) * 2.2) : 0;
  const w = 2 * margin + cols * cellW + (cols - 1) * gap;
  if (!(s.rows > 0)) return `Sheet width ${w} px; height grows with the number of images.`;
  const h = 2 * margin + head + s.rows * (cellH + cap + gap) - gap;
  return `Each sheet: ${w} × ${h} px, ${cols * s.rows} images.`;
}

function updateVisibility() {
  const p = state.draft;
  if (!p) return;
  for (const el of $$('[data-show]')) el.hidden = !SHOW[el.dataset.show](p);
  for (const el of $$('[data-modes]')) el.hidden = !el.dataset.modes.split(',').includes(p.mode || 'convert');
  $$('#pdfLayout button').forEach(b => b.classList.toggle('on', b.dataset.layout === (p.pdf?.layout || 'single')));
  $('#sheetDims').textContent = sheetDimsText(p.sheet || {});
  $('#pvSizeWrap').hidden = (p.mode || 'convert') !== 'convert';
  for (const el of $$('[data-out]')) {
    const v = getPath(p, el.dataset.out);
    el.textContent = v == null ? '' : `${v}${el.dataset.suffix || ''}`;
  }
  $$('#modeToggle button').forEach(b => b.classList.toggle('on', b.dataset.mode === (p.mode || 'convert')));
  $$('#wmType button').forEach(b => b.classList.toggle('on', b.dataset.wm === (p.watermark?.type || 'text')));
  $$('#wmPos button').forEach(b => b.classList.toggle('on', b.dataset.pos === (p.watermark?.position || 'br')));
  $$('#icoSizes .chip').forEach(c => c.classList.toggle('on', (p.icoSizes || []).includes(+c.dataset.size)));
  const resizeOff = p.fit === 'none';
  $('#sizeList').classList.toggle('disabled-section', resizeOff);
  $('#btnProcess').disabled = state.running || !state.files.length;
}

function renderForm() {
  const p = state.draft;
  for (const el of $$('[data-bind]')) {
    const v = getPath(p, el.dataset.bind);
    if (el.type === 'checkbox') el.checked = !!v;
    else el.value = v ?? '';
  }
  renderSizes();
  updateVisibility();
  updateNameExample();
}

function onFieldChange(e) {
  const el = e.target.closest('[data-bind]');
  if (!el) return;
  let v;
  if (el.type === 'checkbox') v = el.checked;
  else if (el.dataset.type === 'number' || el.type === 'number' || el.type === 'range') v = el.value === '' ? null : Number(el.value);
  else v = el.value;
  setPath(state.draft, el.dataset.bind, v);
  changed();
}

function changed({ preview = true } = {}) {
  setDirty(true);
  updateVisibility();
  updateNameExample();
  if (preview) schedulePreview();
}

function activeSizes() {
  return (state.draft.sizes || []).filter(s => s.enabled !== false);
}

function renderSizes() {
  const list = $('#sizeList');
  const sizes = state.draft.sizes || [];
  list.innerHTML = sizes.length ? '<div class="size-head"><span></span><span>Name</span><span>Width</span><span>Height</span><span>Suffix</span></div>' : '<p class="hint">No sizes — images keep their original dimensions.</p>';
  sizes.forEach((s, i) => {
    const row = document.createElement('div');
    row.className = 'size-row';
    row.innerHTML = `
      <input type="checkbox" data-k="enabled" ${s.enabled !== false ? 'checked' : ''} title="Include this size">
      <input type="text" data-k="label" placeholder="Name">
      <input type="number" data-k="width" min="1" placeholder="auto">
      <span class="x">×</span>
      <input type="number" data-k="height" min="1" placeholder="auto">
      <input type="text" data-k="suffix" placeholder="_suffix">
      <button class="del" title="Remove size">✕</button>
      <div class="size-extra">
        <label title="Overrides the preset's quality for this size">Quality <input type="number" data-k="quality" min="1" max="100" placeholder="preset"></label>
        <label title="Largest file this size may be; quality is lowered until it fits">Max <input type="number" data-k="targetKB" min="1" step="any" placeholder="preset"> KB</label>
        <span class="muted">${s.width || s.height ? '' : 'Full size — not resized'}</span>
      </div>`;
    row.querySelector('[data-k=label]').value = s.label || '';
    row.querySelector('[data-k=width]').value = s.width ?? '';
    row.querySelector('[data-k=height]').value = s.height ?? '';
    row.querySelector('[data-k=suffix]').value = s.suffix ?? '';
    row.querySelector('[data-k=quality]').value = s.quality ?? '';
    row.querySelector('[data-k=targetKB]').value = s.targetKB ?? '';
    row.addEventListener('input', e => {
      const k = e.target.dataset.k;
      if (!k) return;
      if (k === 'enabled') s.enabled = e.target.checked;
      else if (k === 'width' || k === 'height') {
        s[k] = e.target.value ? Math.max(1, parseInt(e.target.value, 10)) : null;
        row.querySelector('.size-extra .muted').textContent = s.width || s.height ? '' : 'Full size — not resized';
      }
      else if (k === 'quality') s.quality = e.target.value ? Math.min(100, Math.max(1, parseInt(e.target.value, 10))) : null;
      else if (k === 'targetKB') s.targetKB = e.target.value ? Math.max(1, Number(e.target.value)) : null;
      else s[k] = e.target.value;
      refreshSizeSelect();
      changed();
    });
    row.querySelector('.del').addEventListener('click', () => { sizes.splice(i, 1); renderSizes(); refreshSizeSelect(); changed(); });
    list.appendChild(row);
  });
  refreshSizeSelect();
}

function addSize(width, height, label) {
  state.draft.sizes ||= [];
  label ||= width && height ? `${width}x${height}` : `${width || height}`;
  const suffix = '_' + label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  state.draft.sizes.push({ label, width: width || null, height: height || null, suffix, enabled: true });
  if (state.draft.fit === 'none') state.draft.fit = 'contain';
  renderForm();
  changed();
}

function refreshSizeSelect() {
  const sel = $('#pvSize');
  const sizes = activeSizes();
  sel.innerHTML = '';
  if (!sizes.length || state.draft.fit === 'none') {
    sel.innerHTML = '<option value="0">Original size</option>';
    state.sizeIndex = 0;
  } else {
    sizes.forEach((s, i) => {
      const o = document.createElement('option');
      o.value = i;
      o.textContent = `${s.label || 'Size ' + (i + 1)} — ${s.width || s.height ? `${s.width || 'auto'}×${s.height || 'auto'}` : 'full size'}`;
      sel.appendChild(o);
    });
    state.sizeIndex = Math.min(state.sizeIndex, sizes.length - 1);
  }
  sel.value = state.sizeIndex;
  sel.disabled = (state.draft.mode || 'convert') !== 'convert';
}

const TOKENS = [
  ['{name}', 'Original file name'], ['{n}', 'Counter'], ['{n:3}', 'Counter padded to 3 digits'], ['{suffix}', 'Size suffix'], ['{size}', 'Size name'],
  ['{w}', 'Output width'], ['{h}', 'Output height'], ['{page}', 'PDF page as _p1 (only for multi-page)'], ['{folder}', 'Parent folder name'],
  ['{date}', 'Today YYYY-MM-DD'], ['{time}', 'Time HHMMSS'], ['{ext}', 'Original extension'], ['{fmt}', 'Output format'], ['{preset}', 'Preset name'],
];

async function updateNameExample() {
  const p = state.draft;
  const f = state.files[state.selected] || state.files[0];
  const size = p.mode === 'rename' ? null : activeSizes()[state.sizeIndex] || null;
  const fname = f ? f.name : 'IMG_0042 holiday.jpg';
  const dot = fname.lastIndexOf('.');
  const ctx = {
    name: dot > 0 ? fname.slice(0, dot) : fname, srcExt: dot > 0 ? fname.slice(dot + 1) : 'jpg', folder: f ? f.path.split(/[\\/]/).slice(-2, -1)[0] : 'Photos',
    preset: p.name, index: (p.renameStart ?? 1) + Math.max(0, state.files.indexOf(f)), size,
    width: size?.width || f?.meta?.width || 1920, height: size?.height || f?.meta?.height || 1080, page: 1, pageCount: f?.meta?.pages > 1 && f.ext === 'pdf' ? f.meta.pages : 1,
    format: p.mode === 'rename' ? ctx_ext(fname) : ({ jpeg: 'jpg', tiff: 'tif', original: ctx_ext(fname) }[p.format] || p.format),
  };
  const ext = p.mode === 'rename' ? ctx_ext(fname) : ctx.format;
  try {
    if (isCombine(p)) {
      const group = state.files[p.groupBy === 'folder' ? state.selected : 0] || f;
      const folder = group ? group.path.split(/[\\/]/).slice(-2, -1)[0] : 'Photos';
      const cext = p.mode === 'pdf' ? 'pdf' : ({ jpeg: 'jpg', tiff: 'tif', original: 'jpg' }[p.format] || p.format);
      const pages = p.mode === 'sheet' && p.sheet?.rows > 0 ? Math.ceil(state.files.length / ((p.sheet.columns || 4) * p.sheet.rows)) : 1;
      const name = await api.buildName(p.combineName, { name: folder, folder, preset: p.name, index: p.renameStart ?? 1, page: 1, pageCount: pages, format: cext }, p.rename);
      $('#combineExample').textContent = `${name}.${cext}${pages > 1 ? `  (+${pages - 1} more)` : ''}`;
      return;
    }
    const name = await api.buildName(p.renamePattern, ctx, p.rename);
    $('#nameExample').textContent = `${fname}  →  ${name}.${ext}`;
  } catch {}
}
function ctx_ext(n) { const d = n.lastIndexOf('.'); return d > 0 ? n.slice(d + 1).toLowerCase().replace('jpeg', 'jpg') : 'jpg'; }

const COMBINE_TOKENS = [
  ['{folder}', 'Source folder name'], ['{page}', 'Sheet number as _p2 (only when there are several)'], ['{p}', 'Sheet number'],
  ['{n}', 'Counter'], ['{n:3}', 'Counter padded to 3 digits'], ['{date}', 'Today YYYY-MM-DD'], ['{time}', 'Time HHMMSS'], ['{preset}', 'Preset name'],
];

function insertToken(tok, inputId, key) {
  const el = $(inputId);
  const s = el.selectionStart ?? el.value.length, e = el.selectionEnd ?? el.value.length;
  el.value = el.value.slice(0, s) + tok + el.value.slice(e);
  el.focus();
  el.setSelectionRange(s + tok.length, s + tok.length);
  state.draft[key] = el.value;
  changed();
}

function buildStaticControls() {
  $('#tokens').innerHTML = TOKENS.map(([t, d]) => `<span class="chip" data-token="${t}" title="${d}">${t}</span>`).join('');
  $('#combineTokens').innerHTML = COMBINE_TOKENS.map(([t, d]) => `<span class="chip" data-token="${t}" title="${d}">${t}</span>`).join('');
  $('#wmPos').innerHTML = ['tl', 'tc', 'tr', 'ml', 'c', 'mr', 'bl', 'bc', 'br'].map(p => `<button data-pos="${p}" title="${p}"></button>`).join('');
  $('#icoSizes').innerHTML = [16, 24, 32, 48, 64, 128, 256].map(s => `<span class="chip" data-size="${s}">${s}</span>`).join('');
}

// ---------- files ----------

async function addPaths(paths) {
  if (!paths?.length) return;
  $('#statusText').textContent = 'Scanning…';
  const found = await api.scan(paths, $('#optRecursive').checked);
  const known = new Set(state.files.map(f => f.path));
  const added = found.filter(f => !known.has(f.path)).map(f => ({ ...f, status: '' }));
  const wasEmpty = state.selected < 0;
  state.files.push(...added);
  renderFiles();
  $('#statusText').textContent = added.length ? `Added ${added.length} file(s)` : found.length ? 'Those files are already in the list' : 'No supported images found';
  if (wasEmpty && state.files.length) selectFile(0);
}

const thumbQueue = [];
let thumbActive = 0;
const observer = new IntersectionObserver(entries => {
  for (const en of entries) {
    if (!en.isIntersecting) continue;
    observer.unobserve(en.target);
    const f = state.files.find(x => x.path === en.target.dataset.path);
    if (f && !f.thumbUrl) { thumbQueue.push(f); pumpThumbs(); }
  }
}, { root: $('#fileArea'), rootMargin: '300px' });

function pumpThumbs() {
  while (thumbActive < 4 && thumbQueue.length) {
    const f = thumbQueue.shift();
    if (!state.files.includes(f)) continue;
    thumbActive++;
    api.thumb(f.path, f.mtime).then(t => {
      f.meta = t;
      f.thumbUrl = URL.createObjectURL(new Blob([t.data], { type: t.type }));
      updateFileItem(f);
      if (state.files[state.selected] === f) { renderOrigInfo(); updateNameExample(); }
    }).catch(err => { f.thumbError = err.message; updateFileItem(f); })
      .finally(() => { thumbActive--; pumpThumbs(); });
  }
}

function fileItemHtml(f) {
  const m = f.meta;
  const dims = fmtDims(m, true);
  const extra = m?.pages > 1 ? (f.ext === 'pdf' ? ` · ${m.pages} pages` : ` · ${m.pages} frames`) : '';
  return `
    <div class="th">${f.thumbUrl ? `<img src="${f.thumbUrl}" alt="">` : f.thumbError ? '<span class="muted tiny">No preview</span>' : ''}</div>
    <div class="info"><div class="nm" title="${escapeHtml(f.path)}">${escapeHtml(f.name)}</div>
    <div class="meta">${dims} · ${fmtBytes(f.bytes)}${extra}</div></div>
    <span class="badge">${fmtLabel(f.ext)}</span>
    <span class="st">${f.status === 'done' ? '✓' : f.status === 'error' ? '!' : '•'}</span>
    <button class="rm" title="Remove">✕</button>`;
}

function escapeHtml(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

function renderFiles() {
  const grid = $('#fileGrid');
  grid.innerHTML = '';
  grid.classList.toggle('list', state.view === 'list');
  const frag = document.createDocumentFragment();
  state.files.forEach((f, i) => {
    const el = document.createElement('div');
    el.className = `file-item ${f.status || ''} ${i === state.selected ? 'sel' : ''}`;
    el.dataset.path = f.path;
    el.innerHTML = fileItemHtml(f);
    if (f.error) el.title = f.error;
    f.el = el;
    frag.appendChild(el);
    if (!f.thumbUrl && !f.thumbError) observer.observe(el);
  });
  grid.appendChild(frag);
  $('#emptyDrop').hidden = state.files.length > 0;
  const total = state.files.reduce((a, f) => a + f.bytes, 0);
  $('#fileCount').textContent = state.files.length ? `${state.files.length} file${state.files.length > 1 ? 's' : ''} · ${fmtBytes(total)}` : 'No files';
  updateVisibility();
}

function updateFileItem(f) {
  if (!f.el) return;
  f.el.className = `file-item ${f.status || ''} ${state.files[state.selected] === f ? 'sel' : ''}`;
  f.el.innerHTML = fileItemHtml(f);
  f.el.title = f.error || '';
}

function selectFile(i) {
  if (i < 0 || i >= state.files.length) return;
  const prev = state.files[state.selected];
  state.selected = i;
  if (prev) updateFileItem(prev);
  const f = state.files[i];
  updateFileItem(f);
  f.el?.scrollIntoView({ block: 'nearest' });
  state.page = 0;
  state.pageCount = f.ext === 'pdf' ? (f.meta?.pages || 1) : 1;
  origUrlFor = null;
  updateNameExample();
  schedulePreview(0);
}

function removeFile(i) {
  const [f] = state.files.splice(i, 1);
  if (f?.thumbUrl) URL.revokeObjectURL(f.thumbUrl);
  if (state.selected >= state.files.length) state.selected = state.files.length - 1;
  renderFiles();
  if (state.selected >= 0) selectFile(state.selected); else clearPreview();
}

function clearFiles() {
  for (const f of state.files) if (f.thumbUrl) URL.revokeObjectURL(f.thumbUrl);
  state.files = [];
  state.selected = -1;
  renderFiles();
  clearPreview();
  $('#statusText').textContent = 'Ready';
  $('#progressBar').style.width = '0';
}

// ---------- preview ----------

let previewTimer = null, previewReq = 0, origUrlFor = null, origUrl = null, resUrl = null;

function schedulePreview(delay = 300) {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(runPreview, delay);
}

function clearPreview() {
  $('#pvEmpty').hidden = false;
  $('#pvInfoOrig').innerHTML = '';
  $('#pvInfoRes').innerHTML = '';
  $('#pvWarn').hidden = true;
  $('#pvPageWrap').hidden = true;
}

function setImg(ids, url) { for (const id of ids) { const img = $(id); img.src = url || ''; } }

function renderOrigInfo() {
  const f = state.files[state.selected];
  if (!f) return;
  const m = f.meta;
  $('#pvInfoOrig').innerHTML = `<b>${fmtDims(m)}</b> ·${fmtLabel(f.ext)} · ${fmtBytes(f.bytes)}<div class="fn">${escapeHtml(f.name)}</div>`;
}

async function runPreview() {
  const f = state.files[state.selected];
  if (!f) return clearPreview();
  const req = ++previewReq;
  $('#pvEmpty').hidden = true;
  $('#pvSpinner').hidden = false;
  renderOrigInfo();
  const key = `${f.path}|${state.page}`;
  try {
    if (origUrlFor !== key) {
      const o = await api.original(f.path, state.page);
      if (req !== previewReq) return;
      if (origUrl) URL.revokeObjectURL(origUrl);
      origUrl = URL.createObjectURL(new Blob([o.data], { type: o.type }));
      origUrlFor = key;
      setImg(['#pvOrigImg', '#pvSplitOrig'], origUrl);
    }
    if (state.draft.mode === 'rename') {
      setImg(['#pvResImg', '#pvSplitRes'], origUrl);
      const name = $('#nameExample').textContent.split('→').pop().trim();
      $('#pvInfoRes').innerHTML = `<b>Renamed copy</b> · no re-encoding<div class="fn">${escapeHtml(name)}</div>`;
      $('#pvWarn').hidden = true;
      $('#pvPageWrap').hidden = true;
      return;
    }
    if (isCombine(state.draft)) {
      const payload = state.files.map(({ path, root, name, ext, bytes, mtime }) => ({ path, root, name, ext, bytes, mtime }));
      const r = await api.previewCombine(payload, state.draft, state.selected);
      if (req !== previewReq) return;
      if (resUrl) URL.revokeObjectURL(resUrl);
      resUrl = URL.createObjectURL(new Blob([r.data], { type: r.type }));
      setImg(['#pvResImg', '#pvSplitRes'], resUrl);
      const dims = r.dims || `${r.width} × ${r.height} px`;
      $('#pvInfoRes').innerHTML = `<b>${escapeHtml(dims)}</b> · ${fmtLabel(r.format)} · ${fmtBytes(r.bytes)}<div class="fn">${escapeHtml(r.note)} · ${escapeHtml(r.fileName)}</div>`;
      $('#pvWarn').hidden = !r.warnings?.length;
      $('#pvWarn').textContent = (r.warnings || []).join(' ');
      $('#pvPageWrap').hidden = true;
      return;
    }
    const r = await api.preview(f.path, state.draft, { sizeIndex: state.sizeIndex, page: state.page });
    if (req !== previewReq) return;
    if (resUrl) URL.revokeObjectURL(resUrl);
    resUrl = URL.createObjectURL(new Blob([r.data], { type: r.type }));
    setImg(['#pvResImg', '#pvSplitRes'], resUrl);
    // A % change against a vector source's file size is meaningless, so only show it for rasters.
    const pct = f.bytes ? Math.round((1 - r.bytes / f.bytes) * 100) : 0;
    const saving = ['pdf', 'svg'].includes(f.ext) ? '' : pct >= 0 ? `<span class="saving">−${pct}%</span>` : `<span class="saving bigger">+${-pct}%</span>`;
    const q = r.quality && ['jpeg', 'webp', 'avif'].includes(r.format) ? ` · q${r.quality}` : '';
    $('#pvInfoRes').innerHTML = `<b>${r.width} × ${r.height} px</b> ·${fmtLabel(r.format)}${r.animated ? ' (animated)' : ''} · ${fmtBytes(r.bytes)} ${saving}${q}<div class="fn">${escapeHtml(r.fileName)}</div>`;
    $('#pvWarn').hidden = !r.warnings?.length;
    $('#pvWarn').textContent = (r.warnings || []).join(' ');
    state.pageCount = r.pageCount || 1;
    $('#pvPageWrap').hidden = state.pageCount <= 1;
    $('#pvPage').textContent = `Page ${state.page + 1}/${state.pageCount}`;
  } catch (err) {
    if (req !== previewReq) return;
    $('#pvInfoRes').innerHTML = `<span class="danger">Preview failed: ${escapeHtml(err.message)}</span>`;
  } finally {
    if (req === previewReq) $('#pvSpinner').hidden = true;
  }
}

function applyZoom() {
  const one = $('#pvStage').classList.contains('zoom-1');
  for (const img of [$('#pvOrigImg'), $('#pvResImg')]) {
    img.style.width = one && img.naturalWidth ? `${img.naturalWidth / devicePixelRatio}px` : '';
  }
}

function initSplit() {
  const inner = $('.pv-split-inner');
  let dragging = false;
  const move = e => {
    const r = inner.getBoundingClientRect();
    const pct = Math.min(100, Math.max(0, ((e.clientX - r.left) / r.width) * 100));
    inner.style.setProperty('--split', `${pct}%`);
  };
  inner.addEventListener('pointerdown', e => { dragging = true; inner.setPointerCapture(e.pointerId); move(e); });
  inner.addEventListener('pointermove', e => dragging && move(e));
  inner.addEventListener('pointerup', () => { dragging = false; });
}

// ---------- processing ----------

async function processAll() {
  if (state.running || !state.files.length) return;
  const preset = clone(state.draft);
  if (!preset.outputDir) {
    const dir = await api.pickFolder('Choose output folder');
    if (!dir) return;
    state.draft.outputDir = preset.outputDir = dir;
    renderForm(); setDirty(true);
  }
  state.running = true;
  state.moving = preset.mode === 'rename' && !!preset.renameMove;
  for (const f of state.files) { f.status = ''; f.error = ''; updateFileItem(f); }
  $('#btnCancel').hidden = false;
  $('#btnProcess').disabled = true;
  $('#progressBar').style.width = '0';
  $('#statusText').textContent = `Processing ${state.files.length} file(s)…`;
  const payload = state.files.map(({ path, root, name, ext, bytes, mtime }) => ({ path, root, name, ext, bytes, mtime }));
  try {
    const summary = await api.process(payload, preset);
    state.lastSummary = { ...summary, outputDir: preset.outputDir };
    $('#statusText').textContent = `${summary.cancelled ? 'Cancelled' : 'Done'} — ${summary.done} file(s) → ${summary.outputs} output(s) in ${summary.seconds.toFixed(1)}s${summary.failed ? ` · ${summary.failed} failed` : ''}`;
    $('#btnSummary').hidden = false;
    showSummary();
  } catch (err) {
    $('#statusText').textContent = `Error: ${err.message}`;
  } finally {
    state.running = false;
    $('#btnCancel').hidden = true;
    updateVisibility();
    if (state.moving) { state.moving = false; updateNameExample(); schedulePreview(0); }
  }
}

// After a move-rename the list must point at the new paths, or previews and the next run fail.
function followMove(f, to) {
  f.path = to;
  f.name = to.split(/[\\/]/).pop();
  f.root = to.slice(0, -f.name.length - 1);
  f.ext = f.name.includes('.') ? f.name.split('.').pop().toLowerCase() : '';
  if (f.el) f.el.dataset.path = to;
}

function onProgress(d) {
  const f = state.files.find(x => x.path === d.path);
  const movedTo = state.moving && d.status === 'done' && d.results?.[0]?.output;
  if (f && movedTo) followMove(f, movedTo);
  if (f) { f.status = d.status; f.error = d.error || ''; updateFileItem(f); }
  $('#progressBar').style.width = `${(d.done / d.total) * 100}%`;
  $('#statusText').textContent = `Processing… ${d.done}/${d.total}${d.status === 'error' ? ` — ${f?.name}: ${d.error}` : ''}`;
}

function showSummary() {
  const s = state.lastSummary;
  if (!s) return;
  const pct = s.inBytes ? Math.round((1 - s.outBytes / s.inBytes) * 100) : 0;
  $('#summaryBody').innerHTML = `
    <div class="sum-grid">
      <div><span class="muted">Files</span><b>${s.done}${s.failed ? ` <span class="danger">+${s.failed} failed</span>` : ''}</b></div>
      <div><span class="muted">Images written</span><b>${s.outputs}</b></div>
      <div><span class="muted">Time</span><b>${s.seconds.toFixed(1)} s</b></div>
      <div><span class="muted">Input</span><b>${fmtBytes(s.inBytes)}</b></div>
      <div><span class="muted">Output</span><b>${fmtBytes(s.outBytes)}</b></div>
      <div><span class="muted">Change</span><b class="${pct >= 0 ? 'saving' : 'saving bigger'}">${pct >= 0 ? '−' : '+'}${Math.abs(pct)}%</b></div>
    </div>
    ${s.cancelled ? '<p class="danger">The batch was cancelled before finishing.</p>' : ''}
    ${s.errors.length ? `<p>Errors</p><div class="sum-list err">${s.errors.map(escapeHtml).join('<br>')}</div>` : ''}
    ${s.warnings.length ? `<p>Warnings</p><div class="sum-list warn">${[...new Set(s.warnings)].slice(0, 200).map(escapeHtml).join('<br>')}</div>` : ''}
    <p class="muted small">Saved to ${escapeHtml(s.outputDir)}</p>`;
  $('#dlgSummary').showModal();
}

// ---------- wiring ----------

function wire() {
  buildStaticControls();
  $('#settings').addEventListener('input', onFieldChange);
  $('#settings').addEventListener('change', onFieldChange);

  $('#presetSelect').addEventListener('change', e => selectPreset(+e.target.value));
  $('#btnSave').addEventListener('click', savePreset);
  $('#btnSaveAs').addEventListener('click', saveAs);
  $('#btnPresetMenu').addEventListener('click', e => { e.stopPropagation(); $('#presetMenu').hidden = !$('#presetMenu').hidden; });
  $('#presetMenu').addEventListener('click', e => { const b = e.target.closest('[data-act]'); if (b) presetAction(b.dataset.act); });
  document.addEventListener('click', e => { if (!e.target.closest('.menu-wrap')) $('#presetMenu').hidden = true; });

  $('#modeToggle').addEventListener('click', e => {
    const b = e.target.closest('[data-mode]'); if (!b) return;
    state.draft.mode = b.dataset.mode; refreshSizeSelect(); changed();
  });
  $('#btnAddSize').addEventListener('click', () => addSize(1200, 1200, 'New size'));
  $('#quickSize').addEventListener('change', e => {
    if (!e.target.value) return;
    const [w, h, label] = e.target.value.split(',');
    addSize(w ? +w : null, h ? +h : null, label);
    e.target.value = '';
  });
  $('#tokens').addEventListener('click', e => { const c = e.target.closest('[data-token]'); if (c) insertToken(c.dataset.token, '#renamePattern', 'renamePattern'); });
  $('#combineTokens').addEventListener('click', e => { const c = e.target.closest('[data-token]'); if (c) insertToken(c.dataset.token, '#combineName', 'combineName'); });
  $('#pdfLayout').addEventListener('click', e => { const b = e.target.closest('[data-layout]'); if (b) { state.draft.pdf.layout = b.dataset.layout; changed(); } });
  $('#wmType').addEventListener('click', e => { const b = e.target.closest('[data-wm]'); if (b) { state.draft.watermark.type = b.dataset.wm; changed(); } });
  $('#wmPos').addEventListener('click', e => { const b = e.target.closest('[data-pos]'); if (b) { state.draft.watermark.position = b.dataset.pos; changed(); } });
  $('#icoSizes').addEventListener('click', e => {
    const c = e.target.closest('[data-size]'); if (!c) return;
    const set = new Set(state.draft.icoSizes || []);
    const s = +c.dataset.size;
    set.has(s) ? set.delete(s) : set.add(s);
    state.draft.icoSizes = [...set].sort((a, b) => a - b);
    changed();
  });
  $('#btnWmImage').addEventListener('click', async () => {
    const p = await api.pickImage();
    if (p) { state.draft.watermark.imagePath = p; renderForm(); changed(); }
  });
  $('#btnOutDir').addEventListener('click', async () => {
    const p = await api.pickFolder('Choose output folder');
    if (p) { state.draft.outputDir = p; renderForm(); changed({ preview: false }); }
  });
  $('#btnOpenOut').addEventListener('click', () => state.draft.outputDir && api.open(state.draft.outputDir));

  $('#btnAddFiles').addEventListener('click', async () => addPaths(await api.pickFiles()));
  $('#btnAddFolder').addEventListener('click', async () => { const p = await api.pickFolder('Add folder'); if (p) addPaths([p]); });
  $('#btnClear').addEventListener('click', clearFiles);
  $('#viewToggle').addEventListener('click', e => {
    const b = e.target.closest('[data-view]'); if (!b) return;
    state.view = b.dataset.view; store.set('view', state.view);
    $$('#viewToggle button').forEach(x => x.classList.toggle('on', x === b));
    renderFiles();
  });
  $('#thumbSize').addEventListener('input', e => { $('#fileGrid').style.setProperty('--thumb', `${e.target.value}px`); store.set('thumb', e.target.value); });
  $('#fileGrid').addEventListener('click', e => {
    const item = e.target.closest('.file-item'); if (!item) return;
    const i = state.files.findIndex(f => f.path === item.dataset.path);
    if (e.target.closest('.rm')) removeFile(i); else selectFile(i);
  });
  $('#fileGrid').addEventListener('dblclick', e => {
    const item = e.target.closest('.file-item');
    if (item) api.reveal(item.dataset.path);
  });

  $('#pvSize').addEventListener('change', e => { state.sizeIndex = +e.target.value; updateNameExample(); schedulePreview(0); });
  $('#pvPrev').addEventListener('click', () => { if (state.page > 0) { state.page--; schedulePreview(0); } });
  $('#pvNext').addEventListener('click', () => { if (state.page < state.pageCount - 1) { state.page++; schedulePreview(0); } });
  $('#pvMode').addEventListener('click', e => {
    const b = e.target.closest('[data-mode]'); if (!b) return;
    $$('#pvMode button').forEach(x => x.classList.toggle('on', x === b));
    const st = $('#pvStage');
    st.className = st.className.replace(/mode-\w+/, `mode-${b.dataset.mode}`);
    store.set('pvMode', b.dataset.mode);
  });
  $('#pvZoom').addEventListener('click', e => {
    const b = e.target.closest('[data-zoom]'); if (!b) return;
    $$('#pvZoom button').forEach(x => x.classList.toggle('on', x === b));
    const st = $('#pvStage');
    st.classList.toggle('zoom-fit', b.dataset.zoom === 'fit');
    st.classList.toggle('zoom-1', b.dataset.zoom === '1');
    applyZoom();
  });
  $('#pvOrigImg').addEventListener('load', applyZoom);
  $('#pvResImg').addEventListener('load', applyZoom);
  initSplit();

  $('#btnProcess').addEventListener('click', processAll);
  $('#btnCancel').addEventListener('click', () => { api.cancel(); $('#statusText').textContent = 'Cancelling…'; });
  $('#btnSummary').addEventListener('click', showSummary);
  $('#btnSumOpen').addEventListener('click', () => state.lastSummary && api.open(state.lastSummary.outputDir));
  api.onProgress(onProgress);
  api.onMenu(async cmd => {
    if (cmd === 'addFiles') addPaths(await api.pickFiles());
    else if (cmd === 'addFolder') { const p = await api.pickFolder('Add folder'); if (p) addPaths([p]); }
    else if (cmd === 'process') processAll();
  });

  // Drag and drop anywhere on the window.
  let dragDepth = 0;
  window.addEventListener('dragenter', e => { if (e.dataTransfer?.types.includes('Files')) { e.preventDefault(); dragDepth++; $('#dropOverlay').hidden = false; } });
  window.addEventListener('dragover', e => e.preventDefault());
  window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('#dropOverlay').hidden = true; } });
  window.addEventListener('drop', e => {
    e.preventDefault();
    dragDepth = 0;
    $('#dropOverlay').hidden = true;
    const paths = [...e.dataTransfer.files].map(f => api.pathForFile(f)).filter(Boolean);
    addPaths(paths);
  });

  document.addEventListener('keydown', e => {
    if (e.target.matches('input, select, textarea') || document.querySelector('dialog[open]')) return;
    const cols = state.view === 'grid' ? Math.max(1, Math.round($('#fileGrid').clientWidth / ((state.files[0]?.el?.offsetWidth || 128) + 8))) : 1;
    if (e.key === 'ArrowRight' || (e.key === 'ArrowDown' && state.view === 'list')) selectFile(state.selected + 1);
    else if (e.key === 'ArrowLeft' || (e.key === 'ArrowUp' && state.view === 'list')) selectFile(state.selected - 1);
    else if (e.key === 'ArrowDown') selectFile(Math.min(state.files.length - 1, state.selected + cols));
    else if (e.key === 'ArrowUp') selectFile(Math.max(0, state.selected - cols));
    else if ((e.key === 'Delete' || e.key === 'Backspace') && state.selected >= 0) removeFile(state.selected);
    else return;
    e.preventDefault();
  });
  window.addEventListener('keydown', e => { if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); savePreset(); } });

  // Restore per-viewer view preferences.
  const view = store.get('view', 'grid');
  $(`#viewToggle [data-view="${view}"]`)?.click();
  const thumb = store.get('thumb', 128);
  $('#thumbSize').value = thumb;
  $('#fileGrid').style.setProperty('--thumb', `${thumb}px`);
  $(`#pvMode [data-mode="${store.get('pvMode', 'side')}"]`)?.click();
  $('#pvStage').classList.add('zoom-fit');
}

wire();
initPresets().catch(err => toast(`Could not load presets: ${err.message}`, 6000));

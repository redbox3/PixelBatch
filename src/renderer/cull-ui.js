'use strict';
// "Pick best shots" view. Uses globals from renderer.js: state, $, $$, api, toast, escapeHtml, renderFiles, selectFile.

const cull = { groups: null, analysedKey: '', urls: [], before: null, sim: 'normal', lightbox: -1 };

const cullOpts = () => ({ similarity: cull.sim, maxGapSeconds: Number($('#cullGap').value), keep: Number($('#cullKeep').value) });
const filesKey = () => state.files.map(f => f.path).join('|');
const visibleCards = () => $$('#cullBody .cull-card');

function cullItem(path) {
  for (const g of cull.groups || []) for (const it of g.items) if (it.path === path) return it;
  return null;
}

async function openCull() {
  if (!state.files.length) return toast('Add some photos first');
  $('#cullView').hidden = false;
  if (cull.groups && cull.analysedKey === filesKey()) renderCull();
  else analyseCull();
}

async function analyseCull() {
  const files = state.files.map(({ path, name, ext, bytes, mtime }) => ({ path, name, ext, bytes, mtime }));
  cull.groups = null;
  $('#cullBody').innerHTML = '';
  $('#cullApply').disabled = true;
  $('#cullAnalyse').disabled = true;
  $('#cullBar').style.width = '0';
  $('#cullStatus').textContent = `Analysing ${files.length} photos for sharpness, exposure and similarity…`;
  cull.running = true;
  try {
    const r = await api.cullAnalyse(files, cullOpts());
    if (r.cancelled) { $('#cullStatus').textContent = 'Analysis cancelled.'; return; }
    cull.groups = r.groups;
    cull.analysedKey = filesKey();
    const failed = r.errors.length ? ` ${r.errors.length} couldn't be read (${r.errors.slice(0, 3).map(e => e.name).join(', ')}${r.errors.length > 3 ? '…' : ''}).` : '';
    $('#cullStatus').textContent = `Analysed ${files.length - r.errors.length} photos.${failed}`;
    renderCull();
  } catch (err) {
    $('#cullStatus').textContent = `Analysis failed: ${err.message}`;
  } finally {
    cull.running = false;
    $('#cullAnalyse').disabled = false;
  }
}

async function regroupCull() {
  if (!cull.groups) return;
  cull.groups = await api.cullRegroup(cullOpts());
  renderCull();
}

function renderCull() {
  for (const u of cull.urls) URL.revokeObjectURL(u);
  cull.urls = [];
  const onlyGroups = $('#cullOnlyGroups').checked;
  const html = [];
  for (const g of cull.groups) {
    if (onlyGroups && g.items.length < 2) continue;
    const title = g.items.length > 1 ? `<b>${g.items.length} similar shots</b> · ${escapeHtml(g.items[0].name)} – ${escapeHtml(g.items.at(-1).name)}` : `<b>Single shot</b> · ${escapeHtml(g.items[0].name)}`;
    const cards = g.items.map(it => {
      const url = URL.createObjectURL(new Blob([it.thumb], { type: 'image/webp' }));
      cull.urls.push(url);
      const flags = [it.blurry && 'looks blurred', it.highlights > 0.02 && 'blown highlights', it.brightness < 0.15 && 'very dark'].filter(Boolean).join(' · ');
      return `<div class="cull-card ${it.pick ? 'pick' : ''}" data-path="${escapeHtml(it.path)}" title="Score ${it.score}: sharpness and exposure compared with the rest of this group">
        <span class="star">★ Pick</span><img src="${url}" alt="">
        <div class="nm"><span>${escapeHtml(it.name)}</span><span class="muted">${it.score}</span></div>
        <div class="bar"><i style="width:${it.score}%"></i></div><div class="flags">${flags}</div></div>`;
    }).join('');
    html.push(`<section class="cull-group"><h3>${title}</h3><div class="cull-strip">${cards}</div></section>`);
  }
  $('#cullBody').innerHTML = html.join('') || '<p class="muted">No groups of similar shots with these settings.</p>';
  updateCullSummary();
}

function updateCullSummary() {
  const all = (cull.groups || []).flatMap(g => g.items);
  const picks = all.filter(i => i.pick).length;
  const multi = (cull.groups || []).filter(g => g.items.length > 1).length;
  $('#cullSummary').textContent = `${picks} picked of ${all.length} photos · ${multi} groups of similar shots. Click a photo to pick or unpick it; double-click to view it large.`;
  $('#cullApply').disabled = !picks;
  $('#cullApply').textContent = `Keep ${picks} picks only`;
}

function togglePick(path) {
  const it = cullItem(path);
  if (!it) return;
  it.pick = !it.pick;
  $$('#cullBody .cull-card').find(c => c.dataset.path === path)?.classList.toggle('pick', it.pick);
  updateCullSummary();
  if (cull.lightbox >= 0) updateLightboxBar();
}

// Keeps only the picked photos in the file list; "Show all again" brings the rest back.
function applyCull() {
  const picks = new Set((cull.groups || []).flatMap(g => g.items).filter(i => i.pick).map(i => i.path));
  cull.before ||= state.files.slice();
  state.files = state.files.filter(f => picks.has(f.path));
  state.selected = -1;
  renderFiles();
  if (state.files.length) selectFile(0);
  $('#btnRestoreAll').hidden = false;
  closeCull();
  toast(`Keeping ${state.files.length} picks. Process them as usual.`);
}

function restoreAll() {
  if (!cull.before) return;
  const current = new Set(state.files.map(f => f.path));
  state.files = [...cull.before, ...state.files.filter(f => !cull.before.some(b => b.path === f.path))];
  cull.before = null;
  state.selected = -1;
  renderFiles();
  if (state.files.length) selectFile(0);
  $('#btnRestoreAll').hidden = true;
  toast(`Showing all ${state.files.length} photos again (${state.files.length - current.size} were hidden).`);
}

function closeCull() {
  if (cull.running) api.cancel();
  closeLightbox();
  $('#cullView').hidden = true;
}

// ---------- large view ----------

let lightboxUrl = null;
async function openLightbox(index) {
  const cards = visibleCards();
  if (index < 0 || index >= cards.length) return;
  cull.lightbox = index;
  const path = cards[index].dataset.path;
  $('#cullLightbox').hidden = false;
  updateLightboxBar();
  const o = await api.original(path, 0);
  if (cull.lightbox !== index) return;
  if (lightboxUrl) URL.revokeObjectURL(lightboxUrl);
  lightboxUrl = URL.createObjectURL(new Blob([o.data], { type: o.type }));
  $('#cullLightbox img').src = lightboxUrl;
}

function updateLightboxBar() {
  const card = visibleCards()[cull.lightbox];
  const it = card && cullItem(card.dataset.path);
  if (!it) return;
  $('#cullLightbox span').textContent = `${it.name} · score ${it.score} · ← → to move, space to pick`;
  $('#cullLightbox [data-lb=toggle]').textContent = it.pick ? '★ Picked — unpick' : 'Pick this one';
}

function closeLightbox() {
  cull.lightbox = -1;
  $('#cullLightbox').hidden = true;
  $('#cullLightbox img').removeAttribute('src');
}

// ---------- wiring ----------

$('#btnCull').addEventListener('click', openCull);
$('#btnRestoreAll').addEventListener('click', restoreAll);
$('#cullClose').addEventListener('click', closeCull);
$('#cullAnalyse').addEventListener('click', analyseCull);
$('#cullApply').addEventListener('click', applyCull);
$('#cullSim').addEventListener('click', e => {
  const b = e.target.closest('[data-sim]'); if (!b) return;
  cull.sim = b.dataset.sim;
  $$('#cullSim button').forEach(x => x.classList.toggle('on', x === b));
  regroupCull();
});
$('#cullGap').addEventListener('change', regroupCull);
$('#cullKeep').addEventListener('change', regroupCull);
$('#cullOnlyGroups').addEventListener('change', () => cull.groups && renderCull());
$('#cullBody').addEventListener('click', e => { const c = e.target.closest('.cull-card'); if (c) togglePick(c.dataset.path); });
$('#cullBody').addEventListener('dblclick', e => {
  // The double-click's two clicks have already toggled the pick twice, leaving it unchanged.
  const c = e.target.closest('.cull-card'); if (!c) return;
  openLightbox(visibleCards().indexOf(c));
});
$('#cullLightbox').addEventListener('click', e => {
  const b = e.target.closest('[data-lb]');
  if (b?.dataset.lb === 'close' || e.target === $('#cullLightbox')) closeLightbox();
  else if (b?.dataset.lb === 'toggle') togglePick(visibleCards()[cull.lightbox].dataset.path);
});
api.onCullProgress(d => {
  $('#cullBar').style.width = `${(d.done / d.total) * 100}%`;
  $('#cullStatus').textContent = `Analysing ${d.done} of ${d.total} photos… ${d.name}`;
});
// The view covers the main window, so it takes the keyboard while open.
window.addEventListener('keydown', e => {
  if ($('#cullView').hidden) return;
  e.stopImmediatePropagation();
  if (cull.lightbox >= 0) {
    if (e.key === 'Escape') closeLightbox();
    else if (e.key === 'ArrowRight') openLightbox(cull.lightbox + 1);
    else if (e.key === 'ArrowLeft') openLightbox(cull.lightbox - 1);
    else if (e.key === ' ') { e.preventDefault(); togglePick(visibleCards()[cull.lightbox].dataset.path); }
  } else if (e.key === 'Escape') closeCull();
}, true);

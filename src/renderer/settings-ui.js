'use strict';
// App settings window: what double-clicking a thumbnail does, and the app to open images with.
// Uses globals from renderer.js: $, $$, api, toast.

const appLabel = p => p.split(/[\\/]/).pop().replace(/\.(exe|app|lnk)$/i, '');

function showSettings(s) {
  for (const r of $$('input[name=dblClick]')) r.checked = r.value === s.dblClick;
  $('#appName').textContent = s.openWith ? appLabel(s.openWith) : 'None chosen';
  $('#appPath').textContent = s.openWith || 'Choose the app double-click should use, e.g. Photoshop.';
  $('#btnClearApp').hidden = !s.openWith;
  $('#revealLabel').textContent = s.platform === 'darwin' ? 'Shows it in Finder' : 'Shows it in its folder';
}

async function openSettings() {
  showSettings(await api.getSettings());
  $('#settingsView').hidden = false;
}

const closeSettings = () => { $('#settingsView').hidden = true; };

$('#btnSettings').addEventListener('click', openSettings);
$('#btnSettingsClose').addEventListener('click', closeSettings);
$('#settingsView').addEventListener('click', e => { if (e.target === $('#settingsView')) closeSettings(); });

$('#settingsView').addEventListener('change', async e => {
  if (e.target.name !== 'dblClick') return;
  let s = await api.setSettings({ dblClick: e.target.value });
  // Choosing "the app below" with no app yet goes straight to picking one.
  if (s.dblClick === 'app' && !s.openWith) s = (await api.pickApp()) || await api.setSettings({ dblClick: 'default' });
  showSettings({ ...s, platform: api.platform });
});

$('#btnPickApp').addEventListener('click', async () => {
  const s = await api.pickApp();
  if (!s) return;
  showSettings({ ...(await api.setSettings({ dblClick: 'app' })), platform: api.platform });
  toast(`Double-click now opens images in ${appLabel(s.openWith)}`);
});

$('#btnClearApp').addEventListener('click', async () => {
  const cur = await api.getSettings();
  showSettings({ ...(await api.setSettings({ openWith: null, dblClick: cur.dblClick === 'app' ? 'default' : cur.dblClick })), platform: api.platform });
});

// The window takes Escape while open.
window.addEventListener('keydown', e => {
  if ($('#settingsView').hidden) return;
  if (e.key === 'Escape') { e.stopImmediatePropagation(); closeSettings(); }
}, true);

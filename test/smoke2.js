const { app } = require('electron');
const path = require('path');
const fs = require('fs');
app.setPath('userData', path.join(__dirname, 'smoke-userdata'));
app.on('browser-window-created', (e, win) => {
  win.webContents.on('console-message', ev => console.log('[renderer]', ev.message));
  win.webContents.once('did-finish-load', async () => {
    const shot = async name => fs.writeFileSync(path.join(__dirname, 'out', name), (await win.webContents.capturePage()).toPNG());
    const js = code => win.webContents.executeJavaScript(code);
    const wait = ms => new Promise(r => setTimeout(r, ms));
    try {
      await wait(800);
      await js(`addPaths([${JSON.stringify(path.join(__dirname, 'in'))}])`); await wait(2500);
      await js(`selectFile(3); state.draft.watermark.enabled = true; state.draft.format='jpeg'; state.draft.targetEnabled=true; state.draft.targetKB=20; renderForm(); changed();
        document.querySelectorAll('details').forEach(d => d.open = true); document.querySelector('#settings').scrollTop = 900;`);
      await wait(2500); await shot('ui-5-settings-mid.png');
      await js(`document.querySelector('#settings').scrollTop = 5000`); await wait(300); await shot('ui-6-settings-end.png');
      await js(`document.querySelector('#modeToggle [data-mode=rename]').click()`); await wait(1500); await shot('ui-7-rename.png');
    } catch (err) { console.log('SMOKE ERROR', err); }
    app.quit();
  });
});
require('../src/main.js');

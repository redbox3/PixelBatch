// Drives contact sheet and PDF modes in the real UI: npx electron test/smoke3.js
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
      await js(`selectPreset(state.presets.findIndex(p => p.mode === 'sheet'), true); document.querySelector('#pvMode [data-mode=result]').click()`); await wait(3000);
      await shot('ui-8-sheet.png');
      await js(`selectPreset(state.presets.findIndex(p => p.mode === 'pdf'), true)`); await wait(300);
      await js(`state.draft.pdf.layout = 'grid'; state.draft.pdf.captions = true; state.draft.pdf.pageNumbers = true; state.draft.pdf.title = 'Grid “test” – page'; renderForm(); changed(); document.querySelector('#settings').scrollTop = 0;`);
      await wait(3500); await shot('ui-9-pdf-grid.png');
      await js(`state.draft.outputDir = ${JSON.stringify(path.join(__dirname, 'out', 'ui-pdf'))}; renderForm(); processAll()`);
      await wait(5000);
      console.log('summary', JSON.stringify(await js('state.lastSummary')));
      await shot('ui-10-pdf-done.png');
    } catch (err) { console.log('SMOKE ERROR', err); }
    app.quit();
  });
});
require('../src/main.js');

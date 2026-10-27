// Launches the real app, loads the sample files, and saves screenshots: npx electron test/smoke.js
const { app, BrowserWindow } = require('electron');
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
      await js(`addPaths([${JSON.stringify(path.join(__dirname, 'in'))}])`);
      await wait(3000);
      await shot('ui-1-grid.png');
      await js(`selectFile(3)`); await wait(2500);
      await js(`document.querySelector('#pvMode [data-mode=split]').click()`); await wait(500);
      await shot('ui-2-split.png');
      await js(`document.querySelector('#viewToggle [data-view=list]').click(); selectFile(1)`); await wait(2500);
      await js(`document.querySelector('#pvMode [data-mode=side]').click()`); await wait(300);
      await shot('ui-3-list-pdf.png');
      await js(`state.draft.outputDir = ${JSON.stringify(path.join(__dirname, 'out', 'ui-run'))}; renderForm(); processAll()`);
      await wait(6000);
      await shot('ui-4-done.png');
      console.log('summary', JSON.stringify(await js('state.lastSummary')));
    } catch (err) { console.log('SMOKE ERROR', err); }
    app.quit();
  });
});
require('../src/main.js');

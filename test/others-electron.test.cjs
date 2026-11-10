const assert = require('node:assert/strict');
const path = require('node:path');
const { app, BrowserWindow, ipcMain } = require('electron');

const root = path.resolve(__dirname, '..');
const config = {
  enabled: false,
  intervalMs: 600000,
  daily: true,
  bestTeam: true,
  mail: true,
  disabled: []
};
const accounts = [
  { index: 0, username: 'conta-teste', name: 'Conta teste', connected: true }
];
const log = [];
const stats = { runs: 0, processed: 0, succeeded: 0, failed: 0 };
let pollCount = 0;
let clearCount = 0;
let win;

ipcMain.on('app:version', event => { event.returnValue = '1.0.0'; });

const state = () => ({
  config: { ...config, disabled: [...config.disabled] },
  accounts,
  log: [...log],
  stats,
  limits: { minIntervalMs: 60000, maxIntervalMs: 21600000 }
});

ipcMain.handle('leveling:others:get', () => state());
ipcMain.handle('leveling:others:set', (_event, patch) => {
  Object.assign(config, patch);
  return { ok: true, ...state() };
});
ipcMain.handle('leveling:others:poll', () => {
  pollCount++;
  return { resultado: { ...stats }, ...state() };
});
ipcMain.handle('leveling:others:log-clear', () => {
  clearCount++;
  log.length = 0;
  return { ok: true };
});

const read = code => win.webContents.executeJavaScript(code);

app.whenReady().then(async () => {
  win = new BrowserWindow({
    width: 900,
    height: 700,
    show: false,
    webPreferences: {
      preload: path.join(root, 'preload.js'),
      backgroundThrottling: false
    }
  });
  await win.loadFile(path.join(root, 'outros.html'));

  assert.equal(await read('document.title'), 'Outros · Leveling Idle 2D');
  assert.equal(await read('document.querySelectorAll("#othersAccounts .lv-account").length'), 1);
  assert.equal(await read('document.querySelector("#othersStatus").textContent.includes("Rodadas: 0")'), true);

  await read('document.querySelector("[data-key=enabled]").click()');
  await read('document.querySelector("[data-key=enabled]").dispatchEvent(new Event("change", { bubbles: true }))');
  await new Promise(resolve => setTimeout(resolve, 250));
  assert.equal(config.enabled, true);

  await read('document.getElementById("othersPoll").click()');
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(pollCount, 1);

  await read('document.getElementById("othersClear").click()');
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(clearCount, 1);

  win.close();
  app.quit();
}).catch(error => {
  console.error(error && error.stack || error);
  app.exit(1);
});

/**
 * Mede o custo estrutural do modo monitor contra o modo WebView, no mesmo
 * processo e com a mesma janela.
 *
 * O monitor real precisa de credenciais, então aqui o `leveling:start` é
 * simulado: o que está em teste é o lado caro da troca — quantos processos
 * renderer o launcher mantém vivos em cada modo. É esse número que explica a
 * diferença de memória, e é o que regredia quando a WebView ficava parada em
 * `about:blank` em vez de ser removida.
 *
 *   npx electron test/mem-monitor.test.cjs
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, ipcMain, webContents } = require('electron');
const { labelProcesses, sample } = require('../src/main/memory-probe');

const root = path.resolve(__dirname, '..');
const output = path.join(root, 'scratch', 'mem-monitor-' + Date.now());
fs.mkdirSync(output, { recursive: true });
app.setPath('userData', path.join(output, 'profile'));
app.commandLine.appendSwitch('log-level', '3');
app.commandLine.appendSwitch('enable-precise-memory-info');

const errors = [];
const started = [];
let prefs = { panels: 4, keepAwake: false, bootMonitor: false };
const accounts = Array.from({ length: 4 }, () => ({
  username: 'conta',
  hasPassword: true,
  hasToken: false
}));

ipcMain.on('app:version', event => { event.returnValue = '1.0.0'; });
ipcMain.handle('app:game-url', () => 'about:blank');
ipcMain.handle('app:account-preload', () =>
  require('url').pathToFileURL(path.join(root, 'src', 'main', 'account-preload.js')).href);
ipcMain.handle('prefs:get', () => prefs);
ipcMain.handle('prefs:set', (_e, patch) => { prefs = { ...prefs, ...patch }; return prefs; });
ipcMain.handle('errlog:write', (_e, origem, msg) => errors.push(origem + ': ' + msg));
ipcMain.handle('errlog:open', () => true);
ipcMain.handle('window:control', () => ({ maximized: false }));
ipcMain.handle('shell:open-external', () => true);
ipcMain.handle('leveling:creds:get', () => ({ encrypted: true, accounts }));
ipcMain.handle('leveling:creds:set', () => ({ ok: true, status: { encrypted: true, accounts } }));
ipcMain.handle('leveling:creds:clear', () => ({ ok: true, status: { encrypted: true, accounts } }));
ipcMain.handle('leveling:status', () => ({ active: false, status: 'disconnected', state: null }));
ipcMain.handle('leveling:start', (_e, index) => { started.push(index); return { ok: true }; });
ipcMain.handle('leveling:stop', (_e, index) => {
  const at = started.indexOf(index);
  if (at >= 0) started.splice(at, 1);
  return { ok: true };
});

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let win;
const read = code => win.webContents.executeJavaScript(code);

/** Uma amostra com os mesmos rótulos que o probe usa em produção. */
function measure() {
  const all = webContents.getAllWebContents();
  const row = sample(app.getAppMetrics(), labelProcesses(all), {});
  const contas = row.procs.filter(p => p.label.startsWith('conta'));
  return {
    totalPriv: row.totalPriv,
    renderers: contas.length,
    contasPriv: Math.round(contas.reduce((sum, p) => sum + p.priv, 0))
  };
}

async function ready() {
  for (let i = 0; i < 80; i++) {
    if (await read('!!window.PioShell && window.PioShell.panels.length === 4')) return;
    await pause(100);
  }
  throw new Error('Shell did not initialize: ' + errors.join('\n'));
}

app.whenReady().then(async () => {
  win = new BrowserWindow({
    width: 1600, height: 1000, show: false,
    webPreferences: {
      offscreen: true, webviewTag: true,
      preload: path.join(root, 'preload.js'), backgroundThrottling: false
    }
  });
  await win.loadFile(path.join(root, 'index.html'));
  await ready();
  await pause(1500);

  const webviewMode = measure();
  assert.equal(webviewMode.renderers, 4, 'Four panels must mean four game renderers');

  // Liga o monitor nas quatro contas, como o modo de consumo mínimo faz.
  await read('window.PioShell.startMonitors()');
  await pause(2500);

  const monitorMode = measure();
  assert.deepEqual(started, [0, 1, 2, 3], 'Every visible account must hand over to the monitor');
  assert.equal(monitorMode.renderers, 0,
    'Monitor mode must keep no game renderer alive; found ' + monitorMode.renderers);
  assert.equal(monitorMode.contasPriv, 0, 'No account process may survive the handover');
  assert.ok(monitorMode.totalPriv < webviewMode.totalPriv,
    `Monitor mode must cost less: ${monitorMode.totalPriv} MB vs ${webviewMode.totalPriv} MB`);

  // E volta: desligar o monitor devolve a conta ao jogo.
  await read('window.PioShell.toggleHeadless(0)');
  await pause(2000);
  assert.equal(measure().renderers, 1, 'Stopping one monitor must restore exactly one renderer');

  // Aqui a página é `about:blank`: a economia real é maior, porque o jogo
  // carregado custa bem mais que um renderer vazio. O que este teste garante é
  // que nenhum renderer sobrevive ao handover.
  const saved = Math.round(webviewMode.totalPriv - monitorMode.totalPriv);
  console.log(
    `PASS: webview ${webviewMode.totalPriv} MB (${webviewMode.renderers} renderers, ` +
    `contas ${webviewMode.contasPriv} MB) -> monitor ${monitorMode.totalPriv} MB ` +
    `(0 renderers) · economia ${saved} MB`
  );

  const fatal = errors.filter(e => !/favicon|ERR_FILE_NOT_FOUND|ERR_ABORTED/i.test(e));
  assert.deepEqual(fatal, [], 'Renderer must not log errors: ' + fatal.join('\n'));
  app.quit();
}).catch(err => {
  console.error('FAIL:', err && err.stack || err);
  app.exit(1);
});

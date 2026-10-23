/**
 * Valida a shell no DOM real do Electron.
 *
 * Os canais `leveling:*` são simulados aqui, então nada toca o servidor do
 * jogo: o que está em teste é a interface e o contrato do IPC. `app:game-url`
 * devolve `about:blank` de propósito — o teste não deve depender de rede.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, ipcMain } = require('electron');

const root = path.resolve(__dirname, '..');
const output = path.join(root, 'scratch', 'shell-' + Date.now());
fs.mkdirSync(output, { recursive: true });
app.setPath('userData', path.join(output, 'profile'));
app.commandLine.appendSwitch('log-level', '3');

const errors = [];
const empty = () => ({ username: '', hasPassword: false, hasToken: false });
const store = Array.from({ length: 4 }, empty);
const publicStatus = () => ({ encrypted: true, accounts: store.map(a => ({ ...a })) });
const started = [];
let prefs = { panels: 4, tabs: 1, activeTab: 0, tabPrefs: [], keepAwake: false };

ipcMain.on('app:version', event => { event.returnValue = '1.0.0'; });
ipcMain.handle('app:game-url', () => 'about:blank');
// Preload real: sem ele a WebView montaria sem o caminho de volta do token.
ipcMain.handle('app:account-preload', () =>
  require('url').pathToFileURL(path.join(root, 'src', 'main', 'account-preload.js')).href);
ipcMain.handle('prefs:get', () => prefs);
ipcMain.handle('prefs:set', (_e, patch) => {
  prefs = { ...prefs, ...patch };
  // Como no principal: a aba nova só existe depois dos slots de credencial, e
  // ganha uma entrada de preferências própria herdando o padrão da raiz.
  while (store.length < prefs.tabs * 4) store.push(empty());
  prefs.tabPrefs = Array.from({ length: prefs.tabs }, (_, t) => ({
    panels: 4, bootMonitor: false, ...(prefs.tabPrefs || [])[t]
  }));
  return prefs;
});
ipcMain.handle('errlog:write', (_e, origem, msg) => errors.push(origem + ': ' + msg));
ipcMain.handle('errlog:open', () => true);
ipcMain.handle('window:control', () => ({ maximized: false }));
ipcMain.handle('shell:open-external', () => true);

ipcMain.handle('leveling:creds:get', () => publicStatus());
ipcMain.handle('leveling:creds:set', (_e, index, username, password) => {
  store[index] = { username, hasPassword: !!password, hasToken: false };
  return { ok: true, status: publicStatus() };
});
ipcMain.handle('leveling:creds:clear', (_e, index) => {
  store[index] = { username: '', hasPassword: false, hasToken: false };
  return { ok: true, status: publicStatus() };
});
ipcMain.handle('leveling:status', () => ({ active: false, status: 'disconnected', state: null }));
ipcMain.handle('leveling:start', (_e, index) => {
  if (!store[index].hasPassword) return { ok: false, error: 'Credenciais não configuradas.' };
  started.push(index);
  return { ok: true };
});
ipcMain.handle('leveling:stop', (_e, index) => {
  const at = started.indexOf(index);
  if (at >= 0) started.splice(at, 1);
  return { ok: true };
});

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let win;
const read = code => win.webContents.executeJavaScript(code);

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
  await pause(400);

  // 1. Quatro painéis, cada um com a sua partição de sessão.
  const parts = await read('window.PioShell.panels.map(p => p.view && p.view.partition)');
  assert.deepEqual(parts, ['persist:conta1', 'persist:conta2', 'persist:conta3', 'persist:conta4'],
    'Each panel must keep its own session partition');

  // 2. Painel escondido não guarda uma WebView viva: ela custa um processo
  // renderer inteiro, mesmo em branco.
  await read('window.PioShell.applyPanelCount(2)');
  const hidden = await read('window.PioShell.panels.map(p => p.root.hidden)');
  assert.deepEqual(hidden, [false, false, true, true], 'Panel count must hide the extra panels');
  const views = await read('window.PioShell.panels.map(p => !!p.view)');
  assert.deepEqual(views, [true, true, false, false], 'Hidden panels must not keep a renderer alive');

  // `display: flex` venceria o atributo `hidden`, e o painel escondido ficaria
  // ocupando a célula como um retângulo preto.
  const display = await read(
    'window.PioShell.panels.map(p => getComputedStyle(p.root).display)');
  assert.deepEqual(display, ['flex', 'flex', 'none', 'none'],
    'Hidden panels must leave the grid, not sit there blank');

  await read('window.PioShell.applyPanelCount(4)');
  await pause(200);
  const restored = await read('window.PioShell.panels.map(p => !!p.view)');
  assert.deepEqual(restored, [true, true, true, true], 'Showing a panel again must recreate its WebView');

  // 3. Sem credencial, ligar o monitor abre o modal em vez de fingir que ligou.
  await read('window.PioShell.toggleHeadless(0)');
  await pause(300);
  assert.deepEqual(started, [], 'Monitor must not start without credentials');
  const modalOpen = await read('document.getElementById("levelingOverlay").classList.contains("show")');
  assert.equal(modalOpen, true, 'Missing credentials must send the user to the accounts modal');

  // 4. Salvar credencial: a senha não pode sobrar no DOM.
  await read(`(async () => {
    const card = document.querySelector("#levelingAccounts .lv-account[data-index='0']");
    card.querySelector("[data-role='user']").value = 'desjunior';
    card.querySelector("[data-role='pass']").value = 'senha-de-teste';
    await window.PioLeveling.save(0);
  })()`);
  await pause(300);

  assert.equal(store[0].username, 'desjunior', 'Username must reach the main process');
  const secretInDom = await read('document.body.innerHTML.includes("senha-de-teste")');
  assert.equal(secretInDom, false, 'Password must never remain in the markup');

  await read('window.PioShell.closeAccounts()');

  // 5. Agora o monitor liga, o HUD cobre o painel e a WebView sai do jogo.
  await read('window.PioShell.toggleHeadless(0)');
  await pause(300);
  assert.deepEqual(started, [0], 'Main process must receive leveling:start');

  const covered = await read('window.PioShell.panels[0].root.classList.contains("is-headless")');
  assert.equal(covered, true, 'HUD must cover the panel while the monitor runs');

  // A WebView é descartada, não apenas apontada para about:blank: é o que
  // libera o processo renderer e faz o modo monitor custar quase nada.
  const viewGone = await read('window.PioShell.panels[0].view === null');
  assert.equal(viewGone, true, 'WebView must be destroyed so the monitor costs only the socket');

  // 6. O HUD pinta as colunas que o adapter do Leveling declara.
  await read(`window.PioShell.panels[0].hud.update({
    game: 'leveling-idle', name: 'desjunior', level: 41, hp: 600, maxHp: 3000,
    hunt: { gateId: 'castelo-demonios', kills: 248, streak: 86, bestStreak: 35672, wave: 7, tierMin: 31 },
    a: { seconds: 3725, xph: 376634, goldph: 91000 }
  })`);
  await pause(150);

  const labels = await read('[...document.querySelectorAll(".panel[data-index=\'0\'] .lh-cell .lh-label")].map(e => e.textContent)');
  assert.ok(labels.includes('Abates'), 'Leveling metrics must render: ' + labels.join(', '));
  assert.equal(labels.includes('Pokébolas'), false, 'PokeIdle columns must not leak into this launcher');

  const name = await read('document.querySelector(".panel[data-index=\'0\'] .lh-name").textContent');
  assert.equal(name, 'desjunior', 'HUD must show the character identity');

  const hpLow = await read('document.querySelector(".panel[data-index=\'0\'] .lh-hp span").className');
  assert.equal(hpLow, 'is-low', 'HP bar must warn below 25%');

  // 7. Morte é só aviso: nenhum botão de ação, o revive é do servidor.
  await read(`window.PioShell.panels[0].hud.update({
    game: 'leveling-idle', death: { dead: true, xpLost: 1200 }, hunt: {}, a: {}
  })`);
  const alert = await read('document.querySelector(".panel[data-index=\'0\'] .lh-alert").textContent');
  assert.match(alert, /reviver automático/, 'Death must be reported, not acted upon');

  // 8. Janela escondida: o estado é guardado em vez de repintado, e aplicado
  // de uma vez quando ela volta. Sem isso os HUDs desenhariam para ninguém.
  win.webContents.send('window:visible', false);
  await pause(150);
  // Ponta de prova no lugar do desenho real; o retorno tem de ser clonável.
  await read(`(() => {
    window.__painted = 0;
    window.PioShell.panels[0].hud.update = () => { window.__painted++; };
    return true;
  })()`);
  win.webContents.send('leveling:update', [{
    index: 0,
    state: { game: 'leveling-idle', name: 'escondido', hunt: { kills: 5 }, a: {} }
  }]);
  await pause(150);
  assert.equal(await read('window.__painted || 0'), 0, 'Hidden window must not repaint the HUD');

  win.webContents.send('window:visible', true);
  await pause(150);
  assert.equal(await read('window.__painted || 0'), 1, 'Returning must flush the last known state once');

  // 9. Desligar devolve o painel para a WebView do jogo.
  await read('window.PioShell.toggleHeadless(0)');
  await pause(300);
  assert.deepEqual(started, [], 'Main process must receive leveling:stop');
  const released = await read('window.PioShell.panels[0].root.classList.contains("is-headless")');
  assert.equal(released, false, 'Panel must return to the WebView after stopping');
  const viewBack = await read('!!window.PioShell.panels[0].view');
  assert.equal(viewBack, true, 'Stopping the monitor must bring the game WebView back');

  // 10. Abas: a grade continua com quatro painéis, mas aponta para o grupo
  // seguinte de contas, cada uma com a sua própria partição.
  await read('window.PioShell.setTabCount(2)');
  await pause(300);
  assert.equal(prefs.tabs, 2, 'Adding a tab must be persisted by the main process');
  assert.equal(store.length, 8, 'A new tab must allocate four more credential slots');

  await read('window.PioShell.selectTab(1)');
  await pause(400);

  const tabAccounts = await read('window.PioShell.panels.map(p => p.account)');
  assert.deepEqual(tabAccounts, [4, 5, 6, 7], 'The second tab must drive accounts 5 to 8');

  const tabParts = await read('window.PioShell.panels.map(p => p.view && p.view.partition)');
  assert.deepEqual(tabParts, ['persist:conta5', 'persist:conta6', 'persist:conta7', 'persist:conta8'],
    'Accounts in the second tab must keep their own sessions');

  // Uma conta de aba escondida não pode arrastar o renderer dela junto: trocar
  // de aba só mantém o monitor, nunca a WebView.
  const panelCount = await read('window.PioShell.panels.length');
  assert.equal(panelCount, 4, 'More accounts must not mean more panels');

  // 11. O monitor não conhece abas: ele segue rodando na aba escondida.
  await read(`(async () => {
    const card = document.querySelector("#levelingAccounts .lv-account[data-index='4']");
    card.querySelector("[data-role='user']").value = 'quinta';
    card.querySelector("[data-role='pass']").value = 'senha-de-teste';
    await window.PioLeveling.save(4);
  })()`);
  await pause(300);
  await read('window.PioShell.toggleHeadless(4)');
  await pause(300);
  assert.deepEqual(started, [4], 'Monitor must start for the global account index');

  await read('window.PioShell.selectTab(0)');
  await pause(400);
  assert.deepEqual(started, [4], 'Switching tabs must not stop a running monitor');

  await read('window.PioShell.selectTab(1)');
  await pause(400);
  const stillCovered = await read('window.PioShell.panels[0].root.classList.contains("is-headless")');
  assert.equal(stillCovered, true, 'Returning to the tab must show the monitor still running');

  // 12. Painéis e boot em monitor são da aba: cada grupo de contas tem um uso
  // próprio, e a escolha precisa voltar ao trocar de aba.
  await read(`(async () => {
    const count = document.getElementById('panelCount');
    count.value = '1';
    await count.onchange();
  })()`);
  await pause(300);
  assert.equal(await read('window.PioShell.panels[1].root.hidden'), true,
    'Choosing one panel must hide the others in this tab');

  await read('window.PioShell.selectTab(0)');
  await pause(400);
  assert.equal(await read('window.PioShell.panels[1].root.hidden'), false,
    'The other tab must keep its own panel count');
  assert.equal(await read('document.getElementById("panelCount").value'), '4',
    'The selector must follow the active tab');

  await read('window.PioShell.selectTab(1)');
  await pause(400);
  assert.equal(await read('window.PioShell.panels[1].root.hidden'), true,
    'Returning to the tab must restore its panel count');
  assert.equal(await read('window.PioShell.tabPrefs(1).panels'), 1,
    'Panel count must be stored per tab');

  // Volta para quatro: o resto do teste conta com a aba cheia.
  await read(`(async () => {
    const count = document.getElementById('panelCount');
    count.value = '4';
    await count.onchange();
  })()`);
  await pause(300);

  // 13. Remover a aba não pode deixar um monitor rodando fora de alcance.
  assert.deepEqual(started, [4], 'Account 5 must still be monitoring before the tab is removed');

  await read('window.PioShell.setTabCount(1)');
  await pause(400);
  assert.deepEqual(started, [], 'Removing a tab must stop monitors that would become unreachable');
  assert.equal(await read('window.PioShell.panels[0].account'), 0, 'Removing the active tab must fall back');

  const fatal = errors.filter(e => !/favicon|ERR_FILE_NOT_FOUND/i.test(e));
  assert.deepEqual(fatal, [], 'Renderer must not log errors: ' + fatal.join('\n'));

  console.log('PASS: shell mounts four isolated panels, scales to more accounts through tabs, stores credentials safely, and hands the panel over to the read-only monitor and back.');
  app.quit();
}).catch(err => {
  console.error('FAIL:', err && err.stack || err);
  app.exit(1);
});

/**
 * @file preload.js
 * Ponte entre o renderer e o processo principal.
 *
 * O nome `pokeAPI` é herdado do launcher irmão de propósito: os módulos de UI
 * (`leveling-panel.js`, `hud-metrics.js`) e as suites de teste são os mesmos
 * arquivos, e renomear a ponte obrigaria a manter duas versões de cada um.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pokeAPI', {
  gameUrl: () => ipcRenderer.invoke('app:game-url'),
  // Preload da WebView: injeta o token salvo antes de o jogo carregar.
  accountPreload: () => ipcRenderer.invoke('app:account-preload'),

  getPrefs: () => ipcRenderer.invoke('prefs:get'),
  setPrefs: (patch) => ipcRenderer.invoke('prefs:set', patch),

  levelingStart: (index) => ipcRenderer.invoke('leveling:start', index),
  levelingStop: (index) => ipcRenderer.invoke('leveling:stop', index),
  levelingStatus: (index) => ipcRenderer.invoke('leveling:status', index),
  levelingGetCreds: () => ipcRenderer.invoke('leveling:creds:get'),
  levelingSetCreds: (index, username, password) => ipcRenderer.invoke('leveling:creds:set', index, username, password),
  levelingClearCreds: (index) => ipcRenderer.invoke('leveling:creds:clear', index),
  levelingSetProxy: (index, proxy) => ipcRenderer.invoke('leveling:proxy:set', index, proxy),

  // Auto-refill: uma configuração para todas as contas, sem índice.
  levelingGetRefill: () => ipcRenderer.invoke('leveling:refill:get'),
  levelingSetRefill: (config) => ipcRenderer.invoke('leveling:refill:set', config),

  // O principal envia um lote por janela de tempo; aceitar também o formato
  // avulso mantém `leveling-panel.js` compartilhado com o launcher irmão.
  onLevelingUpdate: (cb) => ipcRenderer.on('leveling:update', (_e, data) => {
    if (Array.isArray(data)) for (const item of data) cb(item);
    else cb(data);
  }),
  onLevelingStatus: (cb) => ipcRenderer.on('leveling:status', (_e, data) => cb(data)),
  onLevelingEnded: (cb) => ipcRenderer.on('leveling:ended', (_e, data) => cb(data)),
  onLevelingDeath: (cb) => ipcRenderer.on('leveling:death', (_e, data) => cb(data)),
  onLevelingArise: (cb) => ipcRenderer.on('leveling:arise', (_e, data) => cb(data)),
  onLevelingRefill: (cb) => ipcRenderer.on('leveling:refill', (_e, data) => cb(data)),

  windowControl: (action) => ipcRenderer.invoke('window:control', action),
  // Janela escondida: a interface para de repintar o que ninguém vê.
  onWindowVisible: (cb) => ipcRenderer.on('window:visible', (_e, visible) => cb(visible)),
  openExternal: (url) => ipcRenderer.invoke('shell:open-external', url),

  logError: (origem, msg) => ipcRenderer.invoke('errlog:write', origem, msg),
  openErrorLog: () => ipcRenderer.invoke('errlog:open'),

  // sendSync: o badge de versão precisa estar pronto no primeiro paint, e o
  // preload roda em sandbox, então ler o package.json aqui não é confiável.
  appVersion: (() => { try { return ipcRenderer.sendSync('app:version'); } catch { return ''; } })()
});

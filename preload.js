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

  // Grupo: monta uma PT com as contas da aba que já estão em modo monitor.
  levelingAssembleParty: (indexes) => ipcRenderer.invoke('leveling:party:assemble', indexes),
  onLevelingPartyStep: (cb) => ipcRenderer.on('leveling:party-step', (_e, data) => cb(data)),

  // Troca de caçada sem sair do modo monitor. `indexes` aceita uma conta só ou
  // várias: é a mesma operação, e é a interface que decide o escopo.
  levelingGetHunts: () => ipcRenderer.invoke('leveling:hunts:get'),
  levelingSetHunt: (indexes, ticket) => ipcRenderer.invoke('leveling:hunt:set', indexes, ticket),
  // O catálogo só existe depois do primeiro login; avisar preenche um seletor
  // que já estava aberto sem a lista.
  onLevelingHunts: (cb) => ipcRenderer.on('leveling:hunts', (_e, data) => cb(data)),

  // Mercado: o servidor só mostra os últimos ~30 min de vendas, então o
  // launcher coleta de minuto em minuto e acumula num banco local. Tudo aqui
  // lê desse banco, menos `Hint`, que pergunta ao servidor.
  marketSummary: (opts) => ipcRenderer.invoke('leveling:market:summary', opts),
  marketRecent: (opts) => ipcRenderer.invoke('leveling:market:recent', opts),
  marketItem: (defId, opts) => ipcRenderer.invoke('leveling:market:item', defId, opts),
  marketHint: (defId, days) => ipcRenderer.invoke('leveling:market:hint', defId, days),
  marketPoll: () => ipcRenderer.invoke('leveling:market:poll'),
  marketStats: () => ipcRenderer.invoke('leveling:market:stats'),
  // Ícones e cores de raridade, recortados do catálogo do jogo.
  marketCatalog: () => ipcRenderer.invoke('leveling:market:catalog'),
  // Anúncios à venda agora: a única fonte de nível de item e potência de sombra.
  marketListings: (filtros) => ipcRenderer.invoke('leveling:market:listings', filtros),
  // Quem das minhas contas tem cada item, e quanto.
  marketOwners: (defIds) => ipcRenderer.invoke('leveling:market:owners', defIds),
  // O inventário inteiro das contas, já cruzado com o preço de mercado.
  marketBag: (opts) => ipcRenderer.invoke('leveling:market:bag', opts),
  // O inventário de uma conta, item por item e com preço sugerido: a aba
  // "Anunciar". Por instância, não agregado — `MarketCreate` exige o uid.
  marketSellable: (opts) => ipcRenderer.invoke('leveling:market:sellable', opts),
  // Cria os anúncios confirmados. Tolerante a falha parcial: o resultado vem
  // linha a linha, porque um item recusado não invalida os que entraram.
  marketAnnounce: (payload) => ipcRenderer.invoke('leveling:market:announce', payload),
  // Preço por nível: "Topázio de nível 1 ou 4?" são itens de preços diferentes.
  marketLevels: (defId, opts) => ipcRenderer.invoke('leveling:market:levels', defId, opts),
  // O nível das vendas que estão na tela, por listing_id. A aba "Ao vivo"
  // mostra as vendas mais novas, que são justo as que ninguém perguntou ainda.
  marketLevelsFor: (listingIds) => ipcRenderer.invoke('leveling:market:levels-for', listingIds),
  // Abre o mercado em janela própria, para dar para olhar o preço e mexer no
  // jogo ao mesmo tempo — o que um modal sobre o launcher não permitia.
  // Anúncios ativos e vendas de cada conta: a aba "Meus anúncios". Os ativos
  // vêm do servidor; as vendas, do banco local, porque o servidor não guarda
  // a lista das vendas de uma conta.
  marketMine: (opts) => ipcRenderer.invoke('leveling:market:mine', opts),
  marketWindow: () => ipcRenderer.invoke('leveling:market:window'),
  marketWindowClose: () => ipcRenderer.invoke('leveling:market:window-close'),
  onMarketCatalog: (cb) => ipcRenderer.on('leveling:market-catalog', (_e, data) => cb(data)),
  // Avisa que entraram vendas novas; a aba aberta se atualiza sozinha.
  onMarket: (cb) => ipcRenderer.on('leveling:market', (_e, data) => cb(data)),
  onMarketSold: (cb) => ipcRenderer.on('leveling:market-sold', (_e, data) => cb(data)),

  // Sniper: compra sozinho o item que entrar abaixo do teto. A configuração
  // inteira vai e volta junta — o interruptor é um campo dela, não um canal
  // próprio, para a tela nunca mostrar "ligado" com regras não salvas.
  sniperGet: () => ipcRenderer.invoke('leveling:sniper:get'),
  sniperSet: (config) => ipcRenderer.invoke('leveling:sniper:set', config),
  // Acrescenta uma regra sem mandar a configuração inteira. É o caminho do
  // botão "Adicionar ao sniper" da janela do mercado, que não conhece as
  // outras regras e as apagaria se usasse `sniperSet`.
  sniperAdd: (rule) => ipcRenderer.invoke('leveling:sniper:add', rule),
  sniperPoll: () => ipcRenderer.invoke('leveling:sniper:poll'),
  sniperLog: () => ipcRenderer.invoke('leveling:sniper:log'),
  sniperLogClear: () => ipcRenderer.invoke('leveling:sniper:log-clear'),
  sniperWindow: () => ipcRenderer.invoke('leveling:sniper:window'),
  // Uma linha de log por acontecimento: anunciado, comprado, ou levado por
  // outra pessoa. A tela aberta acompanha sem perguntar.
  onSniper: (cb) => ipcRenderer.on('leveling:sniper', (_e, data) => cb(data)),

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

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
  // Apaga a conta inteira: credencial, sessão, proxy, vendas e preferências.
  levelingWipeAccount: (index) => ipcRenderer.invoke('leveling:creds:wipe', index),
  
  // Pool de proxies
  levelingProxyImport: (text) => ipcRenderer.invoke('leveling:proxy:import', text),
  levelingProxyPool: () => ipcRenderer.invoke('leveling:proxy:pool'),
  levelingProxyTest: (proxyId) => ipcRenderer.invoke('leveling:proxy:test', proxyId),
  levelingProxyRemove: (proxyId) => ipcRenderer.invoke('leveling:proxy:remove', proxyId),

  // Assistente de cadastro. Monta e guarda o plano; o cadastro em si acontece
  // na aba do jogo, porque o captcha exige o navegador.
  levelingSignupClasses: () => ipcRenderer.invoke('leveling:signup:classes'),
  levelingSignupPlan: (opts) => ipcRenderer.invoke('leveling:signup:plan', opts),
  levelingSignupSave: () => ipcRenderer.invoke('leveling:signup:save'),
  // Janela de cadastro da conta: roda na partição dela, logo já sai pelo proxy
  // da conta e o login fica guardado onde a WebView do painel vai ler.
  levelingSignupTab: (index) => ipcRenderer.invoke('leveling:signup:tab', index),
  // A conta nova entrou em modo monitor sozinha, depois dos modais.
  onSignupMonitor: (cb) => ipcRenderer.on('leveling:signup:monitor', (_e, data) => cb(data)),
  // Apaga credencial e sessão das contas a partir de um slot. Usado ao remover
  // abas: a conta 1 nunca é apagada.
  levelingClearCredsFrom: (from) => ipcRenderer.invoke('leveling:creds:clear-from', from),
  // As duas janelas novas fecham pelo mesmo handler do mercado: ele fecha a
  // janela do remetente, não a do mercado especificamente.
  signupWindowClose: () => ipcRenderer.invoke('leveling:market:window-close'),
  proxiesWindowClose: () => ipcRenderer.invoke('leveling:market:window-close'),
  
  // Evento quando credencial é capturada pela WebView
  onCredsCaptured: (cb) => ipcRenderer.on('leveling:creds:captured', (_e, data) => cb(data)),
  // O assistente guardou um plano: o launcher abre as abas das contas
  // reservadas, cada uma já na sua rota e com o formulário preenchido.
  onSignupReady: (cb) => ipcRenderer.on('leveling:signup:ready', (_e, data) => cb(data)),
  // O cadastro é sequencial: o principal abre uma janela por vez e narra onde
  // a fila está, para o painel não parecer travado entre dois captchas.
  onSignupProgress: (cb) => ipcRenderer.on('leveling:signup:progress', (_e, data) => cb(data)),

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
  // Retira um anúncio. Um por chamada e com confirmação na tela: é escrita, e
  // `toMail` na resposta diz quando o item foi para a caixa em vez da mochila
  // — sem esse aviso o usuário procura a peça e conclui que ela se perdeu.
  marketCancel: (payload) => ipcRenderer.invoke('leveling:market:cancel', payload),
  marketWindow: () => ipcRenderer.invoke('leveling:market:window'),
  marketWindowClose: () => ipcRenderer.invoke('leveling:market:window-close'),
  onMarketCatalog: (cb) => ipcRenderer.on('leveling:market-catalog', (_e, data) => cb(data)),
  // Avisa que entraram vendas novas; a aba aberta se atualiza sozinha.
  onMarket: (cb) => ipcRenderer.on('leveling:market', (_e, data) => cb(data)),
  onMarketSold: (cb) => ipcRenderer.on('leveling:market-sold', (_e, data) => cb(data)),

  // Proxies: gerenciar pool de proxies em janela separada
  proxiesWindow: () => ipcRenderer.invoke('leveling:proxies:window'),

  // Cadastro assistido: criar contas em lote
  signupWindow: () => ipcRenderer.invoke('leveling:signup:window'),

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
  sniperAccountGet: () => ipcRenderer.invoke('leveling:sniper-account:get'),
  sniperAccountSet: (username, password, proxy) => ipcRenderer.invoke('leveling:sniper-account:set', username, password, proxy),
  sniperAccountIp: () => ipcRenderer.invoke('leveling:sniper-account:ip'),
  // Uma linha de log por acontecimento: anunciado, comprado, ou levado por
  // outra pessoa. A tela aberta acompanha sem perguntar.
  onSniper: (cb) => ipcRenderer.on('leveling:sniper', (_e, data) => cb(data)),

  // Auto-refill: uma configuração para todas as contas, sem índice.
  levelingGetRefill: () => ipcRenderer.invoke('leveling:refill:get'),
  levelingSetRefill: (config) => ipcRenderer.invoke('leveling:refill:set', config),

  // Auto-expedição: recolhe o que terminou e manda a sombra mais forte do
  // armazém para o destino mais baixo, pelo maior tempo que a conta alcança.
  // `force` relê o painel de cada conta no servidor; sem ele a resposta usa o
  // último painel que o laço já leu, que vale por um minuto.
  expeditionGet: (opts) => ipcRenderer.invoke('leveling:expedition:get', opts),
  expeditionSet: (config) => ipcRenderer.invoke('leveling:expedition:set', config),
  expeditionPoll: () => ipcRenderer.invoke('leveling:expedition:poll'),
  expeditionWindow: () => ipcRenderer.invoke('leveling:expedition:window'),
  // Uma coleta ou um envio aconteceu: a janela aberta se atualiza sozinha.
  onExpedition: (cb) => ipcRenderer.on('leveling:expedition', (_e, data) => cb(data)),

  // Auto-boss diário: faz todos os bosses do dia em cada conta, do mais fraco
  // ao mais forte, e devolve a conta à caçada no fim. `force` relê o estado de
  // cada conta no servidor; sem ele a resposta usa a última leitura, porque o
  // estado muda uma vez por dia.
  bossGet: (opts) => ipcRenderer.invoke('leveling:boss:get', opts),
  bossSet: (config) => ipcRenderer.invoke('leveling:boss:set', config),
  // `force` na rodada ignora o dia já feito; o servidor ainda recusa o boss que
  // já saiu, então forçar nunca gasta a tentativa duas vezes.
  bossPoll: (opts) => ipcRenderer.invoke('leveling:boss:poll', opts),
  bossWindow: () => ipcRenderer.invoke('leveling:boss:window'),
  // Uma rodada de boss terminou numa conta: a janela aberta se atualiza sozinha.
  onBoss: (cb) => ipcRenderer.on('leveling:boss', (_e, data) => cb(data)),

  // Auto-anunciar: preenche as vagas de anúncio de cada conta com o tesouro da
  // bolsa e recolhe do correio o ouro das vendas. A configuração inteira vai e
  // volta junta, como no sniper — e por um motivo a mais: o piso de preço e o
  // interruptor só fazem sentido juntos, e salvar um sem o outro deixaria o
  // launcher vendendo com um piso que a tela não está mostrando.
  autosellGet: () => ipcRenderer.invoke('leveling:autosell:get'),
  autosellSet: (config) => ipcRenderer.invoke('leveling:autosell:set', config),
  // Uma rodada agora. É escrita, e o teto de itens por rodada vale aqui igual.
  autosellPoll: () => ipcRenderer.invoke('leveling:autosell:poll'),
  // O picker da lista de bloqueio: o que as contas têm na bolsa e que o
  // auto-anunciar venderia. Sob demanda — é uma varredura de bolsa por conta.
  autosellCandidates: () => ipcRenderer.invoke('leveling:autosell:candidates'),
  // Uma caixinha do picker. Canal próprio para não reenviar a configuração
  // inteira a cada item marcado.
  autosellBlock: (payload) => ipcRenderer.invoke('leveling:autosell:block', payload),
  autosellLog: () => ipcRenderer.invoke('leveling:autosell:log'),
  autosellLogClear: () => ipcRenderer.invoke('leveling:autosell:log-clear'),
  autosellWindow: () => ipcRenderer.invoke('leveling:autosell:window'),
  // Cada anúncio ou resgate empurra uma linha: a janela aberta acompanha sem
  // perguntar.
  onAutosell: (cb) => ipcRenderer.on('leveling:autosell', (_e, data) => cb(data)),

  othersGet: () => ipcRenderer.invoke('leveling:others:get'),
  othersSet: (config) => ipcRenderer.invoke('leveling:others:set', config),
  othersPoll: () => ipcRenderer.invoke('leveling:others:poll'),
  othersLogClear: () => ipcRenderer.invoke('leveling:others:log-clear'),
  othersWindow: () => ipcRenderer.invoke('leveling:others:window'),
  onOthers: (cb) => ipcRenderer.on('leveling:others', (_e, data) => cb(data)),

  // Câmbio: desce o ouro de todas as contas pela cadeia até a que concentra
  // tudo, uma troca por vez. A configuração inteira vai e volta junta, como nas
  // outras — aqui com o motivo mais forte da lista: destino, reserva e
  // intervalo só fazem sentido juntos, e salvar o destino sem a reserva deixaria
  // o launcher esvaziando contas que o usuário não autorizou esvaziar.
  cambioGet: () => ipcRenderer.invoke('leveling:cambio:get'),
  cambioSet: (config) => ipcRenderer.invoke('leveling:cambio:set', config),
  // Um hop agora, sem esperar o intervalo. Move ouro de verdade; as guardas de
  // reserva e conferência valem aqui igual.
  cambioPoll: () => ipcRenderer.invoke('leveling:cambio:poll'),
  // Resgata o correio de todas as contas em monitor. Nada sai das contas: o
  // ouro de venda estava parado na caixa e passa para o saldo da mesma conta.
  cambioMail: () => ipcRenderer.invoke('leveling:cambio:mail'),
  cambioLog: () => ipcRenderer.invoke('leveling:cambio:log'),
  cambioLogClear: () => ipcRenderer.invoke('leveling:cambio:log-clear'),
  cambioWindow: () => ipcRenderer.invoke('leveling:cambio:window'),
  // Cada hop empurra uma linha: a janela aberta acompanha sem perguntar.
  onCambio: (cb) => ipcRenderer.on('leveling:cambio', (_e, data) => cb(data)),

  // Status: gasta os pontos de cada nível na build escolhida para a conta. A
  // configuração inteira vai e volta junta, como nas outras, e aqui ela carrega
  // a escolha de **cada** conta dentro de `porConta` — classe e build não têm
  // valor global que sirva, e salvar uma conta por vez abriria a janela em que
  // metade das contas roda com a build antiga.
  statsGet: () => ipcRenderer.invoke('leveling:stats:get'),
  statsSet: (config) => ipcRenderer.invoke('leveling:stats:set', config),
  // Distribui agora, sem esperar a próxima subida de nível. Gasta ponto de
  // verdade: desfazer custa token de respec ou cristal.
  statsRun: () => ipcRenderer.invoke('leveling:stats:run'),
  statsLog: () => ipcRenderer.invoke('leveling:stats:log'),
  statsLogClear: () => ipcRenderer.invoke('leveling:stats:log-clear'),
  statsWindow: () => ipcRenderer.invoke('leveling:stats:window'),
  // Cada distribuição avisa: a janela aberta acompanha sem perguntar.
  onStats: (cb) => ipcRenderer.on('leveling:stats', (_e, data) => cb(data)),

  // Auto-forja. `force` relê a bolsa de cada conta: sem ele a resposta usa o
  // resumo que a última rodada já apurou, em vez de doze páginas por conta.
  forgeGet: (options) => ipcRenderer.invoke('leveling:forge:get', options),
  forgeSet: (config) => ipcRenderer.invoke('leveling:forge:set', config),
  // Forja agora, sem esperar o próximo drop. **Apaga peças**: o desmonte não
  // tem desfazer nenhum, nem pagando.
  forgeRun: () => ipcRenderer.invoke('leveling:forge:run'),
  forgeLog: () => ipcRenderer.invoke('leveling:forge:log'),
  forgeLogClear: () => ipcRenderer.invoke('leveling:forge:log-clear'),
  forgeWindow: () => ipcRenderer.invoke('leveling:forge:window'),
  onForge: (cb) => ipcRenderer.on('leveling:forge', (_e, data) => cb(data)),

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

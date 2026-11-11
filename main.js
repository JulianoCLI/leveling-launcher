/**
 * @file main.js
 * Processo principal do launcher do Leveling Idle 2D.
 *
 * Contas em abas de quatro, cada uma com sessão isolada (`persist:contaN`),
 * alternando entre duas formas de rodar:
 *
 *   WebView  — o jogo normal, para configurar a caçada e mexer no personagem;
 *   headless — monitor sem Chromium, só WebSocket e telemetria. Lê a caçada e,
 *              com o auto-refill ligado, repõe os consumíveis que a automação
 *              do servidor gasta sozinha. Como o servidor só vende na loja da
 *              cidade, repor tira a conta da caçada por ~2,5 s e a devolve.
 *              Nada além disso sai dele.
 *
 * O servidor aceita uma sessão por conta e substitui a anterior, então as duas
 * formas nunca coexistem para a mesma conta: ativar o headless derruba a aba e
 * reabrir a aba derruba o headless (`session.replaced`). É o handoff.
 */

'use strict';

const { app, BrowserWindow, ipcMain, Menu, Tray, shell, session, powerSaveBlocker } = require('electron');
const path = require('path');
const fs = require('fs');

const { levelingHeadlessManager } = require('./src/domain/leveling-headless-service');
const levelingRefill = require('./src/domain/leveling-refill');
const marketDb = require('./src/domain/leveling-market-db');
const levelingSniper = require('./src/domain/leveling-sniper');
const levelingExpedition = require('./src/domain/leveling-expedition');
const levelingBoss = require('./src/domain/leveling-boss');
const levelingListing = require('./src/domain/leveling-listing');
const levelingAutosell = require('./src/domain/leveling-autosell');
const levelingCambio = require('./src/domain/leveling-cambio');
const levelingStats = require('./src/domain/leveling-stats');
const levelingForge = require('./src/domain/leveling-forge');
const levelingOthers = require('./src/domain/leveling-others');
const { levelingCredentials, LevelingProxyPool } = require('./src/domain/leveling-credentials');

/** Conta isolada do sniper: somente leitura do mercado. Segredos vêm do ambiente. */
function startDedicatedSniperMarketAccount() {
  const { normalizeProxy } = require('./src/domain/leveling-credentials');
  const saved = levelingCredentials.getSniper();
  const username = saved.username || process.env.SNIPER_MARKET_USERNAME || '';
  const password = saved.password || process.env.SNIPER_MARKET_PASSWORD || '';
  // saved.proxy é do formato legado (host:porta), precisa normalizar como quem vai usar.
  // Env pode estar em qualquer forma, também normaliza.
  const proxy = normalizeProxy(saved.proxy || process.env.SNIPER_MARKET_PROXY || '');
  if (!username || !password) return;
  levelingHeadlessManager.start(-1, { username, password, proxy });
}
const { createMemoryProbe, parseArgs: parseMemArgs } = require('./src/main/memory-probe');

/** Contas por aba. A aba é a unidade de crescimento do launcher. */
const ACCOUNTS_PER_TAB = 4;
const ACCOUNTS = ACCOUNTS_PER_TAB;
const MAX_TABS = 16;
/**
 * Arranjos da grade, por aba:
 *
 *   split — células iguais, uma por painel (legado);
 *   focus — um painel grande e os outros em faixa menor ao lado;
 *   solo  — um painel ocupando a aba inteira. Os outros continuam vivos,
 *           só não são pintados: é a diferença entre esconder e descarregar;
 *   cols  — todos lado a lado em colunas;
 *
 */
const LAYOUTS = ['focus', 'solo', 'cols'];
/**
 * A raiz do site é a página de divulgação, com um botão que navega até o jogo.
 * O launcher entra direto em `/jogar`: é lá que o cliente roda e que o token
 * salvo em `localStorage` vira sessão, sem passar pela tela inicial.
 */
const GAME_URL = 'https://levelingidle2d.com.br/jogar';
const GAME_ORIGIN = 'https://levelingidle2d.com.br';

const memOpts = parseMemArgs(process.argv, process.env);

app.name = 'leveling-launcher';
try {
  app.setPath('userData', path.join(app.getPath('appData'), 'leveling-launcher'));
} catch {}

// `performance.memory` só é confiável com isso, e o custo não se justifica fora
// da medição.
if (memOpts.enabled) app.commandLine.appendSwitch('enable-precise-memory-info');

if (!app.requestSingleInstanceLock()) app.quit();

let mainWindow = null;
let tray = null;
let sleepBlockerId = null;
let memProbe = null;
/** Última visibilidade informada à interface; evita avisos repetidos. */
let windowVisible = true;

// --------------------------------------------------------------------- registro

const LOG_FILE = () => path.join(app.getPath('userData'), 'erros.log');

function logErro(origem, mensagem) {
  const linha = `[${new Date().toISOString()}] ${origem}: ${mensagem}\n`;
  try {
    fs.appendFileSync(LOG_FILE(), linha);
  } catch {}
}

function logGraphicsEvent(origem, dados) {
  try {
    logErro(origem, JSON.stringify(dados));
  } catch {
    logErro(origem, String(dados));
  }
}

process.on('uncaughtException', err => logErro('uncaught', err && err.stack || String(err)));
process.on('unhandledRejection', err => logErro('rejection', err && err.stack || String(err)));

// O jogo usa WebGL dentro de WebViews. Este evento separa uma falha do
// compositor de uma falha isolada do renderer do jogo.
app.on('gpu-process-crashed', (_event, killed) => {
  logGraphicsEvent('gpu-process-crashed', { killed: !!killed });
});

// ------------------------------------------------------------------- preferências

const PREFS_FILE = () => path.join(app.getPath('userData'), 'prefs.json');
/**
 * `minToTray` tira a janela da barra de tarefas ao minimizar, e `bootMonitor`
 * sobe o launcher já em modo monitor — sem nunca instanciar um renderer do jogo,
 * que é o item mais caro do processo.
 */
const defaultPrefs = () => ({
   panels: 4,
  /** Abas de quatro contas. `tabs: 3` significa doze contas configuráveis. */
  tabs: 1,
  activeTab: 0,
  /**
   * Quantos painéis cada aba mostra. É por aba porque cada grupo de contas
   * tende a ter um uso próprio — uma aba de quatro jogando, outra de uma só.
   * `panels` na raiz é o padrão de uma aba nova.
   */
  tabPrefs: [],
  keepAwake: false,
  muted: false,
  minToTray: true,
  /**
   * Sobe o launcher já em modo monitor, sem instanciar nenhum renderer do jogo
   * — o item mais caro do processo.
   *
   * Vale para o launcher inteiro, não por aba. Por aba era uma pegadinha: o
   * botão grava só na aba visível, então marcar numa e reiniciar deixava as
   * outras no modo normal esperando uma visita, que é o oposto do que "no
   * início" promete.
   */
  bootMonitor: false,
  /**
   * Auto-refill do monitor headless: uma configuração só, para todas as contas.
   * O que varia entre contas é o ouro, não o mínimo de poção que o usuário
   * quer manter, e dez campos por conta seriam um formulário impossível.
   */
  refill: levelingRefill.defaultConfig(),
  /**
   * Sniper de mercado: itens que o launcher compra sozinho quando entram
   * abaixo do teto. Fica aqui, e não só em memória, porque o contador de
   * comprados de cada regra tem de sobreviver a um reinício — sem isso um
   * alvo de 10 unidades viraria 10 por sessão.
   */
  sniper: levelingSniper.defaultConfig(),
  /**
   * Auto-expedição: coleta o que terminou e manda a sombra mais forte do
   * armazém para o destino mais baixo, pelo maior tempo que a conta alcança.
   *
   * Uma configuração para o launcher inteiro, com a lista de contas excluídas
   * dentro dela — o que varia entre contas não é a política, é quais contas o
   * usuário quer de fora.
   */
  expedition: levelingExpedition.defaultConfig(),
  /**
   * Auto-boss diário: faz todos os bosses do dia em cada conta, do mais fraco
   * ao mais forte, e devolve a conta à caçada no fim.
   *
   * Uma configuração para o launcher inteiro, com a lista de contas excluídas
   * dentro dela, pelo mesmo motivo da expedição. Fica em disco porque o que o
   * usuário deixou de fora tem de sobreviver a um reinício — o dia já feito,
   * não: esse vem do servidor em cada leitura.
   */
  boss: levelingBoss.defaultConfig(),
  /**
   * Auto-anunciar: preenche as vagas de anúncio de cada conta com o tesouro
   * que ela tem na bolsa, e recolhe do correio o ouro das vendas.
   *
   * Fica em disco por dois motivos. A lista de contas excluídas é escolha do
   * usuário e tem de sobreviver a um reinício, como na expedição e no boss. E
   * o piso de preço também: ele é o que separa "vendeu bem" de "liquidou o
   * inventário num dia de despejo", e nascer no padrão depois de um reinício
   * desfaria um ajuste deliberado.
   */
  autosell: levelingAutosell.defaultConfig(),
  /**
   * Câmbio: desce o ouro de todas as contas pela cadeia até a que concentra
   * tudo, uma troca por vez.
   *
   * Fica em disco por três motivos, e os três são do usuário: a conta de
   * destino, a reserva que fica em cada conta, e o intervalo entre trocas.
   * Nascer no padrão depois de um reinício mandaria o ouro para a conta errada,
   * que é a única coisa aqui que não tem desfazer.
   */
  cambio: levelingCambio.defaultConfig(),
  /**
   * Auto-status: distribui os pontos de cada nível na build escolhida.
   *
   * É a única automação cuja configuração é **por conta** — `porConta` guarda a
   * build de cada personagem — porque classe e build não têm valor global que
   * sirva. A lista de contas excluídas continua sendo `disabled`, como nas
   * outras.
   *
   * Fica em disco porque alocar ponto não tem volta sem pagar respec: nascer no
   * padrão depois de um reinício gastaria os pontos do nível seguinte numa
   * build que o usuário não escolheu.
   */
  stats: levelingStats.defaultConfig(),
  /**
   * Auto-forja. Em disco pelo motivo mais forte da série: desmontar **apaga a
   * peça** e fundir consome cinco delas. Nascer num padrão depois de um
   * reinício começaria a moer o inventário no primeiro drop.
   */
   forge: levelingForge.defaultConfig(),
   others: levelingOthers.defaultConfig(),
  /**
   * Quando o último hop fechou. Não é configuração, é o relógio do intervalo:
   * sem ele, reiniciar o launcher liberaria um hop na hora, por mais perto que
   * estivesse do anterior.
   */
  cambioLastAtMs: 0
});

function readPrefs() {
  let raw;
  try {
    raw = { ...defaultPrefs(), ...JSON.parse(fs.readFileSync(PREFS_FILE(), 'utf-8')) };
  } catch {
    raw = defaultPrefs();
  }
  return normalizePrefs(raw);
}

/**
 * Garante uma entrada de `tabPrefs` por aba. Abas antigas sem entrada herdam o
 * valor da raiz, que é o que a versão anterior do launcher gravava: quem já
 * usava quatro painéis não deve achar um painel só na primeira abertura.
 */
function normalizePrefs(raw) {
  raw.tabs = Math.min(MAX_TABS, Math.max(1, +raw.tabs || 1));
  raw.activeTab = Math.min(raw.tabs - 1, Math.max(0, +raw.activeTab || 0));

  const herdado = Array.isArray(raw.tabPrefs) ? raw.tabPrefs : [];

  // `bootMonitor` virou global. Quem já tinha marcado em **alguma** aba herda
  // o valor ligado: desmarcar sozinho um launcher que subia em monitor seria
  // uma surpresa pior que a migração.
  if (herdado.some(tab => tab && tab.bootMonitor)) raw.bootMonitor = true;
  raw.bootMonitor = !!raw.bootMonitor;

  raw.tabPrefs = Array.from({ length: raw.tabs }, (_, t) => {
    const tab = herdado[t] || {};
    const panels = Math.min(ACCOUNTS_PER_TAB, Math.max(1, +tab.panels || +raw.panels || ACCOUNTS_PER_TAB));
    return {
      panels,
      /** Colunas é o padrão: todos os painéis ficam visíveis lado a lado. */
      layout: tab.layout === 'split' ? 'cols' : (LAYOUTS.includes(tab.layout) ? tab.layout : 'cols'),
      /** Painel grande em `focus` e único visível em `solo`. */
      focus: Math.min(panels - 1, Math.max(0, +tab.focus || 0))
    };
  });

  // Gasta ouro da conta: nada aqui entra em execução sem passar pela validação
  // do planejador, nem vindo de um `prefs.json` editado à mão.
  raw.refill = levelingRefill.normalizeConfig(raw.refill);
  // Gasta ouro e diamante das contas, e por iniciativa própria: pelo mesmo
  // motivo do refill, nada entra em execução sem passar pela normalização,
  // nem vindo de um `prefs.json` editado à mão.
  raw.sniper = levelingSniper.normalizeConfig(raw.sniper);
  // Não gasta moeda, mas ocupa as sombras do armazém por até 24 h: um
  // `prefs.json` editado à mão não entra em execução sem passar por aqui.
  raw.expedition = levelingExpedition.normalizeConfig(raw.expedition);
  // Não gasta moeda, mas gasta a tentativa do dia, que não volta até o reset:
  // um `prefs.json` editado à mão não entra em execução sem passar por aqui.
  raw.boss = levelingBoss.normalizeConfig(raw.boss);
  // **Vende** item das contas, e é a única automação daqui cujo erro não tem
  // desfazer barato: um anúncio comprado não volta. Um `prefs.json` editado à
  // mão com `floorPct: 1` ou `maxPerRound: 99` passa por aqui antes de
  // qualquer rodada.
  raw.autosell = levelingAutosell.normalizeConfig(raw.autosell);
  // **Move ouro entre contas**, e é a única automação daqui sem desfazer
  // nenhum: uma troca confirmada não volta. Um `prefs.json` com `reserva: 0` ou
  // `intervaloMs: 1` passa por aqui antes de qualquer hop.
  raw.cambio = levelingCambio.normalizeConfig(raw.cambio);
  raw.cambioLastAtMs = Math.max(0, +raw.cambioLastAtMs || 0);
  // **Gasta ponto de atributo**, e desfazer custa token de respec ou cristal:
  // nenhuma outra automação daqui queima recurso do personagem de forma tão
  // definitiva. Um `prefs.json` com uma build inexistente ou pesos negativos
  // passa por aqui antes de qualquer alocação.
  raw.stats = levelingStats.normalizeConfig(raw.stats);
  // **Destrói equipamento**: um `prefs.json` com alvo inválido, lista de
  // guardados corrompida ou teto de desmonte absurdo passa por aqui antes de
  // qualquer fusão.
  raw.forge = levelingForge.normalizeConfig(raw.forge);
  raw.others = levelingOthers.normalizeConfig(raw.others);
  return raw;
}

function writePrefs(patch) {
  const next = normalizePrefs({ ...readPrefs(), ...patch });
  // Uma aba nova só existe de verdade quando há slots de credencial e sessões
  // isoladas para as contas dela.
  applyAccountCapacity(next.tabs);
  try {
    fs.writeFileSync(PREFS_FILE(), JSON.stringify(next));
  } catch (e) {
    logErro('prefs', e.message);
  }
  return next;
}

/**
 * Tira o índice de uma conta de todas as configurações por conta.
 *
 * Existe porque apagar a credencial não apagava nada disso: a conta saía do
 * disco e continuava excluída da expedição, com build de status salva e com
 * regras do sniper pagando por ela. O slot volta a ser usado mais tarde — a
 * partição é persistente — e a conta nova herdava as decisões da anterior.
 *
 * **Remove, não reindexa.** Os índices das outras contas não mudam: o slot
 * continua existindo, vazio. Reindexar faria a conta 4 herdar as preferências
 * da 5, que é um estrago silencioso e maior que o que se quis arrumar.
 *
 * `cambio.destino` é a exceção que exige cuidado: é **1-based** (ver
 * `leveling-cambio.js`, `destinoIdx = cfg.destino - 1`), enquanto todo o resto
 * é 0-based. Se a conta apagada era o destino, o destino volta ao padrão — um
 * câmbio apontando para slot morto moveria ouro para uma conta que não existe,
 * e isso é a única coisa aqui sem desfazer.
 *
 * @returns {object} Um patch para `writePrefs`, só com o que mudou de dono.
 */
function limparPrefsDaConta(prefs, index) {
  const i = Number(index);
  if (!prefs || !Number.isInteger(i) || i < 0) return {};

  const semConta = lista => (Array.isArray(lista) ? lista.filter(n => Number(n) !== i) : []);
  const patch = {};

  // As listas de "não faça nesta conta", iguais em todas as automações.
  for (const chave of ['expedition', 'boss', 'forge', 'cambio', 'others', 'stats']) {
    const cfg = prefs[chave];
    if (!cfg || typeof cfg !== 'object') continue;
    patch[chave] = { ...cfg, disabled: semConta(cfg.disabled) };
  }

  // O auto-anunciar chama a dele de `excluded`, mas o sentido é o mesmo.
  if (prefs.autosell && typeof prefs.autosell === 'object') {
    patch.autosell = { ...prefs.autosell, excluded: semConta(prefs.autosell.excluded) };
  }

  // A build de status é por conta, com o índice como chave de texto.
  if (prefs.stats && prefs.stats.porConta && typeof prefs.stats.porConta === 'object') {
    const porConta = { ...prefs.stats.porConta };
    delete porConta[String(i)];
    patch.stats = { ...(patch.stats || prefs.stats), porConta };
  }

  // Cada regra do sniper diz qual conta paga. A conta apagada não paga mais
  // nada: a regra volta para a conta 1, que é o padrão de `int(source.account)`.
  if (prefs.sniper && Array.isArray(prefs.sniper.rules)) {
    patch.sniper = {
      ...prefs.sniper,
      rules: prefs.sniper.rules.map(r =>
        (r && Number(r.account) === i ? { ...r, account: 0 } : r))
    };
  }

  // `destino` é 1-based: a conta `i` é o destino `i + 1`.
  if (prefs.cambio && Number(prefs.cambio.destino) === i + 1) {
    const padrao = levelingCambio.defaultConfig().destino;
    patch.cambio = { ...(patch.cambio || prefs.cambio), destino: padrao };
    // Sem destino de verdade o câmbio não deve rodar: o padrão é a conta 1, e
    // mandar o ouro para lá por conta própria seria decidir pelo usuário.
    if (padrao === i + 1) patch.cambio.enabled = false;
  }

  return patch;
}

// ----------------------------------------------------------------------- sessões

/**
 * Cada conta tem partição própria para que os logins não se misturem, e nega
 * tudo que o jogo não precisa. A escrita no clipboard passa porque o jogo tem
 * botões de copiar (código de recuperação, link de convite).
 */
function setupAccountSession(num) {
  try {
    const ses = session.fromPartition('persist:conta' + num);
    if (typeof ses.setPermissionRequestHandler === 'function') {
      ses.setPermissionRequestHandler((_wc, permission, done) => {
        done(permission === 'clipboard-sanitized-write');
      });
    }
    applyAccountProxy(num - 1);
  } catch (e) {
    logErro('boot', 'sessao conta' + num + ': ' + e.message);
  }
}

/**
 * Aponta a partição da conta para o proxy atribuído no pool.
 * É por partição, não por aplicação, porque o ponto é que contas diferentes
 * saiam por IPs diferentes: o servidor recusa várias contas do mesmo endereço.
 *
 * O Chromium quer regras no formato `esquema://host:porta` e não lê credenciais
 * da URL, então o usuário e a senha são respondidos no `login` do webContents.
 */
/**
 * A rota de saída de uma conta, do pool. Uma única fonte para os dois caminhos.
 *
 * Existe porque não existia: a WebView lia a rota do pool e o monitor lia o
 * campo `proxy` da conta, que é o formato legado e nunca passou por
 * `normalizeProxy`. O resultado era a conta abrir no modo normal e o monitor
 * ficar em "proxy inválido: Invalid URL" para sempre — `undici` recusa um
 * `host:porta` sem esquema, e é isso que o campo antigo guarda.
 *
 * Pior que o erro: quando o campo legado *era* uma URL válida mas diferente da
 * do pool, não havia erro nenhum — a WebView e o monitor da mesma conta saíam
 * por dois IPs, que é exatamente o que o pool existe para impedir.
 */
function accountProxyUrl(index) {
  const data = levelingCredentials.load();
  const pool = data.proxyPool || new LevelingProxyPool();
  return pool.getProxyUrl(pool.assignments.get(index) || '');
}

function applyAccountProxy(index) {
  const num = index + 1;
  const proxyUrl = accountProxyUrl(index);

  try {
    const ses = session.fromPartition('persist:conta' + num);
    if (typeof ses.setProxy !== 'function') return;

    if (!proxyUrl) {
      /*
       * Sem rota atribuída. Só as duas primeiras contas saem pelo IP da
       * máquina; da terceira em diante a sessão é **bloqueada**, não liberada.
       *
       * `mode: 'system'` para todas era o furo: uma conta sem proxy saía pelo
       * IP local calada, e o servidor respondia `session.multi_account_ip` sem
       * que nada no launcher explicasse o motivo. Apontar para um proxy que não
       * existe faz a conexão falhar de imediato, o que é o resultado honesto —
       * e `canOpen` impede que se chegue até aqui no caminho normal.
       */
      const local = index < LevelingProxyPool.LOCAL_IP_CAPACITY;
      ses.setProxy(local
        ? { mode: 'system' }
        : { proxyRules: 'http://0.0.0.0:1', proxyBypassRules: '<-loopback>' })
        .catch(e => logErro('proxy', `conta${num}: ${e.message}`));
      proxyAuth.delete(num);
      return;
    }

    const url = new URL(proxyUrl);
    const scheme = url.protocol.replace(':', '');
    // `socks5://` nas regras cobre também o `socks` genérico do Chromium.
    const rules = `${scheme}://${url.host}`;
    ses.setProxy({ proxyRules: rules, proxyBypassRules: '<local>' })
      .catch(e => logErro('proxy', `conta${num}: ${e.message}`));

    if (url.username) {
      proxyAuth.set(num, {
        username: decodeURIComponent(url.username),
        password: decodeURIComponent(url.password || '')
      });
    } else {
      proxyAuth.delete(num);
    }
  } catch (e) {
    logErro('proxy', `conta${num}: ${e.message}`);
  }
}

/**
 * Dá rota às contas que já existem e ainda não têm proxy atribuído.
 *
 * Sem isto, quem tinha contas antes do pool existir ficava bloqueado para
 * sempre: `assign` só era chamado no cadastro assistido, então a conta 3 via
 * "sem proxy funcional no pool" com vinte proxies aprovados e quarenta vagas
 * livres ao lado. Roda no boot e depois de importar ou testar proxies, que são
 * os momentos em que a oferta de rotas muda.
 *
 * Aplica o proxy na partição das contas que ganharam rota, senão a sessão
 * continuaria apontando para o bloqueio até o próximo reinício.
 */
function reconcileProxyRoutes() {
  try {
    const data = levelingCredentials.load();
    const pool = data.proxyPool || new LevelingProxyPool();

    // Conta "existe" quando tem nome ou senha guardada. Reservar rota para um
    // slot vazio gastaria vaga de proxy com conta que talvez nunca venha.
    const existentes = data.accounts
      .map((acc, i) => (acc && (acc.username || acc.password) ? i : -1))
      .filter(i => i >= 0);

    const { assigned, unassigned } = pool.reconcile(existentes);
    if (!assigned.length) {
      if (unassigned.length) {
        logErro('proxy', `sem proxy livre para as contas ${unassigned.map(i => i + 1).join(', ')}`);
      }
      return { assigned, unassigned };
    }

    data.proxyPool = pool;
    levelingCredentials.save(data);
    for (const i of assigned) applyAccountProxy(i);
    return { assigned, unassigned };
  } catch (e) {
    logErro('proxy', 'reconcile: ' + e.message);
    return { assigned: [], unassigned: [] };
  }
}

/** Credenciais do proxy por conta, usadas no evento `login` do webContents. */
const proxyAuth = new Map();

/** Quantas contas já têm sessão preparada. Cresce junto com as abas. */
let accountCount = 0;

/**
 * Prepara as sessões das contas que as abas pedem. Idempotente e só cresce: a
 * partição é persistente, então destruí-la ao fechar uma aba apagaria o login.
 */
function applyAccountCapacity(tabs) {
  const total = Math.min(MAX_TABS, Math.max(1, +tabs || 1)) * ACCOUNTS_PER_TAB;
  levelingCredentials.ensureCapacity(total);
  for (let i = accountCount; i < total; i++) setupAccountSession(i + 1);
  if (total > accountCount) accountCount = total;
  return accountCount;
}

/** Partição da conta → índice, para saber de quem é um pedido da WebView. */
function accountIndexOf(ses) {
  if (!ses) return -1;
  for (let i = 0; i < accountCount; i++) {
    if (session.fromPartition('persist:conta' + (i + 1)) === ses) return i;
  }
  return -1;
}

// --------------------------------------------------------------------- headless

function broadcast(channel, payload) {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed() && window.webContents.getURL().startsWith('file://')) {
      window.webContents.send(channel, payload);
    }
  }
}

/**
 * Com `backgroundThrottling: false` — necessário para o monitor não congelar — a
 * página continua "visible" para o Chromium mesmo na bandeja, e a interface
 * seguiria repintando HUDs para ninguém. Este aviso é o que permite ao renderer
 * parar o trabalho visual enquanto a janela está escondida.
 */
function notifyVisibility(visible) {
  const next = !!visible;
  if (next === windowVisible) return;
  windowVisible = next;
  broadcast('window:visible', next);
}

/**
 * As contas emitem updates independentes, mas o painel só repinta uma vez por
 * quadro. Agrupar num único IPC por janela de tempo troca 4 travessias de
 * processo por segundo por uma, e o renderer faz um layout em vez de quatro.
 */
const UPDATE_FLUSH_MS = 1000;
const pendingUpdates = new Map();
let flushTimer = null;

function flushUpdates() {
  flushTimer = null;
  if (!pendingUpdates.size) return;
  const batch = [...pendingUpdates.entries()].map(([index, state]) => ({ index, state }));
  pendingUpdates.clear();
  broadcast('leveling:update', batch);
}

levelingHeadlessManager.on('update', ({ index, state }) => {
  // O estado é sempre completo, então a amostra mais nova substitui a anterior.
  pendingUpdates.set(index, state);
  if (!flushTimer) flushTimer = setTimeout(flushUpdates, UPDATE_FLUSH_MS);
});
levelingHeadlessManager.on('status', ({ index, status, error }) => broadcast('leveling:status', { index, status, error }));
// `handoff` distingue a conta ter assumido em outro lugar (a WebView volta) de
// uma queda de sessão (o monitor reconecta sozinho e a WebView fica fora).
levelingHeadlessManager.on('ended', ({ index, code, handoff }) => broadcast('leveling:ended', { index, code, handoff }));
levelingHeadlessManager.on('death', ({ index, death }) => broadcast('leveling:death', { index, death }));
levelingHeadlessManager.on('arise', data => broadcast('leveling:arise', data));
levelingHeadlessManager.on('refill', data => broadcast('leveling:refill', data));
// Coleta e envio da auto-expedição. A janela pode estar fechada; quem a abrir
// depois lê o estado completo por `expedition:get`.
levelingHeadlessManager.on('expedition', data => broadcast('leveling:expedition', data));
// Rodada de boss diário de uma conta. Mesma razão do evento de expedição: a
// janela pode estar fechada, e quem a abrir depois lê tudo por `boss:get`.
levelingHeadlessManager.on('boss', data => broadcast('leveling:boss', data));
levelingHeadlessManager.on('error', ({ index, error }) => logErro('headless', `conta ${index}: ${error.message}`));
// Guardar o token permite reconectar por `resume`, que não gasta tentativa de login.
levelingHeadlessManager.on('token', ({ index, token }) => levelingCredentials.setToken(index, token));

// ----------------------------------------------------------------- mercado

/**
 * Banco do histórico de vendas. O servidor só mostra os últimos ~30 minutos de
 * mercado e não dá como pedir mais; o que sai dessa janela desaparece. Este
 * arquivo é o único lugar onde o histórico existe de verdade, e por isso ele
 * só cresce — nada aqui é apagado por idade.
 */
const MARKET_FILE = () => path.join(app.getPath('userData'), marketDb.DB_FILE);

let marketOpened = false;
function market() {
  const db = marketDb.getMarketDb(MARKET_FILE());
  if (!marketOpened) {
    marketOpened = true;
    if (!db.open()) logErro('market', `banco indisponível: ${db.error}`);
  }
  return db;
}

/**
 * O coletor é ligado assim que a primeira conta conecta e desligado quando a
 * última sai. Deixá-lo correndo sem conta logada só geraria erro de minuto em
 * minuto; e acioná-lo apenas quando a aba abre perderia justamente as vendas
 * das horas em que o launcher ficou ligado sem ninguém olhando.
 */
levelingHeadlessManager.marketSink = sales => {
  try {
    return market().insertSales(sales);
  } catch (e) {
    logErro('market', e.message);
    return 0;
  }
};

/**
 * O enriquecedor de nível precisa ler a fila de vendas sem nível, que só o
 * banco conhece — `marketSink` é de mão única. Ligado de forma preguiçosa
 * pelo mesmo motivo de `market()`: quem nunca abre o mercado não paga o
 * arquivo. Mas o coletor roda em segundo plano e é ele quem dispara o
 * enriquecimento, então a referência tem de existir desde o início.
 */
levelingHeadlessManager.marketDb = {
  pendingLevels: (n, ids) => { try { return market().pendingLevels(n, ids); } catch { return []; } },
  setLevels: linhas => { try { return market().setLevels(linhas); } catch { return 0; } },
  // A mediana do auto-anunciar. Sem ela nenhum item tem preço, e a rodada
  // inteira sai como "sem vendas registradas deste nível" — que é exatamente o
  // que o relatório mostrava enquanto este método faltava aqui.
  salesForPricing: (defId, opts) => market().salesForPricing(defId, opts),
  // A cotação do diamante, pela mesma razão: é ela que converte o preço em
  // ouro quando o anúncio sai em diamante e o item não tem histórico nessa
  // moeda. Faltando aqui, todo item cairia em `price.noRate`.
  exchangeRate: opts => market().exchangeRate(opts)
};

function syncMarketPoll() {
  const ativa = [...levelingHeadlessManager.clients.values()]
    .some(c => c && c.status === 'connected');
  if (ativa) levelingHeadlessManager.startMarketPoll();
  else levelingHeadlessManager.stopMarketPoll();
}

levelingHeadlessManager.on('status', syncMarketPoll);
function syncMailPoll() {
  // O correio pertence ao ciclo "Outros". Manter o laço legado ativo aqui
  // duplicaria claims quando a nova automação estivesse ligada.
  levelingHeadlessManager.stopMailPoll();
}

levelingHeadlessManager.on('status', syncMailPoll);
levelingHeadlessManager.on('market', data => broadcast('leveling:market', data));

// ----------------------------------------------------------------- sniper

/**
 * Grava o contador de comprados depois de cada compra.
 *
 * É a única parte da configuração do sniper que o processo principal escreve
 * sem o usuário ter mexido na tela, e existe porque o alvo é um total, não um
 * total por sessão: sem gravar, fechar o launcher soltaria o limite.
 */
levelingHeadlessManager.sniperSink = config => {
  try {
    writePrefs({ sniper: config });
  } catch (e) {
    logErro('sniper', e.message);
  }
};

/**
 * Log do sniper em disco.
 *
 * Diferente do catálogo e da lista de portais, que são cópias de algo que o
 * servidor manda: aqui o arquivo **é** o dado. O launcher roda a noite toda e
 * a pergunta do log — "entrou dentro do teto e quem levou?" — é a que se faz
 * na manhã seguinte; só em memória, fechar a janela ou o launcher apagava a
 * resposta.
 *
 * São 300 linhas de poucos campos, algumas dezenas de kilobytes.
 */
const SNIPER_LOG_FILE = () => path.join(app.getPath('userData'), 'sniper-log.json');

function readSniperLogFile() {
  try {
    const lido = JSON.parse(fs.readFileSync(SNIPER_LOG_FILE(), 'utf-8'));
    return Array.isArray(lido) ? lido : null;
  } catch {
    return null;
  }
}

/**
 * Grava a cada linha, não de minuto em minuto.
 *
 * Uma compra é o acontecimento que o usuário quer ver registrado, e uma queda
 * do launcher logo depois dela é justamente o caso em que ele vai procurar o
 * log. A escrita é de poucas dezenas de kilobytes e só acontece quando algo
 * entra no mercado dentro do teto — não é um laço.
 */
levelingHeadlessManager.sniperLogSink = entries => {
  try {
    fs.writeFileSync(SNIPER_LOG_FILE(), JSON.stringify(entries));
  } catch (e) {
    logErro('sniper', e.message);
  }
};

/**
 * O sniper, ao contrário do coletor, não liga só por haver conta conectada:
 * ele gasta dinheiro, então depende do interruptor da tela. O que o status
 * decide é o oposto — desligar o laço quando a última conta sai, para não
 * acumular erro de "conta offline" de segundo em segundo.
 */
function syncSniperPoll() {
  const cfg = levelingHeadlessManager.getSniperConfig();
  const ativa = [...levelingHeadlessManager.clients.values()]
    .some(c => c && c.status === 'connected');
  if (ativa && levelingSniper.isConfigured(cfg)) levelingHeadlessManager.startSniperPoll();
  else levelingHeadlessManager.stopSniperPoll();
}

levelingHeadlessManager.on('status', syncSniperPoll);
levelingHeadlessManager.on('sniper', data => broadcast('leveling:sniper', data));

// ----------------------------------------------------------- auto-anunciar

/**
 * Grava a configuração do auto-anunciar.
 *
 * Existe pelo mesmo motivo do `sniperSink`, com um detalhe a menos: aqui o
 * laço não altera a configuração por conta própria — não há contador de
 * vendidos dentro dela. A gravação acontece quando a tela muda algo, e o
 * `sink` é o caminho único para isso ir ao disco.
 */
levelingHeadlessManager.autosellSink = config => {
  try {
    writePrefs({ autosell: config });
  } catch (e) {
    logErro('autosell', e.message);
  }
};

/**
 * Relatório do auto-anunciar em disco.
 *
 * Mais necessário que o log do sniper: aqui o launcher **vendeu** coisas
 * enquanto o usuário dormia, e a pergunta da manhã seguinte — "o que ele
 * anunciou, e por quanto" — é a única forma de auditar o preço. Cada linha
 * carrega mediana, rival e piso justamente para essa conferência.
 */
const AUTOSELL_LOG_FILE = () => path.join(app.getPath('userData'), 'autosell-log.json');

function readAutosellLogFile() {
  try {
    const lido = JSON.parse(fs.readFileSync(AUTOSELL_LOG_FILE(), 'utf-8'));
    return Array.isArray(lido) ? lido : null;
  } catch {
    return null;
  }
}

levelingHeadlessManager.autosellLogSink = entries => {
  try {
    fs.writeFileSync(AUTOSELL_LOG_FILE(), JSON.stringify(entries));
  } catch (e) {
    logErro('autosell', e.message);
  }
};

/**
 * Mesma lógica do sniper: escrita de mercado depende do interruptor da tela, e
 * o status só serve para desligar o laço quando a última conta sai.
 */
function syncAutosellPoll() {
  const cfg = levelingHeadlessManager.getAutosellConfig();
  const ativa = [...levelingHeadlessManager.clients.values()]
    .some(c => c && c.status === 'connected');
  if (ativa && levelingAutosell.isConfigured(cfg)) levelingHeadlessManager.startAutosellPoll();
  else levelingHeadlessManager.stopAutosellPoll();
}

levelingHeadlessManager.on('status', syncAutosellPoll);
levelingHeadlessManager.on('autosell', data => broadcast('leveling:autosell', data));

// --------------------------------------------------------------- outras automações
const OTHERS_LOG_FILE = () => path.join(app.getPath('userData'), 'others-log.json');

function readOthersLogFile() {
  try {
    const value = JSON.parse(fs.readFileSync(OTHERS_LOG_FILE(), 'utf-8'));
    return Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

levelingHeadlessManager.othersLogSink = entries => {
  try { fs.writeFileSync(OTHERS_LOG_FILE(), JSON.stringify(entries)); }
  catch (e) { logErro('others', e.message); }
};

function syncOthersPoll() {
  const cfg = levelingHeadlessManager.getOthersConfig();
  const active = [...levelingHeadlessManager.clients.values()]
    .some(client => client && client.index >= 0 && client.status === 'connected');
  if (active && cfg.enabled) levelingHeadlessManager.startOthersPoll();
  else levelingHeadlessManager.stopOthersPoll();
}

levelingHeadlessManager.on('status', syncOthersPoll);
levelingHeadlessManager.on('others', data => broadcast('leveling:others', data));

// ------------------------------------------------------------------- câmbio

/**
 * Grava a configuração do câmbio **e o relógio do último hop**.
 *
 * O segundo argumento é o que diferencia este sink dos outros: a configuração
 * só muda quando a tela mexe nela, mas `cambioLastAtMs` muda a cada hop, e é o
 * que faz o intervalo sobreviver a um reinício. Sem gravá-lo, religar o
 * launcher logo depois de uma troca liberaria a seguinte na hora.
 */
levelingHeadlessManager.cambioSink = (config, lastAtMs) => {
  try {
    writePrefs({ cambio: config, cambioLastAtMs: Math.max(0, +lastAtMs || 0) });
  } catch (e) {
    logErro('cambio', e.message);
  }
};

/**
 * Relatório do câmbio em disco.
 *
 * O mais necessário dos três. O launcher **moveu ouro entre contas** enquanto
 * o usuário dormia, e nada no jogo mostra isso depois: a janela de troca não
 * guarda histórico. Cada linha traz o par, o valor e os dois saldos justamente
 * para que a conferência da manhã seguinte seja possível sem o servidor.
 */
const CAMBIO_LOG_FILE = () => path.join(app.getPath('userData'), 'cambio-log.json');

function readCambioLogFile() {
  try {
    const lido = JSON.parse(fs.readFileSync(CAMBIO_LOG_FILE(), 'utf-8'));
    return Array.isArray(lido) ? lido : null;
  } catch {
    return null;
  }
}

levelingHeadlessManager.cambioLogSink = entries => {
  try {
    fs.writeFileSync(CAMBIO_LOG_FILE(), JSON.stringify(entries));
  } catch (e) {
    logErro('cambio', e.message);
  }
};

/**
 * Mesma lógica do sniper e do auto-anunciar, com um motivo mais forte: um hop
 * precisa de **duas** contas conectadas ao mesmo tempo, então ligar o laço com
 * uma conta só acumularia `cambio.semCadeia` de quinze em quinze segundos.
 */
function syncCambioPoll() {
  const cfg = levelingHeadlessManager.cambioConfig;
  const conectadas = [...levelingHeadlessManager.clients.values()]
    .filter(c => c && c.status === 'connected').length;
  if (conectadas >= 2 && levelingCambio.isConfigured(cfg)) {
    levelingHeadlessManager.startCambioPoll();
  } else {
    levelingHeadlessManager.stopCambioPoll();
  }
}

levelingHeadlessManager.on('status', syncCambioPoll);
levelingHeadlessManager.on('cambio', data => broadcast('leveling:cambio', data));

// --------------------------------------------------------------- auto-status

levelingHeadlessManager.statsSink = config => {
  try {
    writePrefs({ stats: config });
  } catch (e) {
    logErro('stats', e.message);
  }
};

/**
 * Relatório do auto-status em disco.
 *
 * Mesmo motivo do relatório do câmbio: o launcher gastou pontos que **não
 * voltam** sem respec, e o jogo não guarda histórico de alocação. Cada linha
 * traz o nível, a build e a divisão exata, para a conferência depois ser
 * possível sem o servidor.
 */
const STATS_LOG_FILE = () => path.join(app.getPath('userData'), 'stats-log.json');

function readStatsLogFile() {
  try {
    const lido = JSON.parse(fs.readFileSync(STATS_LOG_FILE(), 'utf-8'));
    return Array.isArray(lido) ? lido : null;
  } catch {
    return null;
  }
}

levelingHeadlessManager.statsLogSink = entries => {
  try {
    fs.writeFileSync(STATS_LOG_FILE(), JSON.stringify(entries));
  } catch (e) {
    logErro('stats', e.message);
  }
};

/**
 * Cópia das classes e builds em disco.
 *
 * Só para a janela abrir com o seletor cheio antes de qualquer login: a
 * primeira conta a conectar relê o catálogo do servidor e substitui esta cópia,
 * que pode estar velha em relação ao jogo.
 */
const CLASSES_FILE = () => path.join(app.getPath('userData'), 'classes.json');

function readClassesFile() {
  try {
    return JSON.parse(fs.readFileSync(CLASSES_FILE(), 'utf-8'));
  } catch {
    return null;
  }
}

levelingHeadlessManager.on('classes', ({ catalog }) => {
  try {
    fs.writeFileSync(CLASSES_FILE(), JSON.stringify(catalog));
  } catch (e) {
    logErro('stats', e.message);
  }
});

// A janela pode estar fechada, e quem a abrir depois lê tudo por `stats:get`.
levelingHeadlessManager.on('stats', data => broadcast('leveling:stats', data));

// ---------------------------------------------------------------- auto-forja

levelingHeadlessManager.forgeSink = config => {
  try {
    writePrefs({ forge: config });
  } catch (e) {
    logErro('forge', e.message);
  }
};

/**
 * Relatório da forja em disco.
 *
 * A auditoria mais necessária das que o launcher guarda: as peças desmontadas
 * não existem mais e o jogo não registra desmonte nenhum. Cada linha traz o que
 * entrou, o que saiu e quanto custou.
 */
const FORGE_LOG_FILE = () => path.join(app.getPath('userData'), 'forge-log.json');

function readForgeLogFile() {
  try {
    const lido = JSON.parse(fs.readFileSync(FORGE_LOG_FILE(), 'utf-8'));
    return Array.isArray(lido) ? lido : null;
  } catch {
    return null;
  }
}

levelingHeadlessManager.forgeLogSink = entries => {
  try {
    fs.writeFileSync(FORGE_LOG_FILE(), JSON.stringify(entries));
  } catch (e) {
    logErro('forge', e.message);
  }
};

levelingHeadlessManager.on('forge', data => broadcast('leveling:forge', data));

/**
 * Venda da própria conta. O feed público anonimiza vendedor e comprador, então
 * esta é a única via que traz quem comprou. `MarketSold` não tem id de venda
 * nem data: o `listing_id` serve de chave (um anúncio vende uma vez) e a hora
 * é a da chegada do push, com erro de segundos.
 */
levelingHeadlessManager.on('market-sold', ({ index, sold }) => {
  if (!sold) return;
  try {
    // `seller_index` é o que separa "eu vendi" de "o mercado vendeu". O feed
    // público é global e anônimo; este push é a única via que sabe de quem é
    // a venda, e sem o carimbo a aba de anúncios não teria o que listar.
    market().insertSales([{
      ...sold, id: sold.listing_id, sold_at_ms: Date.now(), seller_index: index
    }]);
  } catch (e) {
    logErro('market', e.message);
  }
  broadcast('leveling:market-sold', { index, sold });
});

// ------------------------------------------------------------------------- IPC

/**
 * Só o frame principal de uma página do launcher fala com estes canais.
 *
 * Duas páginas, não uma: o mercado tem janela própria e carrega o mesmo
 * preload. A lista é fechada de propósito — comparar com "qualquer file://"
 * deixaria uma WebView do jogo que conseguisse navegar para um arquivo local
 * falando com o IPC privilegiado.
 *
 * O frame tem de ser o principal: um iframe dentro da página não fala.
 */
const LAUNCHER_PAGES = [
  'index.html', 'market.html', 'sniper.html', 'expedition.html', 'boss.html', 'autosell.html',
  'cambio.html', 'stats.html', 'forge.html', 'outros.html', 'proxies.html', 'cadastro.html'
].map(
  f => require('url').pathToFileURL(path.join(__dirname, f)).href
);

const launcherOnly = event => {
  if (event.senderFrame !== event.sender.mainFrame
    || !LAUNCHER_PAGES.includes(event.sender.getURL().split('?')[0])) {
    throw new Error('Origem não autorizada.');
  }
};

ipcMain.on('app:version', event => { event.returnValue = app.getVersion(); });
ipcMain.handle('app:game-url', () => GAME_URL);
// A WebView precisa do preload como URL `file://`, não como caminho de disco.
ipcMain.handle('app:account-preload', () =>
  require('url').pathToFileURL(path.join(__dirname, 'src', 'main', 'account-preload.js')).href);

ipcMain.handle('prefs:get', event => { launcherOnly(event); return readPrefs(); });
ipcMain.handle('prefs:set', (event, patch) => {
  launcherOnly(event);
  const next = writePrefs(patch || {});
  applyKeepAwake(next.keepAwake);
  return next;
});

ipcMain.handle('leveling:start', (event, index) => {
  launcherOnly(event);
  const creds = levelingCredentials.get(index);
  if (!creds.username || !creds.password) {
    return { ok: false, error: 'Credenciais não configuradas.' };
  }
  
  /*
   * A rota antes da conexão. Só as duas primeiras contas saem pelo IP da
   * máquina; as outras precisam de um proxy que passou no teste.
   *
   * Antes bastava haver vaga no pool, e vaga não é rota: a conta conectava sem
   * proxy aplicado e o servidor respondia `session.multi_account_ip` depois,
   * quando já não havia o que fazer além de desligar.
   */
  const data = levelingCredentials.load();
  const pool = data.proxyPool || new LevelingProxyPool();
  const porta = pool.canOpen(index);
  if (!porta.ok) {
    return { ok: false, error: `Conta ${index + 1} não pode conectar: ${porta.motivo}.` };
  }

  try {
    // O monitor precisa sair pelo mesmo IP da WebView da conta; falhar aqui é
    // melhor que conectar pela rota errada e tomar `session.multi_account_ip`.
    //
    // A rota vem do pool, a mesma fonte que `applyAccountProxy` usa na WebView.
    // Herdar `creds.proxy` era o furo: aquele campo é o formato legado, não
    // passa por `normalizeProxy` e pode estar vazio ou divergente da rota real.
    levelingHeadlessManager.start(index, { ...creds, proxy: accountProxyUrl(index) });
  } catch (e) {
    logErro('headless', `conta ${index}: ${e.message}`);
    return { ok: false, error: e.message };
  }
  return { ok: true };
});

ipcMain.handle('leveling:stop', (event, index) => {
  launcherOnly(event);
  levelingHeadlessManager.stop(index);
  // Sem isso, o lote seguinte entregaria um estado de uma conta já desligada.
  pendingUpdates.delete(index);
  return { ok: true };
});

ipcMain.handle('leveling:status', (event, index) => {
  launcherOnly(event);
  return levelingHeadlessManager.getStatus(index);
});

ipcMain.handle('leveling:creds:get', event => {
  launcherOnly(event);
  return levelingCredentials.getPublicStatus();
});

ipcMain.handle('leveling:creds:set', (event, index, username, password) => {
  launcherOnly(event);
  const ok = levelingCredentials.setCredentials(index, username, password);
  return { ok, status: levelingCredentials.getPublicStatus() };
});

ipcMain.on('leveling:creds:capture', (event, { username, password, kind }) => {
  // Resolve o índice pela partição de quem chamou (mesmo que account-preload.js usa para o token).
  const partition = event.sender.session.partition;
  let index = -1;
  if (partition.startsWith('persist:conta')) {
    const match = partition.match(/persist:conta(\d+)/);
    if (match) index = parseInt(match[1], 10) - 1;
  }
  
  if (index < 0 || index >= levelingCredentials.maxAccounts) return;
  if (!username || !password) return;

  // Captura preservando o token (diferente de setCredentials, que o zera).
  const creds = levelingCredentials.get(index);
  const data = levelingCredentials.load();
  const nome = username.trim();
  data.accounts[index] = {
    username: nome,
    password,
    token: creds.token, // Preserva o token existente (se houver).
    proxy: creds.proxy,  // Preserva o proxy também
    email: creds.email || '',
    /*
     * O envio do formulário é a prova de que a conta saiu do limbo do cadastro:
     * um `register` enviado passou pelo captcha, e um `login` enviado só faz
     * sentido numa conta que existe. Em ambos os casos a marca cai — mas só se
     * o nome for o mesmo que o assistente reservou, senão um login de outra
     * conta na mesma aba apagaria a pendência errada.
     */
    signup: creds.signup && creds.username !== nome
  };
  levelingCredentials.save(data);
  
  // Informa à UI que a credencial foi capturada.
  mainWindow.webContents.send('leveling:creds:captured', { index, kind });
});

ipcMain.handle('leveling:proxy:import', (event, text) => {
  launcherOnly(event);
  const data = levelingCredentials.load();
  const pool = data.proxyPool || new LevelingProxyPool();
  const result = pool.importText(text);
  data.proxyPool = pool;
  levelingCredentials.save(data);
  // Proxy importado nasce `pending`, então nada é atribuído agora — mas se o
  // pool já tinha aprovados sobrando, as contas presas aproveitam.
  reconcileProxyRoutes();
  return result; // { added, duplicates, invalid }
});

ipcMain.handle('leveling:proxy:pool', (event) => {
  launcherOnly(event);
  const data = levelingCredentials.load();
  const pool = data.proxyPool || new LevelingProxyPool();
  const proxies = pool.getAll().map(p => ({
    id: p.id,
    label: p.label,
    status: p.status,
    ip: p.ip,
    error: p.error,
    assignedCount: Array.from(pool.assignments.values()).filter(pid => pid === p.id).length
  }));
  return {
    proxies,
    capacity: pool.capacity()
  };
});

ipcMain.handle('leveling:proxy:test', async (event, proxyId) => {
  launcherOnly(event);
  const data = levelingCredentials.load();
  const pool = data.proxyPool || new LevelingProxyPool();
  const proxy = pool.proxies.find(p => p.id === proxyId);
  if (!proxy) return { error: 'Proxy não encontrado' };
  
  try {
    // Usa o mesmo teste que o headless faz
    const undici = require('undici');
    const proxyDispatcher = require('./src/domain/leveling-headless-service').proxyDispatcher;
    const dispatcher = proxyDispatcher(proxy.url);
    const res = await undici.request('https://api.ipify.org?format=json', {
      dispatcher,
      headersTimeout: 8000,
      bodyTimeout: 8000
    });
    const body = await res.body.json();
    if (res.statusCode < 200 || res.statusCode >= 300) {
      pool.setProxyStatus(proxyId, 'fail', '', `HTTP ${res.statusCode}`);
      levelingCredentials.save(data);
      return { status: 'fail', error: `HTTP ${res.statusCode}` };
    }
    pool.setProxyStatus(proxyId, 'ok', body.ip || '', '');
    levelingCredentials.save(data);
    // Um proxy que acabou de passar é rota nova: as contas que estavam
    // bloqueadas por falta dela são atendidas sem o usuário pedir.
    reconcileProxyRoutes();
    return { status: 'ok', ip: body.ip };
  } catch (e) {
    pool.setProxyStatus(proxyId, 'fail', '', e.message);
    levelingCredentials.save(data);
    return { status: 'fail', error: e.message };
  }
});

ipcMain.handle('leveling:proxy:remove', (event, proxyId) => {
  launcherOnly(event);
  const data = levelingCredentials.load();
  const pool = data.proxyPool || new LevelingProxyPool();
  pool.remove(proxyId);
  data.proxyPool = pool;
  levelingCredentials.save(data);
  return { ok: true };
});

/**
 * Monta o plano de cadastro e devolve a pré-visualização.
 *
 * O cálculo vive aqui, e não no renderer, por dois motivos: a página do
 * assistente não tem `require` (a CSP e o `contextIsolation` cuidam disso), e
 * as senhas saem de `crypto.randomInt`, que é do processo principal.
 *
 * A senha vai mascarada para a janela. O assistente não precisa mostrar a
 * senha para montar a fila, e um valor que não atravessa o IPC é um valor que
 * não vaza por um log de renderer.
 */
/** O último plano montado, à espera de ser guardado. */
let pendingSignupPlan = [];

/** As classes que o assistente oferece. Vêm do domínio, não da página. */
ipcMain.handle('leveling:signup:classes', event => {
  launcherOnly(event);
  return require('./src/domain/leveling-signup.js').CLASSES;
});

ipcMain.handle('leveling:signup:plan', (event, opts) => {
  launcherOnly(event);
  const signup = require('./src/domain/leveling-signup.js');
  const { items, invalid } = signup.buildPlan(opts || {});

  // O plano fica no processo principal até o usuário guardar; a janela só vê
  // o que precisa para mostrar a fila.
  pendingSignupPlan = items;

  return {
    items: items.map((it, i) => ({
      index: i,
      username: it.username,
      email: it.email,
      gender: it.gender,
      referral: it.referral
    })),
    invalid
  };
});

/**
 * Guarda o plano nas credenciais, nos primeiros slots que estiverem vazios.
 *
 * Guardar antes de cadastrar é de propósito: é o que permite a WebView
 * preencher o formulário sozinha depois. A conta ainda não existe no
 * servidor, e é por isso que `pending` fica marcado — o monitor não deve
 * tentar usar uma credencial que ainda não passou pelo captcha.
 */
ipcMain.handle('leveling:signup:save', event => {
  launcherOnly(event);
  if (!pendingSignupPlan.length) return { ok: false, error: 'Nenhum plano montado.' };

  const vazio = acc => !acc || (!acc.username && !acc.hasPassword);
  const slotsLivres = () => {
    const { accounts } = levelingCredentials.getPublicStatus();
    const livres = [];
    for (let i = 0; i < accounts.length && livres.length < pendingSignupPlan.length; i++) {
      if (vazio(accounts[i])) livres.push(i);
    }
    return livres;
  };

  let livres = slotsLivres();

  // Os slots só existem até `abas * ACCOUNTS_PER_TAB`. Em vez de recusar o
  // plano, abre-se a capacidade que falta — é o mesmo que o usuário faria
  // adicionando abas na mão.
  if (livres.length < pendingSignupPlan.length) {
    const { accounts } = levelingCredentials.getPublicStatus();
    const ocupados = accounts.filter(acc => !vazio(acc)).length;
    const preciso = ocupados + pendingSignupPlan.length;
    applyAccountCapacity(Math.ceil(preciso / ACCOUNTS_PER_TAB));
    livres = slotsLivres();
  }

  if (livres.length < pendingSignupPlan.length) {
    return {
      ok: false,
      error: `O plano tem ${pendingSignupPlan.length} contas, mas só há ${livres.length} slot(s) livre(s).`
    };
  }

  /*
   * Tudo numa gravação só.
   *
   * Antes isto chamava `setPendingSignup` por conta e, no fim, um `save` com um
   * `data` lido **antes** do laço. Cada `setPendingSignup` substitui o cache
   * interno, então o `data` da ponta virava um retrato velho e o `save` final
   * apagava todas as contas do plano menos a primeira — o motivo real de "só a
   * primeira conta é cadastrada". A segunda janela abria sem credencial para
   * preencher.
   *
   * Montar o `data` uma vez e salvar uma vez também torna o plano atômico: ou
   * todas as contas entram com sua rota, ou nenhuma entra.
   */
  const data = levelingCredentials.load();
  const pool = data.proxyPool || new LevelingProxyPool();

  const salvos = [];
  const semRota = [];
  pendingSignupPlan.forEach((item, i) => {
    const index = livres[i];

    /*
     * A rota primeiro. Duas contas no mesmo IP já são recusadas pelo servidor
     * (`session.multi_account_ip`), e no cadastro a recusa viria depois do
     * captcha resolvido à mão — o pior momento para descobrir que faltava
     * proxy, porque o nome já foi queimado.
     */
    const rota = pool.assign(index);
    const podeLocal = index < LevelingProxyPool.LOCAL_IP_CAPACITY;
    if (!rota && !podeLocal) {
      // Sem rota e sem direito ao IP local: a conta não entra no plano. Gravar
      // a credencial aqui criaria uma conta que nunca poderia abrir.
      semRota.push(item.username);
      return;
    }

    data.accounts[index] = {
      username: item.username,
      password: item.password,
      token: '',
      proxy: (data.accounts[index] && data.accounts[index].proxy) || '',
      email: item.email,
      signup: true,
      classId: item.classId || ''
    };

    salvos.push({
      index,
      username: item.username,
      tab: Math.floor(index / ACCOUNTS_PER_TAB),
      proxy: rota ? (pool.getPublicProxy(rota.proxyId) || {}).label || '' : ''
    });
  });

  data.proxyPool = pool;
  levelingCredentials.save(data);
  // Depois de salvar: a partição lê a atribuição do disco.
  for (const s of salvos) applyAccountProxy(s.index);

  if (!salvos.length) {
    pendingSignupPlan = [];
    return {
      ok: false,
      error: 'Nenhuma conta pôde ser criada: o pool não tem proxy funcional livre. '
        + 'Importe e teste proxies — cada proxy aprovado abre duas contas.'
    };
  }

  pendingSignupPlan = [];

  /*
   * A janela do assistente não alcança as abas: os painéis e as WebViews são
   * do renderer do launcher. Avisá-lo é o que faz as abas abrirem já com a
   * rota e o formulário preenchidos, sem o usuário ter de procurar em qual
   * slot cada nome caiu.
   */
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('leveling:signup:ready', salvos);
    try {
      mainWindow.show();
      mainWindow.focus();
    } catch { /* janela indisponível; as abas abrem quando ela voltar */ }
  }

  return {
    ok: true,
    saved: salvos,
    // Saem pelo IP da máquina: só as duas primeiras contas chegam aqui, porque
    // as outras já foram recusadas em `semRota`.
    semProxy: salvos.filter(s => !s.proxy).map(s => s.username),
    // Recusadas por falta de proxy. Nomeá-las é o que deixa claro que o plano
    // saiu menor do que o pedido, e por quê.
    recusadas: semRota,
    status: levelingCredentials.getPublicStatus()
  };
});

/**
 * Apaga as credenciais das contas a partir de um slot, com a sessão delas.
 *
 * É o que acontece ao remover uma aba: a conta deixa de ter onde aparecer, e
 * deixar a credencial órfã no disco significaria que recriar a aba traria de
 * volta um login que o usuário achava apagado.
 *
 * A partição é limpa junto (`clearStorageData`): só apagar a credencial
 * deixaria o token no `localStorage`, e a WebView voltaria logada sozinha.
 *
 * A vaga no pool de proxies é devolvida: ela está presa a um índice de conta
 * que não existe mais, e sem liberar o pool esgotaria com contas fantasmas.
 */
/**
 * Apaga de verdade as contas de uma lista de índices.
 *
 * Uma só rotina para os dois caminhos — "apagar conta" e "remover aba" —
 * porque a diferença entre eles era justamente o defeito: remover a aba
 * limpava credencial, sessão e proxy, e deixava para trás as preferências por
 * conta e o histórico de vendas. Recriar a aba trazia de volta a conta
 * "apagada" nas listas de exclusão, na build de status e nos anúncios.
 *
 * O que sai, por conta: monitor, atualização pendente, vaga no pool,
 * credencial inteira (`wipe`, não `clear`), armazenamento da partição,
 * credenciais de proxy em memória, vendas carimbadas no banco do mercado e as
 * preferências por conta.
 *
 * O que **não** sai: a capacidade. `accountCount` e `maxAccounts` não
 * encolhem — a partição é persistente e os índices das outras contas apontam
 * para slots que precisam continuar onde estão.
 */
async function apagarContas(indices) {
  const data = levelingCredentials.load();
  const pool = data.proxyPool || new LevelingProxyPool();
  const apagados = [];

  for (const i of indices) {
    const acc = data.accounts[i];
    const tinha = acc && (acc.username || acc.password || acc.token);
    // Parar primeiro: o monitor ficaria rodando com credencial que já não existe.
    levelingHeadlessManager.stop(i);
    // Sem isso, o lote seguinte entregaria um estado de uma conta já desligada.
    pendingUpdates.delete(i);
    pool.release(i);
    data.accounts[i] = {
      username: '', password: '', token: '', proxy: '', email: '',
      signup: false, classId: ''
    };
    if (tinha) apagados.push(i);
  }

  data.proxyPool = pool;
  levelingCredentials.save(data);

  for (const i of indices) {
    try {
      await session.fromPartition('persist:conta' + (i + 1)).clearStorageData();
      // A senha do proxy vive em memória, indexada pelo número da conta.
      proxyAuth.delete(i + 1);
      applyAccountProxy(i);
    } catch (e) {
      logErro('creds-wipe', `conta${i + 1}: ${e.message}`);
    }
    try {
      market().deleteBySeller(i);
    } catch (e) {
      logErro('creds-wipe', `mercado conta${i + 1}: ${e.message}`);
    }
  }

  // Um `writePrefs` só para todas as contas: cada chamada reescreve o arquivo.
  try {
    let prefs = readPrefs();
    let patch = {};
    for (const i of indices) {
      patch = { ...patch, ...limparPrefsDaConta({ ...prefs, ...patch }, i) };
    }
    if (Object.keys(patch).length) writePrefs(patch);
  } catch (e) {
    logErro('creds-wipe', 'prefs: ' + e.message);
  }

  return apagados;
}

ipcMain.handle('leveling:creds:clear-from', async (event, from) => {
  launcherOnly(event);
  const inicio = Math.max(1, +from || 1); // A conta 1 nunca entra.
  const total = levelingCredentials.load().accounts.length;
  const indices = [];
  for (let i = inicio; i < total; i++) indices.push(i);

  const apagados = await apagarContas(indices);
  return { ok: true, cleared: apagados, status: levelingCredentials.getPublicStatus() };
});

/**
 * Apaga uma conta só, a pedido do botão "Apagar conta" do card.
 *
 * O slot fica vazio no lugar: encolher a lista moveria as contas seguintes
 * para partições que não são as delas.
 */
ipcMain.handle('leveling:creds:wipe', async (event, index) => {
  launcherOnly(event);
  const i = Number(index);
  const total = levelingCredentials.load().accounts.length;
  if (!Number.isInteger(i) || i < 0 || i >= total) {
    return { ok: false, error: 'Conta inválida.', status: levelingCredentials.getPublicStatus() };
  }

  const apagados = await apagarContas([i]);
  return { ok: true, cleared: apagados, status: levelingCredentials.getPublicStatus() };
});

ipcMain.handle('leveling:creds:clear', (event, index) => {
  launcherOnly(event);
  // Parar primeiro: o monitor ficaria rodando com credencial que já não existe.
  levelingHeadlessManager.stop(index);
  const ok = levelingCredentials.clear(index);
  return { ok, status: levelingCredentials.getPublicStatus() };
});

/**
 * Monta o grupo com as contas da aba. Só entram as que já têm monitor ativo: a
 * conta na WebView do jogo não tem socket no processo principal, e o servidor
 * aceita uma sessão por conta, então o launcher não pode falar por ela.
 */
ipcMain.handle('leveling:party:assemble', async (event, indexes) => {
  launcherOnly(event);
  const lista = (Array.isArray(indexes) ? indexes : [])
    .map(i => Number(i))
    .filter(i => Number.isInteger(i) && i >= 0 && i < accountCount);

  const result = await levelingHeadlessManager.assembleParty(lista);
  if (!result.ok) logErro('party', `aba ${lista.join(',')}: ${result.error || result.huntError || 'falhou'}`);
  return result;
});

// A montagem leva alguns segundos e passa por várias contas; narrar cada etapa
// é o que impede o botão de parecer travado.
levelingHeadlessManager.on('party:step', step => broadcast('leveling:party-step', step));

/**
 * Cópia em disco da lista de portais. O `content_catalog` chega **uma vez, no
 * login** e não pode ser pedido de novo: sem este arquivo, um monitor que já
 * estava conectado quando o launcher abriu deixaria o seletor de caçada vazio
 * até a conta relogar, que é o que ele estava justamente evitando.
 *
 * São alguns kilobytes — o 1 MB do catálogo não é guardado em lugar nenhum.
 */
const HUNTS_FILE = () => path.join(app.getPath('userData'), 'hunts.json');

function readHuntsFile() {
  try {
    return JSON.parse(fs.readFileSync(HUNTS_FILE(), 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * Portais, faixas e dificuldades para o seletor de caçada. A cópia de disco
 * atende a primeira abertura; a primeira conta a logar a substitui pela lista
 * do servidor, que pode ter portal novo.
 */
ipcMain.handle('leveling:hunts:get', event => {
  launcherOnly(event);
  const salvo = levelingHeadlessManager.getHuntCatalog() || readHuntsFile();
  if (salvo) levelingHeadlessManager.setHuntCatalog(salvo);
  return { catalog: levelingHeadlessManager.getHuntCatalog() };
});

// O catálogo chega uma vez, no primeiro login: avisar é o que preenche um
// seletor que já estava aberto sem a lista, e gravar é o que faz a próxima
// abertura do launcher já ter a lista antes de qualquer login.
levelingHeadlessManager.on('hunts', ({ catalog }) => {
  try {
    fs.writeFileSync(HUNTS_FILE(), JSON.stringify(catalog));
  } catch (e) {
    logErro('hunts', e.message);
  }
  broadcast('leveling:hunts', { catalog });
});

/**
 * Cópia em disco da aparência do mercado: ícones, cores de raridade e sprites
 * de monstro. Pelo mesmo motivo do arquivo de caçadas — o `content_catalog`
 * chega uma vez no login e não pode ser pedido de novo —, e com um motivo a
 * mais: sem esta cópia a tabela de preços abriria sem ícone nenhum e os
 * pintaria só depois do próximo login, piscando.
 *
 * São ~30 KB recortados de 1 MB.
 */
const MARKET_CATALOG_FILE = () => path.join(app.getPath('userData'), 'market-catalog.json');

function readMarketCatalogFile() {
  try {
    return JSON.parse(fs.readFileSync(MARKET_CATALOG_FILE(), 'utf-8'));
  } catch {
    return null;
  }
}

levelingHeadlessManager.on('market-catalog', ({ catalog }) => {
  try {
    fs.writeFileSync(MARKET_CATALOG_FILE(), JSON.stringify(catalog));
  } catch (e) {
    logErro('market', e.message);
  }
  broadcast('leveling:market-catalog', { catalog });
});

/**
 * Troca a caçada das contas indicadas sem desligar o monitor. Uma conta só ou
 * várias juntas: a diferença está apenas na lista que a interface manda.
 *
 * É a única escolha de caçada que o launcher faz, e sempre por clique: o
 * monitor nunca troca de mapa por conta própria.
 */
ipcMain.handle('leveling:hunt:set', async (event, indexes, ticket) => {
  launcherOnly(event);
  const lista = (Array.isArray(indexes) ? indexes : [indexes])
    .map(i => Number(i))
    .filter(i => Number.isInteger(i) && i >= 0 && i < accountCount);

  const result = await levelingHeadlessManager.setHunt(lista, ticket);
  if (!result.ok) {
    const motivo = result.error || (result.failed || []).map(f => f.error).join(',') || 'falhou';
    logErro('hunt', `contas ${lista.join(',')}: ${motivo}`);
  }
  return result;
});

/**
 * Resumo por item: quantas vendas, média, mediana, mínimo, máximo e o último
 * preço praticado. É a visão que responde "quanto vale isto" a partir do que
 * o launcher já acumulou.
 */
ipcMain.handle('leveling:market:summary', (event, opts) => {
  launcherOnly(event);
  const db = market();
  return {
    ...db.summary(opts || {}),
    stats: db.stats(),
    categories: db.categories()
  };
});

/** Vendas cruas, mais recentes primeiro — o feed da aba "ao vivo". */
ipcMain.handle('leveling:market:recent', (event, opts) => {
  launcherOnly(event);
  return { sales: market().recent(opts || {}) };
});

/** Um item em detalhe: série diária de preço e as vendas que a formaram. */
ipcMain.handle('leveling:market:item', (event, defId, opts) => {
  launcherOnly(event);
  return { item: market().itemDetail(defId, opts || {}) };
});

/**
 * Estatística do próprio servidor para um item. Complementa o banco: cobre o
 * período anterior ao primeiro uso do launcher, que o banco nunca terá.
 */
ipcMain.handle('leveling:market:hint', async (event, defId, days) => {
  launcherOnly(event);
  const client = levelingHeadlessManager.marketClient();
  if (!client) return { errorCode: 'market.noneActive' };
  try {
    return await client.marketPriceHint(defId, days);
  } catch (e) {
    return { errorCode: e.message };
  }
});

/** Força uma leitura agora, sem esperar o minuto do coletor. */
ipcMain.handle('leveling:market:poll', async event => {
  launcherOnly(event);
  const inserted = await levelingHeadlessManager.pollMarket();
  return { inserted, poll: levelingHeadlessManager.getMarketStats(), stats: market().stats() };
});

/**
 * Ícones, cores de raridade e sprites. A cópia de disco atende a primeira
 * abertura; a primeira conta a logar a substitui pela do servidor.
 */
ipcMain.handle('leveling:market:catalog', event => {
  launcherOnly(event);
  const salvo = levelingHeadlessManager.getMarketCatalog() || readMarketCatalogFile();
  if (salvo) levelingHeadlessManager.setMarketCatalog(salvo);
  return { catalog: levelingHeadlessManager.getMarketCatalog() };
});

/**
 * Anúncios à venda agora. É a única fonte das fichas: `MarketSale` não traz
 * nível de item nem potência de sombra, mas `MarketListing` traz os dois —
 * medido, `shadow{rank, level, power, quality, potential_total}` e
 * `item{level, rarity, slot}`. Preço pedido não é preço pago, então isto
 * complementa o histórico em vez de substituí-lo.
 */
ipcMain.handle('leveling:market:listings', async (event, filtros) => {
  launcherOnly(event);
  const client = levelingHeadlessManager.marketClient();
  if (!client) return { errorCode: 'market.noneActive', listings: [] };
  try {
    return await client.marketSearch(filtros || {});
  } catch (e) {
    return { errorCode: e.message, listings: [] };
  }
});

/**
 * Quem tem cada item, entre as contas em modo monitor.
 *
 * Pedido com a lista de itens que a tela está mostrando, não o inventário
 * inteiro: medido, `filter.def_ids` aceita 155 ids num pedido de 35 ms e o
 * servidor devolve só o que a conta tem. Uma página da tabela custa um pedido
 * por conta, em paralelo.
 *
 * Nada é guardado em disco. A posse muda a cada caçada; um número velho aqui
 * seria pior que número nenhum, porque pareceria atual.
 */
ipcMain.handle('leveling:market:owners', async (event, defIds) => {
  launcherOnly(event);
  const ids = Array.isArray(defIds) ? defIds.slice(0, 200) : [];
  if (!ids.length) return { byDef: {}, accounts: [], offline: [] };
  try {
    return await levelingHeadlessManager.inventoryOwners(ids);
  } catch (e) {
    return { errorCode: e.message, byDef: {}, accounts: [], offline: [] };
  }
});

/**
 * O inventário inteiro das contas em modo monitor, cruzado com o preço de
 * mercado de cada item — a aba "Minha bolsa".
 *
 * Varredura, não filtro: aqui não há lista prévia de itens, a pergunta é "o
 * que eu tenho". Medido: 4 pedidos e ~107 ms por conta, em paralelo.
 *
 * O cruzamento com o preço acontece aqui, no processo principal, porque é
 * onde o banco está: mandar o inventário cru para a interface a obrigaria a
 * pedir o resumo de cada item separadamente.
 */
ipcMain.handle('leveling:market:bag', async (event, opts) => {
  launcherOnly(event);
  try {
    const bags = await levelingHeadlessManager.inventoryBags();
    const dias = Number(opts && opts.days) || 0;
    const db = market();
    // Uma consulta só, grande: pedir item por item seria uma consulta por
    // linha de inventário, e são centenas por conta.
    const ids = new Set();
    for (const c of bags.contas) for (const id of Object.keys(c.owned)) ids.add(id);
    const precos = {};
    if (db && ids.size) {
      const page = db.summary({ days: dias, limit: 2000, includeExchange: true });
      for (const i of page.items) precos[i.def_id] = i;
    }
    return { ...bags, precos };
  } catch (e) {
    return { errorCode: e.message, contas: [], offline: [], precos: {} };
  }
});

/**
 * Preço por nível de um item.
 *
 * Responde "Topázio de que nível?" — a pergunta que o feed não responde,
 * porque `MarketSale` não tem o campo. O nível vem de `market_request{get}`
 * no anúncio já vendido, consultado em segundo plano pelo coletor, e por isso
 * a cobertura começa parcial e cresce: `coverage` existe para a tela poder
 * dizer sobre quantas vendas a quebra foi feita.
 */
ipcMain.handle('leveling:market:levels', (event, defId, opts) => {
  launcherOnly(event);
  const db = market();
  const o = { days: Number(opts && opts.days) || 0 };
  return {
    levels: db.levelBreakdown(defId, o),
    coverage: db.levelCoverage(defId, o)
  };
});

/**
 * Nível das vendas que estão na tela agora.
 *
 * A aba "Ao vivo" mostra justamente as vendas mais novas — as que o coletor
 * acabou de gravar e que ainda ninguém perguntou. A fila de fundo chegaria
 * nelas, porque vai da mais nova para a mais velha, mas "chegaria" pode ser
 * meia hora depois: o orçamento é de 40 por minuto e o banco tem milhares de
 * vendas atrasadas. Pedir pelos `listing_id` visíveis é o que faz o nível
 * aparecer na tela aberta em vez de no banco para depois.
 *
 * Teto de 100 por pedido. A tela manda em lotes menores que isso; o teto
 * existe para que um pedido malformado não vire uma varredura do banco
 * disfarçada de pergunta sobre a tela.
 */
ipcMain.handle('leveling:market:levels-for', async (event, listingIds) => {
  launcherOnly(event);
  const ids = Array.isArray(listingIds) ? listingIds.slice(0, 100) : [];
  if (!ids.length) return { levels: {} };
  await levelingHeadlessManager.enrichLevels(ids.length, ids);
  const db = market();
  return { levels: db.levelsOf(ids) };
});

/**
 * O inventário de uma conta, item por item, com o preço sugerido de cada um —
 * a aba "Anunciar".
 *
 * Uma conta só, escolhida pelo usuário, e não todas como na aba "Minha
 * bolsa": anunciar é uma ação sobre uma conta específica, e `MarketCreate`
 * sai do socket dela. Varrer as oito aqui seria tráfego para mostrar itens
 * que o usuário não vai anunciar nesta visita.
 *
 * O preço sai do banco local e, quando ele não basta, do servidor. A ordem
 * importa: o banco tem as vendas com nível, que é o que separa um Topázio de
 * 999 de um de 4 milhões; o `price_hint` cobre um período maior mas não sabe
 * de nível nenhum, então ele é a resposta de segunda escolha, não a primeira.
 */
ipcMain.handle('leveling:market:sellable', async (event, opts) => {
  launcherOnly(event);
  // A lista de contas acompanha toda resposta, inclusive as de erro: é ela
  // que monta o seletor, e sem ela a aba não teria como oferecer a troca de
  // conta justamente quando a escolhida está fora do monitor.
  const accounts = sniperAccounts();
  const pedido = opts && opts.index;
  if (pedido === null || pedido === undefined) return { accounts, items: [], account: null };

  const index = Number(pedido) || 0;
  const client = levelingHeadlessManager.getClient(index);
  if (!client || client.status !== 'connected') {
    return { errorCode: 'inv.offline', accounts, items: [], account: null };
  }

  const inv = await client.inventoryItems().catch(e => ({ errorCode: e.message, items: [] }));
  if (inv.errorCode) return { errorCode: inv.errorCode, accounts, items: [], account: null };

  const db = market();
  const dias = Number(opts && opts.days) || 0;

  // Cada combinação de item+nível é perguntada uma vez só, por mais linhas de
  // inventário que a compartilhem: cinco poções iguais são uma consulta.
  const cache = new Map();
  const precoDe = defId => {
    const key = defId.key;
    if (cache.has(key)) return cache.get(key);
    const vendas = db.salesForPricing(defId.defId, { level: defId.level, days: dias, limit: levelingListing.SAMPLE_SIZE });
    const r = levelingListing.suggestPrice(vendas);
    cache.set(key, r);
    return r;
  };

  const items = inv.items.map(it => {
    const bloqueio = levelingListing.sellableReason({
      uid: it.uid, locked: it.locked, equipped_slot: it.equippedSlot
    });
    const sugestao = precoDe({ defId: it.defId, level: it.level, key: `${it.defId}@${it.level}` });
    return {
      ...it,
      blocked: bloqueio,
      suggestion: sugestao.price,
      // A conta por trás do número. Sem ela "1,2 M" é um palpite que o
      // usuário não tem como julgar antes de confirmar.
      suggestionFrom: {
        samples: sugestao.samples,
        dropped: sugestao.dropped,
        median: sugestao.median,
        reason: sugestao.reason,
        source: sugestao.price ? 'local' : ''
      }
    };
  });

  // Quem o banco local não soube precificar vai ao servidor. Em lote por
  // `def_id`, não por linha: `price_hint` ignora nível, então perguntar duas
  // vezes pelo mesmo item daria a mesma resposta.
  const faltando = [...new Set(items.filter(i => !i.suggestion && !i.blocked).map(i => i.defId))];
  for (const defId of faltando.slice(0, 40)) {
    const hint = await client.marketPriceHint(defId, 30).catch(() => null);
    const preco = hint && !hint.errorCode
      ? Math.round(Number(hint.median) || Number(hint.average) || 0)
      : 0;
    if (!preco) continue;
    for (const it of items) {
      if (it.defId !== defId || it.suggestion) continue;
      it.suggestion = preco;
      it.suggestionFrom = {
        samples: Number(hint.sales) || 0, dropped: 0, median: preco,
        // O nível fica de fora porque `price_hint` não o conhece. A tela diz
        // isso: um preço de servidor num item que varia por nível é uma
        // estimativa mais grossa, e o usuário tem de poder ver a diferença.
        reason: '', source: 'server'
      };
    }
  }

  return {
    items,
    accounts,
    account: {
      index,
      name: (client.state && client.state.name) || '',
      connected: true
    },
    readAtMs: Date.now()
  };
});

/**
 * Cria os anúncios confirmados.
 *
 * Em série e tolerante a falha parcial: cada anúncio é um pedido, e o quinto
 * recusado não pode desfazer nem esconder os quatro que entraram. O resultado
 * vem linha a linha para a tela poder dizer exatamente o que aconteceu com
 * cada item.
 *
 * Antes de anunciar, o inventário é posto no estado que o servidor exige. Duas
 * recusas apareciam em item que o usuário via na conta e não conseguia vender:
 * `inventory.item_not_in_bag`, de peça guardada no depósito, e `market.locked`,
 * de peça com cadeado. As duas são desfazíveis por pedido, então o preparo as
 * desfaz aqui em vez de mandar o usuário ao jogo item por item.
 *
 * A ordem é mover e depois destrancar: a volta do depósito pode ser recusada
 * por bolsa cheia, e destrancar o que não chegou a sair de lá só mexeria no
 * inventário à toa.
 */
ipcMain.handle('leveling:market:announce', async (event, payload) => {
  launcherOnly(event);
  const index = Number(payload && payload.index) || 0;
  const client = levelingHeadlessManager.getClient(index);
  if (!client || client.status !== 'connected') {
    return { errorCode: 'inv.offline', results: [] };
  }

  const plano = levelingListing.planListings((payload && payload.drafts) || []);

  // O estado real do inventário, relido agora: os rascunhos vêm da tela, e a
  // tela pode estar olhando uma leitura de minutos atrás.
  const inv = await client.inventoryItems().catch(() => ({ items: [] }));
  const preparo = levelingListing.prepareListings(plano.ready, inv.items || []);

  const prepared = { moved: [], refused: [], unlocked: [], failed: [] };
  if (preparo.toBag.length) {
    const r = await client.warehouseMove(preparo.toBag, 'bag')
      .catch(() => ({ moved: [], refused: preparo.toBag }));
    prepared.moved = r.moved || [];
    prepared.refused = r.refused || [];
  }
  // Só destranca o que de fato está na mochila agora. Uma peça recusada pela
  // bolsa cheia continua trancada, que é o estado em que o usuário a deixou.
  const recusados = new Set(prepared.refused.map(String));
  for (const uid of preparo.unlock) {
    if (recusados.has(String(uid))) continue;
    const r = await client.lockItem(uid, false).catch(e => ({ errorCode: e.message }));
    if (r.errorCode) prepared.failed.push({ uid: String(uid), error: r.errorCode });
    else prepared.unlocked.push(String(uid));
  }

  const results = [];
  for (const draft of plano.ready) {
    const res = await client.marketCreate(draft).catch(e => ({ errorCode: e.message }));
    results.push({
      uid: draft.uid,
      name: draft.name,
      quantity: draft.quantity,
      total: draft.total,
      ok: !res.errorCode,
      error: res.errorCode || '',
      listingId: (res.listing && String(res.listing.id)) || ''
    });
  }
  return { results, blocked: plano.blocked, prepared };
});

/**
 * A aba "Meus anúncios": o que cada conta tem à venda e o que já vendeu.
 *
 * Todas as contas conectadas de uma vez, ao contrário de "Anunciar". A
 * pergunta aqui é de acompanhamento — "o que está de pé, o que saiu" —, e
 * respondê-la uma conta por vez faria o usuário clicar oito vezes para ter a
 * visão que ele queria desde o começo.
 *
 * Os anúncios ativos vêm do servidor (`mine`), que é a verdade do momento.
 * As vendas vêm do banco local, porque o servidor não guarda a lista das
 * vendas de uma conta — só o contador, que vem junto em `overview` e deixa a
 * aba admitir quanto do histórico ela não tem.
 */
ipcMain.handle('leveling:market:mine', async (event, opts) => {
  launcherOnly(event);
  const accounts = sniperAccounts();
  const dias = Number(opts && opts.days) || 0;
  const db = market();
  const contas = [];

  for (const conta of accounts) {
    const client = levelingHeadlessManager.getClient(conta.index);
    const vendas = db.mySales({ index: conta.index, days: dias });
    if (!client || client.status !== 'connected') {
      // Conta fora do monitor entra assim mesmo, com os anúncios
      // desconhecidos e as vendas que o banco guardou. Omiti-la diria que ela
      // não tem nada à venda, que é diferente de não saber.
      contas.push({ ...conta, offline: true, listings: [], sales: vendas });
      continue;
    }
    const [mine, overview] = await Promise.all([
      client.marketMine().catch(() => ({ listings: [] })),
      client.marketOverview().catch(() => ({}))
    ]);

    // `mine` devolve os anúncios de todos os status, não só os de pé.
    // Separá-los é o que impede um anúncio já vendido — sem data de expiração,
    // porque ele fechou — de aparecer em "À venda agora".
    const split = levelingListing.splitListings(mine.listings || []);
    contas.push({
      ...conta,
      offline: false,
      listings: split.active,
      // O que expirou ou foi cancelado não é venda nem anúncio: o item voltou
      // para a mochila, e a aba só precisa dizer quantos foram.
      closed: split.closed.length,
      active: mine.active || 0,
      limit: mine.limit || 0,
      // O servidor lembra de vendas que o launcher não viu acontecer: ele só
      // grava o push `market_push`, que exige estar aberto na hora exata.
      sales: levelingListing.mergeSales(
        vendas, split.sold.map(levelingListing.saleFromListing)
      ),
      overview: overview && !overview.errorCode ? overview : null
    });
  }

  return { contas, readAtMs: Date.now() };
});

/**
 * Retira um anúncio do mercado, a pedido do usuário.
 *
 * Escrita, e por isso por anúncio e por conta: não existe "cancelar todos".
 * Cada linha da aba tem o seu botão e a sua confirmação, porque o item que
 * volta pode ser o que o usuário queria vender e o anúncio que ele quis tirar
 * era o vizinho na tabela.
 *
 * `toMail` é repassado e importa: com a bolsa cheia o item não volta para o
 * inventário, vai para a caixa. Sem esse aviso o usuário procura a peça na
 * mochila, não acha, e conclui que o cancelamento a perdeu.
 */
ipcMain.handle('leveling:market:cancel', async (event, payload) => {
  launcherOnly(event);
  const index = Number(payload && payload.index) || 0;
  const id = String((payload && payload.id) || '');
  const client = levelingHeadlessManager.getClient(index);
  if (!client || client.status !== 'connected') return { ok: false, error: 'inv.offline' };

  const res = await client.marketCancel(id).catch(e => ({ errorCode: e.message }));
  if (res.errorCode) return { ok: false, error: res.errorCode };
  return { ok: true, id: res.id, toMail: !!res.toMail };
});

/** Saúde do acúmulo: desde quando, quantas vendas, tamanho do arquivo. */
ipcMain.handle('leveling:market:stats', event => {
  launcherOnly(event);
  return { stats: market().stats(), poll: levelingHeadlessManager.getMarketStats() };
});

ipcMain.handle('leveling:refill:get', event => {
  launcherOnly(event);
  return { config: readPrefs().refill, items: levelingRefill.ITEMS };
});

ipcMain.handle('leveling:refill:set', (event, config) => {
  launcherOnly(event);
  const saved = writePrefs({ refill: config }).refill;
  // Aplica nos monitores já em execução: o usuário acabou de mexer na tela de
  // refill, esperar o próximo login da conta seria inexplicável.
  levelingHeadlessManager.setRefillConfig(saved);
  return { ok: true, config: saved };
});

// ------------------------------------------------------------- expedição

/**
 * Estado da auto-expedição para a janela: a configuração salva e uma linha por
 * conta com quantas sombras estão fora e quando a primeira volta.
 *
 * As contas vêm junto, como no sniper, porque a tela tem uma caixinha por
 * conta: a lista de exceções precisa de nomes, e saber se o monitor daquela
 * conta está conectado é o que distingue "nenhuma expedição" de "não sei".
 *
 * `force` relê o painel no servidor. Sem ele a resposta usa o último painel
 * que o laço já leu — o normal ao abrir a janela, porque o painel vale por um
 * minuto e uma releitura por conta a cada abertura seria tráfego para mostrar
 * o mesmo número.
 */
async function expeditionState(force) {
  const creds = levelingCredentials.getPublicStatus();
  const report = await levelingHeadlessManager.expeditionReport({ force });
  const porIndice = new Map(report.accounts.map(a => [a.index, a]));

  // A lista é a das contas **configuradas**, não a dos monitores ativos: uma
  // conta sem monitor tem de aparecer para poder ser marcada, e some da tela
  // só quando as credenciais dela são apagadas.
  const accounts = (creds.accounts || []).map((entry, index) => {
    const vivo = porIndice.get(index);
    return {
      index,
      username: (entry && entry.username) || '',
      name: (vivo && vivo.name) || '',
      connected: !!(vivo && vivo.connected),
      enabled: !levelingHeadlessManager.getExpeditionConfig().disabled.includes(index),
      errorCode: (vivo && vivo.errorCode) || '',
      summary: (vivo && vivo.summary) || null,
      stats: (vivo && vivo.stats) || null
    };
  });

  return {
    config: levelingHeadlessManager.getExpeditionConfig(),
    accounts,
    limits: {
      minIntervalMs: levelingExpedition.MIN_INTERVAL_MS,
      maxIntervalMs: levelingExpedition.MAX_INTERVAL_MS
    }
  };
}

ipcMain.handle('leveling:expedition:get', async (event, opts) => {
  launcherOnly(event);
  return expeditionState(!!(opts && opts.force));
});

ipcMain.handle('leveling:expedition:set', async (event, config) => {
  launcherOnly(event);
  const saved = writePrefs({ expedition: config }).expedition;
  // Aplica nos monitores em execução: o usuário acabou de mexer na janela,
  // esperar o próximo login da conta seria inexplicável.
  levelingHeadlessManager.setExpeditionConfig(saved);
  return { ok: true, ...(await expeditionState(false)) };
});

/** Uma rodada agora em todas as contas que participam, sem esperar o relógio. */
ipcMain.handle('leveling:expedition:poll', async event => {
  launcherOnly(event);
  await levelingHeadlessManager.pollExpedition();
  return expeditionState(false);
});

/**
 * Estado do auto-boss para a tela. Mesma forma de `expeditionState`, e pelas
 * mesmas razões: a lista é a das contas **configuradas**, não a dos monitores
 * ativos — uma conta sem monitor tem de aparecer para poder ser marcada.
 *
 * O nível vai junto porque é o que explica um boss fora da fila: "nível 40
 * exigido, a conta tem 32" é a resposta que a tela precisa dar, e sem o nível
 * ela só poderia dizer "não deu".
 */
async function bossState(force) {
  const creds = levelingCredentials.getPublicStatus();
  const report = await levelingHeadlessManager.bossReport({ force });
  const porIndice = new Map(report.accounts.map(a => [a.index, a]));

  const accounts = (creds.accounts || []).map((entry, index) => {
    const vivo = porIndice.get(index);
    return {
      index,
      username: (entry && entry.username) || '',
      name: (vivo && vivo.name) || '',
      level: (vivo && vivo.level) || 0,
      connected: !!(vivo && vivo.connected),
      enabled: !levelingHeadlessManager.getBossConfig().disabled.includes(index),
      errorCode: (vivo && vivo.errorCode) || '',
      summary: (vivo && vivo.summary) || null,
      stats: (vivo && vivo.stats) || null
    };
  });

  return {
    config: levelingHeadlessManager.getBossConfig(),
    accounts,
    limits: {
      minIntervalMs: levelingBoss.MIN_INTERVAL_MS,
      maxIntervalMs: levelingBoss.MAX_INTERVAL_MS
    }
  };
}

ipcMain.handle('leveling:boss:get', async (event, opts) => {
  launcherOnly(event);
  return bossState(!!(opts && opts.force));
});

ipcMain.handle('leveling:boss:set', async (event, config) => {
  launcherOnly(event);
  const saved = writePrefs({ boss: config }).boss;
  // Aplica nos monitores em execução: o usuário acabou de mexer na janela, e
  // esperar o próximo login da conta seria inexplicável.
  levelingHeadlessManager.setBossConfig(saved);
  return { ok: true, ...(await bossState(false)) };
});

/**
 * Uma rodada agora em todas as contas que participam.
 *
 * `force` ignora o dia já feito. Existe porque o usuário que equipou a conta
 * depois de uma rodada fraca quer tentar o que sobrou — e forçar não gasta
 * tentativa duas vezes: o servidor marca `done_today`, e o boss já feito sai da
 * fila na própria leitura do estado.
 */
ipcMain.handle('leveling:boss:poll', async (event, opts) => {
  launcherOnly(event);
  await levelingHeadlessManager.pollBoss({ force: !!(opts && opts.force) });
  return bossState(false);
});

/**
 * Estado do sniper para a tela: regras salvas, o log da sessão e quais contas
 * podem pagar.
 *
 * As contas vêm juntas porque cada regra escolhe a sua — e o seletor precisa
 * saber não só o nome, mas se o monitor daquela conta está conectado: uma
 * regra apontada para uma conta offline nunca compra, e dizer isso na hora de
 * configurar é melhor que descobrir no log.
 */
function sniperAccounts() {
  const creds = levelingCredentials.getPublicStatus();
  return (creds.accounts || []).map((entry, index) => {
    const client = levelingHeadlessManager.getClient(index);
    const state = (client && client.state) || null;
    const conectada = !!client && client.status === 'connected';
    return {
      index,
      username: (entry && entry.username) || '',
      name: (state && state.name) || '',
      connected: conectada,
      // Saldo da conta, para o seletor dizer com o que ela pode pagar. `null`
      // quando ela está fora do monitor: o saldo vem do snapshot da sessão, e
      // mostrar o último conhecido como se fosse o de agora faria o usuário
      // pôr um teto de compra em cima de um ouro que já foi gasto.
      gold: conectada ? Number(state && state.gold) || 0 : null,
      diamonds: conectada ? Number(state && state.diamonds) || 0 : null
    };
  });
}

function sniperMarketAccountStatus() {
  const client = levelingHeadlessManager.getClient(-1);
  return {
    connected: !!client && client.status === 'connected',
    status: client ? client.status : 'disconnected',
    name: client?.state?.name || '',
    proxy: client?.proxy ? String(client.proxy).replace(/:\/\/[^@/]+@/, '://***@') : '',
    configured: !!levelingCredentials.getSniper().username,
    ip: client?.proxyIpAddress || ''
  };
}

ipcMain.handle('leveling:sniper-account:ip', async event => {
  launcherOnly(event);
  const client = levelingHeadlessManager.getClient(-1);
  if (!client) return { ip: '', error: 'Conta Sniper offline.' };
  const result = await client.proxyPublicIp();
  if (result.ip) client.proxyIpAddress = result.ip;
  return result;
});

ipcMain.handle('leveling:sniper:get', event => {
  launcherOnly(event);
  return {
    config: readPrefs().sniper,
    accounts: sniperAccounts(),
    marketAccount: sniperMarketAccountStatus(),
    log: levelingHeadlessManager.getSniperLog(),
    stats: levelingHeadlessManager.getSniperStats(),
    limits: {
      minIntervalMs: levelingSniper.MIN_INTERVAL_MS,
      maxIntervalMs: levelingSniper.MAX_INTERVAL_MS,
      maxRules: levelingSniper.MAX_RULES
    },
    // Câmbio não está no `content_catalog` — é `MARKET_KIND_EXCHANGE`, não
    // um `ItemDef` —, então a tela nunca teria como sugerir "diamante". A
    // lista vem do domínio para a busca por nome alcançá-lo.
    exchanges: levelingSniper.EXCHANGE_DEFS
  };
});

/**
 * Salva as regras e aplica na hora.
 *
 * Ligar e desligar passa por aqui, não por um canal próprio: o interruptor é
 * um campo da configuração, e um canal separado abriria a chance de a tela
 * mostrar "ligado" com uma lista de regras que não foi salva.
 */
ipcMain.handle('leveling:sniper:set', (event, config) => {
  launcherOnly(event);
  // Aplica **antes** de gravar, e grava o que o serviço aceitou.
  //
  // A ordem inversa persistia o bug do alvo: a tela manda a sua cópia da
  // configuração, que tem o contador de comprados velho, e gravar essa cópia
  // primeiro deixava `bought: 0` no disco. O serviço corrigia em memória, mas
  // o próximo `prefs.json` lido — reinício, ou o `sniperSink` da compra
  // seguinte partindo do disco — trazia o zero de volta e a regra comprava
  // outra vez.
  const aplicada = levelingHeadlessManager.setSniperConfig(config);
  writePrefs({ sniper: aplicada });
  syncSniperPoll();
  return {
    ok: true,
    config: levelingHeadlessManager.getSniperConfig(),
    stats: levelingHeadlessManager.getSniperStats()
  };
});

/**
 * Acrescenta uma regra ao sniper, vinda da janela do mercado.
 *
 * Canal próprio, e não `sniper:set`: aquele recebe a configuração **inteira**
 * e é da tela do sniper, que a tem completa. A janela do mercado não tem — e
 * se mandasse a sua ideia de configuração apagaria as regras que não conhece.
 * Aqui só se acrescenta.
 *
 * A regra nasce desligada do alvo de ninguém e habilitada: o usuário já
 * confirmou o teto e a quantidade numa tela antes de chegar aqui.
 */
ipcMain.handle('leveling:sniper:add', (event, rule) => {
  launcherOnly(event);
  const atual = levelingHeadlessManager.getSniperConfig();
  const nova = levelingSniper.normalizeRule({
    defId: (rule && rule.defId) || '',
    name: (rule && rule.name) || '',
    maxGold: (rule && rule.maxGold) || 0,
    maxDiamond: (rule && rule.maxDiamond) || 0,
    target: (rule && rule.target) || 0,
    account: (rule && rule.account) || 0,
    enabled: true
  });
  if (!nova) return { ok: false, error: 'sniper.ruleInvalid' };

  // Item que já tem regra é substituição, não duplicata: `normalizeConfig`
  // funde pela chave de qualquer forma, e dizer qual dos dois casos aconteceu
  // é o que faz a tela saber se escreveu "adicionada" ou "atualizada".
  const existia = atual.rules.some(r => r.id === nova.id);
  const rules = atual.rules.filter(r => r.id !== nova.id).concat(nova);
  if (rules.length > levelingSniper.MAX_RULES) {
    return { ok: false, error: 'sniper.tooManyRules' };
  }

  const aplicada = levelingHeadlessManager.setSniperConfig({ ...atual, rules });
  writePrefs({ sniper: aplicada });
  syncSniperPoll();
  return { ok: true, replaced: existia, rule: nova, config: aplicada };
});

/** Uma varredura agora, sem esperar o intervalo. */
ipcMain.handle('leveling:sniper:poll', async event => {
  launcherOnly(event);
  const bought = await levelingHeadlessManager.pollSniper();
  return {
    bought,
    stats: levelingHeadlessManager.getSniperStats(),
    log: levelingHeadlessManager.getSniperLog()
  };
});

ipcMain.handle('leveling:sniper:log', event => {
  launcherOnly(event);
  return { log: levelingHeadlessManager.getSniperLog(), stats: levelingHeadlessManager.getSniperStats() };
});

ipcMain.handle('leveling:sniper:log-clear', event => {
  launcherOnly(event);
  levelingHeadlessManager.clearSniperLog();
  return { ok: true };
});

// ----------------------------------------------------------- auto-anunciar

/**
 * Estado do auto-anunciar para a tela.
 *
 * As contas vêm junto, como no sniper, porque a tela tem uma caixinha por
 * conta — e saber se o monitor daquela conta está conectado importa: uma conta
 * fora do monitor nunca anuncia, e dizer isso aqui é melhor que deixar o
 * usuário esperar uma rodada que não vem.
 *
 * `catalogReady` existe porque é a causa mais provável de uma rodada vazia que
 * parece quebrada: sem catálogo nada é classificado, logo nada é anunciado, e
 * a tela precisa poder dizer "espere o primeiro login" em vez de nada.
 *
 * `rate` é a cotação do diamante, e vem sempre — não só no modo diamante. A
 * tela a mostra para o usuário poder decidir **antes** de trocar a moeda: sem
 * amostra de câmbio no banco, o modo diamante vende pouco, e descobrir isso
 * depois de ligá-lo seria uma rodada vazia sem explicação.
 */
function autosellState() {
  const creds = levelingCredentials.getPublicStatus();
  const catalogo = levelingHeadlessManager.getMarketCatalog();
  return {
    rate: market().exchangeRate({ days: 7 }),
    config: levelingHeadlessManager.getAutosellConfig(),
    accounts: (creds.accounts || []).map((entry, index) => {
      const client = levelingHeadlessManager.getClient(index);
      return {
        index,
        username: (entry && entry.username) || '',
        name: (client && client.state && client.state.name) || '',
        connected: !!client && client.status === 'connected'
      };
    }),
    log: levelingHeadlessManager.getAutosellLog(),
    stats: levelingHeadlessManager.getAutosellStats(),
    catalogReady: !!(catalogo && catalogo.items),
    limits: {
      minIntervalMs: levelingAutosell.MIN_INTERVAL_MS,
      maxIntervalMs: levelingAutosell.MAX_INTERVAL_MS,
      maxPerRoundCap: levelingAutosell.MAX_PER_ROUND_CAP
    }
  };
}

ipcMain.handle('leveling:autosell:get', event => {
  launcherOnly(event);
  return autosellState();
});

/**
 * Salva a configuração e aplica na hora.
 *
 * Aplica antes de gravar, e grava o que o serviço aceitou — pelo mesmo motivo
 * do sniper: o que o serviço normaliza é o que vai rodar, e persistir a cópia
 * da tela deixaria no disco um valor que nunca foi usado.
 */
ipcMain.handle('leveling:autosell:set', (event, config) => {
  launcherOnly(event);
  const aplicada = levelingHeadlessManager.setAutosellConfig(config);
  writePrefs({ autosell: aplicada });
  syncAutosellPoll();
  return { ok: true, ...autosellState() };
});

/**
 * Uma rodada agora, sem esperar o intervalo.
 *
 * É escrita: o botão da tela é o que o usuário aperta para ver o que o laço
 * faria, e o teto de `maxPerRound` vale aqui igual — não há caminho que
 * anuncie mais que isso de uma vez.
 */
ipcMain.handle('leveling:autosell:poll', async event => {
  launcherOnly(event);
  const listed = await levelingHeadlessManager.pollAutosell();
  return { listed, ...autosellState() };
});

ipcMain.handle('leveling:autosell:log', event => {
  launcherOnly(event);
  return {
    log: levelingHeadlessManager.getAutosellLog(),
    stats: levelingHeadlessManager.getAutosellStats()
  };
});

/**
 * O que o auto-anunciar venderia, agregado por item: o picker da lista de
 * bloqueio.
 *
 * Leitura cara (uma varredura de bolsa por conta), então é pedida sob demanda
 * — ao abrir o picker — e não junto de `autosell:get`, que a tela chama a cada
 * salvamento.
 */
ipcMain.handle('leveling:autosell:candidates', async event => {
  launcherOnly(event);
  return levelingHeadlessManager.autosellCandidates();
});

/**
 * Liga ou desliga o bloqueio de um item.
 *
 * Canal próprio em vez de passar pelo `set` inteiro: o picker mexe numa lista
 * que pode ter dezenas de linhas, e mandar a configuração completa a cada
 * caixinha marcada arriscaria sobrescrever um piso de preço que o usuário
 * acabou de ajustar na outra metade da tela.
 */
ipcMain.handle('leveling:autosell:block', (event, payload) => {
  launcherOnly(event);
  const defId = String((payload && payload.defId) || '');
  const bloquear = !!(payload && payload.blocked);
  const atual = levelingHeadlessManager.getAutosellConfig();
  const aplicada = levelingHeadlessManager.setAutosellConfig(
    levelingAutosell.withBlocked(atual, defId, bloquear)
  );
  writePrefs({ autosell: aplicada });
  return { ok: true, config: aplicada };
});

ipcMain.handle('leveling:autosell:log-clear', event => {
  launcherOnly(event);
  levelingHeadlessManager.clearAutosellLog();
  return { ok: true };
});

// ------------------------------------------------------------------- câmbio

/**
 * O que a tela do câmbio precisa saber.
 *
 * `limits` vai junto porque os pisos do módulo são a explicação dos campos
 * travados: a tela mostra "mínimo 100.000" ao lado da reserva em vez de aceitar
 * um valor e silenciosamente subi-lo.
 */
function cambioState() {
  const creds = levelingCredentials.getPublicStatus();
  return {
    ...levelingHeadlessManager.cambioStatus(),
    // As contas vêm junto, como no auto-anunciar, e aqui são indispensáveis: a
    // tela precisa nomear a conta de destino e mostrar o saldo de cada uma.
    // Dizer qual está fora do monitor evita a espera por um hop que não vem —
    // um hop precisa de **duas** contas conectadas.
    accounts: (creds.accounts || []).map((entry, index) => {
      const client = levelingHeadlessManager.getClient(index);
      return {
        index,
        username: (entry && entry.username) || '',
        name: (client && client.state && client.state.name) || '',
        gold: (client && client.state && client.state.gold) || 0,
        connected: !!client && client.status === 'connected'
      };
    }),
    limits: {
      minReserva: levelingCambio.MIN_RESERVE,
      minIntervalMs: levelingCambio.MIN_INTERVAL_MS,
      maxIntervalMs: levelingCambio.MAX_INTERVAL_MS,
      minAmount: levelingCambio.MIN_AMOUNT
    }
  };
}

ipcMain.handle('leveling:cambio:get', event => {
  launcherOnly(event);
  return cambioState();
});

/**
 * Salva a configuração e aplica na hora.
 *
 * Aplica antes de gravar, e grava o que o serviço aceitou — mesmo motivo do
 * sniper e do auto-anunciar: o que o serviço normaliza é o que vai rodar, e
 * persistir a cópia da tela deixaria no disco um valor que nunca foi usado.
 * Aqui isso pesa mais: a reserva da tela pode vir abaixo do piso.
 */
ipcMain.handle('leveling:cambio:set', (event, config) => {
  launcherOnly(event);
  const aplicada = levelingHeadlessManager.setCambioConfig(config);
  writePrefs({ cambio: aplicada });
  syncCambioPoll();
  return { ok: true, ...cambioState() };
});

/**
 * Um hop agora, sem esperar o intervalo.
 *
 * Move ouro de verdade, então é o botão mais perigoso do launcher — mas é
 * também o único jeito de o usuário ver a cadeia funcionando antes de confiar
 * nela por uma noite. As mesmas guardas valem: reserva, conferência antes de
 * travar, e um hop por vez.
 */
ipcMain.handle('leveling:cambio:poll', async event => {
  launcherOnly(event);
  // `force`: fura o intervalo, e só ele. O laço já roda sozinho — o que o
  // botão existe para pular é justamente a espera entre um hop e o seguinte.
  // A reserva, o hop único e a conferência antes de travar continuam valendo.
  const resultado = await levelingHeadlessManager.pollCambio({ force: true });
  return { resultado, ...cambioState() };
});

/**
 * Resgata o ouro do correio de todas as contas em monitor, agora.
 *
 * É escrita, mas é a mais inofensiva da tela: nada sai da conta, só entra. O
 * ouro de venda estava parado na caixa e passa para o saldo da mesma conta.
 */
ipcMain.handle('leveling:cambio:mail', async event => {
  launcherOnly(event);
  const resultado = await levelingHeadlessManager.cambioCorreioTodos();
  return { resultado, ...cambioState() };
});

ipcMain.handle('leveling:cambio:log', event => {
  launcherOnly(event);
  return {
    log: levelingHeadlessManager.getCambioLog(),
    stats: levelingHeadlessManager.cambioStats
  };
});

ipcMain.handle('leveling:cambio:log-clear', event => {
  launcherOnly(event);
  levelingHeadlessManager.clearCambioLog();
  return { ok: true };
});

// --------------------------------------------------------------- auto-status

/**
 * O que a tela do status precisa saber.
 *
 * `statsReport` já traz as contas, as classes e o relatório; o que falta é o
 * nome de usuário das contas que **não** estão em monitor. Sem isso a tela não
 * conseguiria nomear a linha de uma conta desconectada, e é exatamente nela que
 * o usuário quer escolher a build antes de conectar.
 */
function statsState() {
  const creds = levelingCredentials.getPublicStatus();
  const report = levelingHeadlessManager.statsReport();
  const porIndice = new Map(report.accounts.map(c => [c.index, c]));

  return {
    ...report,
    accounts: (creds.accounts || []).map((entry, index) => {
      const linha = porIndice.get(index);
      const username = (entry && entry.username) || '';
      if (linha) return { ...linha, username };
      // Conta com credencial mas sem monitor nenhum: aparece com a escolha
      // salva e `connected: false`, em vez de sumir da lista.
      return {
        index,
        username,
        name: '',
        connected: false,
        enabled: levelingStats.accountEnabled(levelingHeadlessManager.statsConfig, index),
        stats: null,
        ...levelingStats.summarize({
          config: levelingHeadlessManager.statsConfig,
          index,
          catalog: levelingHeadlessManager.getClassCatalog()
        })
      };
    }),
    limits: { pointsPerLevel: report.pointsPerLevel }
  };
}

ipcMain.handle('leveling:stats:get', event => {
  launcherOnly(event);
  return statsState();
});

/**
 * Salva a configuração e aplica na hora.
 *
 * Aplica antes de gravar, e grava o que o serviço aceitou, como no câmbio: o
 * que o serviço normaliza é o que vai rodar. Aqui isso pesa mais que em
 * qualquer outra automação — uma build inexistente ou pesos todos em zero viram
 * "sem configuração", e persistir a cópia crua da tela deixaria no disco uma
 * escolha que nunca seria usada.
 *
 * Ligar isto já distribui: `setStatsConfig` zera o recuo e chama a distribuição
 * nas contas conectadas que têm ponto parado. É deliberado — o usuário que
 * acabou de escolher a build espera ver os pontos saírem, não esperar o nível
 * seguinte.
 */
ipcMain.handle('leveling:stats:set', (event, config) => {
  launcherOnly(event);
  const aplicada = levelingHeadlessManager.setStatsConfig(config);
  writePrefs({ stats: aplicada });
  return { ok: true, ...statsState() };
});

/**
 * Distribui agora em todas as contas que participam.
 *
 * Gasta ponto de verdade e não tem desfazer barato, mas é o único jeito de o
 * usuário conferir a divisão antes de confiar no automático — e a prévia da
 * janela mostra exatamente o que vai sair antes do clique.
 */
ipcMain.handle('leveling:stats:run', async event => {
  launcherOnly(event);
  return await levelingHeadlessManager.pollStats();
});

ipcMain.handle('leveling:stats:log', event => {
  launcherOnly(event);
  return { log: levelingHeadlessManager.getStatsLog() };
});

ipcMain.handle('leveling:stats:log-clear', event => {
  launcherOnly(event);
  levelingHeadlessManager.clearStatsLog();
  return { ok: true };
});

// ---------------------------------------------------------------- auto-forja

/**
 * O que a tela da forja precisa saber.
 *
 * Mesma costura do status: `forgeReport` traz as contas em monitor, as
 * raridades e as regras; o que falta é o nome de usuário das contas
 * desconectadas, para a linha delas poder ser nomeada antes de conectar.
 */
async function forgeState(options = {}) {
  const creds = levelingCredentials.getPublicStatus();
  const report = await levelingHeadlessManager.forgeReport(options);
  const porIndice = new Map(report.accounts.map(c => [c.index, c]));

  return {
    ...report,
    accounts: (creds.accounts || []).map((entry, index) => {
      const linha = porIndice.get(index);
      const username = (entry && entry.username) || '';
      if (linha) return { ...linha, username };
      return {
        index,
        username,
        name: '',
        connected: false,
        enabled: levelingForge.accountEnabled(levelingHeadlessManager.forgeConfig, index),
        stats: null,
        summary: null
      };
    })
  };
}

ipcMain.handle('leveling:forge:get', async (event, options) => {
  launcherOnly(event);
  return await forgeState(options || {});
});

/**
 * Salva a configuração e aplica na hora.
 *
 * Aplica antes de gravar e grava o que o serviço aceitou, como no status: o que
 * o serviço normaliza é o que vai rodar.
 *
 * Ao contrário do status, salvar **não** forja: `setForgeConfig` só zera o
 * recuo. Uma rodada apaga peças, e o gesto de salvar a tela não pode ser o que
 * começa a destruir inventário — quem dispara é o próximo drop, ou o botão.
 */
ipcMain.handle('leveling:forge:set', async (event, config) => {
  launcherOnly(event);
  const aplicada = levelingHeadlessManager.setForgeConfig(config);
  writePrefs({ forge: aplicada });
  return { ok: true, ...(await forgeState()) };
});

/**
 * Uma rodada agora em todas as contas que participam.
 *
 * Destrói equipamento de verdade: a janela mostra o déficit e o custo estimado
 * antes do clique, e os tetos de fusão e desmonte por rodada valem aqui igual.
 */
ipcMain.handle('leveling:forge:run', async event => {
  launcherOnly(event);
  await levelingHeadlessManager.pollForge();
  return await forgeState();
});

ipcMain.handle('leveling:forge:log', event => {
  launcherOnly(event);
  return { log: levelingHeadlessManager.getForgeLog() };
});

ipcMain.handle('leveling:forge:log-clear', event => {
  launcherOnly(event);
  levelingHeadlessManager.clearForgeLog();
  return { ok: true };
});

ipcMain.handle('window:control', (event, action) => {
  if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) return null;
  if (action === 'minimize') mainWindow.minimize();
  else if (action === 'maximize') {
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
  } else if (action === 'close') mainWindow.close();
  else if (action !== 'state') return null;
  return { maximized: !mainWindow.isDestroyed() && mainWindow.isMaximized() };
});

ipcMain.handle('shell:open-external', (event, url) => {
  launcherOnly(event);
  openOutside(url);
  return true;
});

ipcMain.handle('errlog:open', event => {
  launcherOnly(event);
  const file = LOG_FILE();
  try {
    if (!fs.existsSync(file)) fs.writeFileSync(file, '');
    shell.openPath(file);
    return true;
  } catch (e) {
    logErro('errlog', e.message);
    return false;
  }
});

ipcMain.handle('errlog:write', (_event, origem, mensagem) => {
  logErro(origem || 'renderer', String(mensagem || '').slice(0, 2000));
  return true;
});

// --------------------------------------------------------- janela do mercado

/**
 * As janelas auxiliares não são um navegador: zoom diferente de 100% faz
 * controles e relatórios desaparecerem da viewport, além de poder ficar salvo
 * para a próxima abertura. Mantém todas essas telas em escala fixa.
 */
function fixStandaloneWindowZoom(window) {
  const reset = () => resetStandaloneWindowZoom(window);

  reset();
  window.webContents.on('did-finish-load', reset);
  window.webContents.on('before-input-event', (event, input) => {
    if (!(input.control || input.meta)) return;
    if (!['+', '-', '=', '_', '0'].includes(input.key)) return;
    event.preventDefault();
    if (input.key === '0') reset();
  });
}

function resetStandaloneWindowZoom(window) {
  if (window.isDestroyed()) return;
  window.webContents.setZoomFactor(1);
  if (typeof window.webContents.setVisualZoomLevelLimits === 'function') {
    window.webContents.setVisualZoomLevelLimits(0, 0).catch(() => {});
  }
}

/**
 * O mercado numa janela própria.
 *
 * Era um modal sobre o launcher, e isso o inutilizava para a sua razão de
 * existir: comparar preço enquanto se decide o que vender no jogo. Um modal
 * cobre os painéis e prende o teclado — era preciso fechá-lo para olhar o
 * inventário, e aí o preço sumia da vista.
 *
 * Janela de verdade, não `alwaysOnTop`: fixar por cima resolveria o "ver
 * junto" e criaria um estorvo que fica na frente de tudo, inclusive do que
 * não é o jogo. Uma janela normal o usuário põe onde quiser, inclusive no
 * segundo monitor, e o sistema cuida do resto.
 *
 * Uma só. Clicar no botão com a janela aberta foca a que existe em vez de
 * empilhar cópias disputando o mesmo banco.
 */
let marketWindow = null;

function openMarketWindow() {
  if (marketWindow && !marketWindow.isDestroyed()) {
    resetStandaloneWindowZoom(marketWindow);
    if (marketWindow.isMinimized()) marketWindow.restore();
    marketWindow.focus();
    return true;
  }

  marketWindow = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 760,
    minHeight: 480,
    title: 'Mercado · Leveling Idle 2D',
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#0b0f14',
    // Sem `parent`: janela filha no Windows fica sempre à frente da mãe e é
    // arrastada junto quando ela minimiza. O ponto aqui é o oposto — poder
    // deixar o mercado de lado e mexer no jogo.
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      // O coletor roda no processo principal, mas a tela repinta quando ele
      // traz vendas novas; sem isto a janela em segundo plano acumularia
      // repinturas para entregar todas de uma vez ao voltar.
      backgroundThrottling: false,
      spellcheck: false
    }
  });

  fixStandaloneWindowZoom(marketWindow);
  marketWindow.loadFile(path.join(__dirname, 'market.html'));
  marketWindow.once('ready-to-show', () => marketWindow.show());

  // Mesma política da janela principal: nada navega para fora, e o que tentar
  // vai para o navegador do sistema.
  marketWindow.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file://')) {
      e.preventDefault();
      openOutside(url);
    }
  });
  marketWindow.webContents.setWindowOpenHandler(({ url }) => {
    openOutside(url);
    return { action: 'deny' };
  });

  marketWindow.on('closed', () => { marketWindow = null; });
  return true;
}

ipcMain.handle('leveling:sniper-account:get', event => {
  launcherOnly(event);
  return levelingCredentials.getPublicStatus().sniper;
});

function othersState() {
  const creds = levelingCredentials.getPublicStatus();
  return {
    config: levelingHeadlessManager.getOthersConfig(),
    accounts: (creds.accounts || []).map((entry, index) => {
      const client = levelingHeadlessManager.getClient(index);
      return {
        index,
        username: (entry && entry.username) || '',
        name: (client && client.state && client.state.name) || '',
        connected: !!client && client.status === 'connected'
      };
    }),
    log: levelingHeadlessManager.getOthersLog(),
    stats: levelingHeadlessManager.getOthersStats(),
    limits: {
      minIntervalMs: levelingOthers.MIN_INTERVAL_MS,
      maxIntervalMs: levelingOthers.MAX_INTERVAL_MS
    }
  };
}

ipcMain.handle('leveling:others:get', event => {
  launcherOnly(event);
  return othersState();
});

ipcMain.handle('leveling:others:set', (event, config) => {
  launcherOnly(event);
  const applied = levelingHeadlessManager.setOthersConfig(config);
  writePrefs({ others: applied });
  syncMailPoll();
  syncOthersPoll();
  return { ok: true, ...othersState() };
});

ipcMain.handle('leveling:others:poll', async event => {
  launcherOnly(event);
  return { resultado: await levelingHeadlessManager.pollOthers(), ...othersState() };
});

ipcMain.handle('leveling:others:log-clear', event => {
  launcherOnly(event);
  levelingHeadlessManager.clearOthersLog();
  return { ok: true };
});

let othersWindow = null;
function openOthersWindow() {
  if (othersWindow && !othersWindow.isDestroyed()) {
    resetStandaloneWindowZoom(othersWindow);
    if (othersWindow.isMinimized()) othersWindow.restore();
    othersWindow.focus();
    return true;
  }
  othersWindow = new BrowserWindow({
    width: 980,
    height: 720,
    minWidth: 680,
    minHeight: 440,
    title: 'Outros · Leveling Idle 2D',
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#0b0f14',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), backgroundThrottling: false, spellcheck: false }
  });
  fixStandaloneWindowZoom(othersWindow);
  othersWindow.loadFile(path.join(__dirname, 'outros.html'));
  othersWindow.once('ready-to-show', () => othersWindow.show());
  othersWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://')) { event.preventDefault(); openOutside(url); }
  });
  othersWindow.webContents.setWindowOpenHandler(({ url }) => { openOutside(url); return { action: 'deny' }; });
  othersWindow.on('closed', () => { othersWindow = null; });
  return true;
}

ipcMain.handle('leveling:others:window', event => {
  launcherOnly(event);
  return openOthersWindow();
});
ipcMain.handle('leveling:sniper-account:set', (event, username, password, proxy) => {
  launcherOnly(event);
  const old = levelingCredentials.getSniper();
  const ok = levelingCredentials.setSniper(username, password || old.password, proxy);
  if (ok) {
    levelingHeadlessManager.stop(-1);
    startDedicatedSniperMarketAccount();
  }
  return { ok, account: levelingCredentials.getPublicStatus().sniper };
});

ipcMain.handle('leveling:market:window', event => {
  launcherOnly(event);
  return openMarketWindow();
});

/**
 * Janela de gerenciamento de proxies. Independente, semelhante ao mercado.
 */
let proxiesWindow = null;

function openProxiesWindow() {
  if (proxiesWindow && !proxiesWindow.isDestroyed()) {
    if (proxiesWindow.isMinimized()) proxiesWindow.restore();
    proxiesWindow.focus();
    return;
  }

  try {
    proxiesWindow = new BrowserWindow({
      width: 1200,
      height: 800,
      minWidth: 600,
      minHeight: 400,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        nodeIntegration: false,
        contextIsolation: true,
        enableRemoteModule: false
      }
    });

    const proxyHtml = path.join(__dirname, 'proxies.html');
    proxiesWindow.loadFile(proxyHtml);
    proxiesWindow.once('ready-to-show', () => proxiesWindow.show());

    proxiesWindow.on('closed', () => { proxiesWindow = null; });
  } catch (e) {
    logErro('proxies-window', e.message);
  }
}

ipcMain.handle('leveling:proxies:window', event => {
  launcherOnly(event);
  return openProxiesWindow();
});

/**
 * Janela de cadastro assistido.
 */
let signupWindow = null;

function openSignupWindow() {
  if (signupWindow && !signupWindow.isDestroyed()) {
    if (signupWindow.isMinimized()) signupWindow.restore();
    signupWindow.focus();
    return;
  }

  try {
    signupWindow = new BrowserWindow({
      width: 900,
      height: 1000,
      minWidth: 600,
      minHeight: 600,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        nodeIntegration: false,
        contextIsolation: true,
        enableRemoteModule: false
      }
    });

    const signupHtml = path.join(__dirname, 'cadastro.html');
    signupWindow.loadFile(signupHtml);
    signupWindow.once('ready-to-show', () => signupWindow.show());

    signupWindow.on('closed', () => { signupWindow = null; });
  } catch (e) {
    logErro('signup-window', e.message);
  }
}

ipcMain.handle('leveling:signup:window', event => {
  launcherOnly(event);
  return openSignupWindow();
});

/**
 * A janela onde a conta é de fato cadastrada, uma por conta.
 *
 * Ela carrega o jogo na **partição da conta** (`persist:contaN`), e é isso que
 * faz a ideia funcionar: a partição é compartilhada por nome, então o token que
 * o cadastro gravar aqui é o mesmo que a WebView do painel vai ler. Terminado o
 * cadastro, a janela fecha e o painel recarrega já logado — sem repetir login.
 *
 * O proxy também vem da partição: `applyAccountProxy()` chamou `setProxy` nela,
 * e a autenticação do proxy é respondida no evento `login` de
 * `web-contents-created`. A janela nasce na rota da conta sem fazer nada aqui.
 *
 * É uma janela separada, e não a WebView do painel, porque o captcha precisa de
 * espaço e foco: o Turnstile num painel de um quarto da tela é difícil de
 * resolver, e trocar de aba no meio descartaria a WebView junto com o desafio.
 */
const signupTabs = new Map();

function openSignupTab(index) {
  const num = index + 1;

  const existente = signupTabs.get(index);
  if (existente && !existente.isDestroyed()) {
    if (existente.isMinimized()) existente.restore();
    existente.focus();
    return { ok: true, already: true };
  }

  try {
    // A sessão e o proxy antes da janela: carregar o jogo sem rota aplicada
    // sairia pelo IP da máquina, que é exatamente o que o proxy evita.
    applyAccountCapacity(Math.ceil(num / ACCOUNTS_PER_TAB));
    applyAccountProxy(index);

    /*
     * Sem rota, sem janela. Cadastrar é o pior momento para descobrir que a
     * conta saiu pelo IP errado: o captcha já foi resolvido à mão, e o nome
     * fica queimado se o servidor recusar.
     */
    const dados = levelingCredentials.load();
    const poolAtual = dados.proxyPool || new LevelingProxyPool();
    const porta = poolAtual.canOpen(index);
    if (!porta.ok) {
      return { ok: false, error: `Conta ${num}: ${porta.motivo}.` };
    }

    const creds = levelingCredentials.get(index);

    // Escalonadas: com duas contas no mesmo plano, as janelas nasciam uma
    // exatamente sobre a outra e parecia que só a de cima tinha sido
    // preenchida. O deslocamento é por janela já aberta, não pelo índice da
    // conta, senão a conta 7 abriria fora da tela.
    const desloco = signupTabs.size * 40;
    const win = new BrowserWindow({
      width: 760,
      height: 900,
      minWidth: 420,
      minHeight: 600,
      x: 80 + desloco,
      y: 40 + desloco,
      title: `Cadastrar conta ${num}` + (creds.username ? ` — ${creds.username}` : ''),
      webPreferences: {
        partition: 'persist:conta' + num,
        preload: path.join(__dirname, 'src', 'main', 'account-preload.js'),
        nodeIntegration: false,
        contextIsolation: false,
        sandbox: false
      }
    });

    signupTabs.set(index, win);
    win.loadURL(GAME_URL);
    win.once('ready-to-show', () => win.show());
    win.on('closed', () => { signupTabs.delete(index); });
    return { ok: true };
  } catch (e) {
    logErro('signup-tab', `conta${num}: ${e.message}`);
    return { ok: false, error: e.message };
  }
}

ipcMain.handle('leveling:signup:tab', (event, index) => {
  launcherOnly(event);
  const i = Math.max(0, +index || 0);
  return openSignupTab(i);
});

/**
 * Janela do sniper. Mesma decisão do mercado, e por um motivo a mais: o log
 * só é útil enquanto o jogo está na frente — é lá que o usuário vai ver se o
 * item chegou. Como modal ele cobriria justamente o que se quer olhar.
 *
 * `leveling:sniper:window-close` não existe: a janela fecha por Esc através de
 * `leveling:market:window-close`, que já fecha a janela do remetente e não a
 * do mercado especificamente.
 */
let sniperWindow = null;

function openSniperWindow() {
  if (sniperWindow && !sniperWindow.isDestroyed()) {
    resetStandaloneWindowZoom(sniperWindow);
    if (sniperWindow.isMinimized()) sniperWindow.restore();
    sniperWindow.focus();
    return true;
  }

  sniperWindow = new BrowserWindow({
    width: 1100,
    height: 780,
    minWidth: 720,
    minHeight: 460,
    title: 'Sniper do mercado · Leveling Idle 2D',
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#0b0f14',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      // O laço roda no processo principal e empurra cada linha de log para a
      // tela. Sem isto a janela em segundo plano juntaria as repinturas e o
      // log apareceria em blocos ao voltar — e o log é a razão da janela.
      backgroundThrottling: false,
      spellcheck: false
    }
  });

  fixStandaloneWindowZoom(sniperWindow);
  sniperWindow.loadFile(path.join(__dirname, 'sniper.html'));
  sniperWindow.once('ready-to-show', () => sniperWindow.show());

  sniperWindow.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file://')) {
      e.preventDefault();
      openOutside(url);
    }
  });
  sniperWindow.webContents.setWindowOpenHandler(({ url }) => {
    openOutside(url);
    return { action: 'deny' };
  });

  sniperWindow.on('closed', () => { sniperWindow = null; });
  return true;
}

ipcMain.handle('leveling:sniper:window', event => {
  launcherOnly(event);
  return openSniperWindow();
});

/**
 * Janela da auto-expedição. Mesma decisão do sniper: a tela diz quando cada
 * conta volta a ter sombra livre, e isso se consulta *enquanto* o jogo está na
 * frente. Como modal ela cobriria os painéis justamente para mostrar um prazo
 * de horas.
 *
 * Fecha por Esc através de `leveling:market:window-close`, que fecha a janela
 * do remetente — não a do mercado especificamente.
 */
let expeditionWindow = null;

function openExpeditionWindow() {
  if (expeditionWindow && !expeditionWindow.isDestroyed()) {
    resetStandaloneWindowZoom(expeditionWindow);
    if (expeditionWindow.isMinimized()) expeditionWindow.restore();
    expeditionWindow.focus();
    return true;
  }

  expeditionWindow = new BrowserWindow({
    width: 1000,
    height: 740,
    minWidth: 680,
    minHeight: 440,
    title: 'Auto-expedição · Leveling Idle 2D',
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#0b0f14',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      // Os prazos correm na tela de segundo em segundo e o laço empurra cada
      // coleta. Sem isto a janela em segundo plano juntaria as repinturas e o
      // relógio apareceria aos saltos ao voltar.
      backgroundThrottling: false,
      spellcheck: false
    }
  });

  fixStandaloneWindowZoom(expeditionWindow);
  expeditionWindow.loadFile(path.join(__dirname, 'expedition.html'));
  expeditionWindow.once('ready-to-show', () => expeditionWindow.show());

  expeditionWindow.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file://')) {
      e.preventDefault();
      openOutside(url);
    }
  });
  expeditionWindow.webContents.setWindowOpenHandler(({ url }) => {
    openOutside(url);
    return { action: 'deny' };
  });

  expeditionWindow.on('closed', () => { expeditionWindow = null; });
  return true;
}

ipcMain.handle('leveling:expedition:window', event => {
  launcherOnly(event);
  return openExpeditionWindow();
});

/**
 * Janela do auto-boss. Mesma decisão das outras três: a pergunta desta tela é
 * "quais bosses saíram hoje em cada conta", e isso se consulta com o jogo na
 * frente. Como modal ela cobriria os painéis para mostrar um relatório diário.
 *
 * Fecha por Esc através de `leveling:market:window-close`, que fecha a janela
 * do remetente — não a do mercado especificamente.
 */
let bossWindow = null;

function openBossWindow() {
  if (bossWindow && !bossWindow.isDestroyed()) {
    resetStandaloneWindowZoom(bossWindow);
    if (bossWindow.isMinimized()) bossWindow.restore();
    bossWindow.focus();
    return true;
  }

  bossWindow = new BrowserWindow({
    width: 1000,
    height: 740,
    minWidth: 680,
    minHeight: 440,
    title: 'Auto-boss diário · Leveling Idle 2D',
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#0b0f14',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      // A contagem até a virada do dia corre na tela de segundo em segundo, e
      // cada boss terminado empurra uma linha no relatório. Sem isto a janela
      // em segundo plano juntaria as repinturas.
      backgroundThrottling: false,
      spellcheck: false
    }
  });

  fixStandaloneWindowZoom(bossWindow);
  bossWindow.loadFile(path.join(__dirname, 'boss.html'));
  bossWindow.once('ready-to-show', () => bossWindow.show());

  bossWindow.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file://')) {
      e.preventDefault();
      openOutside(url);
    }
  });
  bossWindow.webContents.setWindowOpenHandler(({ url }) => {
    openOutside(url);
    return { action: 'deny' };
  });

  bossWindow.on('closed', () => { bossWindow = null; });
  return true;
}

ipcMain.handle('leveling:boss:window', event => {
  launcherOnly(event);
  return openBossWindow();
});

/**
 * Janela do auto-anunciar. Mesma decisão das outras: a pergunta desta tela —
 * "o que ele anunciou, por quanto, e com base em qual preço" — se confere com
 * o jogo na frente, e como modal ela cobriria os painéis.
 */
let autosellWindow = null;

function openAutosellWindow() {
  if (autosellWindow && !autosellWindow.isDestroyed()) {
    resetStandaloneWindowZoom(autosellWindow);
    if (autosellWindow.isMinimized()) autosellWindow.restore();
    autosellWindow.focus();
    return true;
  }

  autosellWindow = new BrowserWindow({
    width: 1060,
    height: 760,
    minWidth: 720,
    minHeight: 460,
    title: 'Auto-anunciar · Leveling Idle 2D',
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#0b0f14',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      // Cada anúncio empurra uma linha no relatório por evento. Sem isto a
      // janela em segundo plano juntaria as repinturas e a linha do item que
      // acabou de ser vendido apareceria minutos depois.
      backgroundThrottling: false,
      spellcheck: false
    }
  });

  fixStandaloneWindowZoom(autosellWindow);
  autosellWindow.loadFile(path.join(__dirname, 'autosell.html'));
  autosellWindow.once('ready-to-show', () => autosellWindow.show());

  autosellWindow.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file://')) {
      e.preventDefault();
      openOutside(url);
    }
  });
  autosellWindow.webContents.setWindowOpenHandler(({ url }) => {
    openOutside(url);
    return { action: 'deny' };
  });

  autosellWindow.on('closed', () => { autosellWindow = null; });
  return true;
}

ipcMain.handle('leveling:autosell:window', event => {
  launcherOnly(event);
  return openAutosellWindow();
});

/**
 * Janela do câmbio. Mesma decisão das outras, e com o motivo mais forte: a
 * pergunta desta tela — "quanto saiu de qual conta, e quando" — só se confere
 * com os saldos do jogo na frente, e como modal ela cobriria exatamente os
 * painéis que precisam ser lidos.
 */
let cambioWindow = null;

function openCambioWindow() {
  if (cambioWindow && !cambioWindow.isDestroyed()) {
    resetStandaloneWindowZoom(cambioWindow);
    if (cambioWindow.isMinimized()) cambioWindow.restore();
    cambioWindow.focus();
    return true;
  }

  cambioWindow = new BrowserWindow({
    width: 1020,
    height: 740,
    minWidth: 720,
    minHeight: 460,
    title: 'Câmbio · Leveling Idle 2D',
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#0b0f14',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      // O hop leva segundos e a etapa corrente muda a cada um deles. Com a
      // repintura estrangulada, a tela mostraria "aproximar" muito depois de a
      // troca já ter fechado.
      backgroundThrottling: false,
      spellcheck: false
    }
  });

  fixStandaloneWindowZoom(cambioWindow);
  cambioWindow.loadFile(path.join(__dirname, 'cambio.html'));
  cambioWindow.once('ready-to-show', () => cambioWindow.show());

  cambioWindow.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file://')) {
      e.preventDefault();
      openOutside(url);
    }
  });
  cambioWindow.webContents.setWindowOpenHandler(({ url }) => {
    openOutside(url);
    return { action: 'deny' };
  });

  cambioWindow.on('closed', () => { cambioWindow = null; });
  return true;
}

ipcMain.handle('leveling:cambio:window', event => {
  launcherOnly(event);
  return openCambioWindow();
});

/**
 * Janela do status. Mesma decisão das outras: é uma tela de conferência, com
 * uma linha por conta e a prévia da divisão de cada uma, e como modal cobriria
 * o painel que mostra o nível e os pontos parados.
 */
let statsWindow = null;

function openStatsWindow() {
  if (statsWindow && !statsWindow.isDestroyed()) {
    resetStandaloneWindowZoom(statsWindow);
    if (statsWindow.isMinimized()) statsWindow.restore();
    statsWindow.focus();
    return true;
  }

  statsWindow = new BrowserWindow({
    width: 1020,
    height: 760,
    minWidth: 720,
    minHeight: 460,
    title: 'Status · Leveling Idle 2D',
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#0b0f14',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      spellcheck: false
    }
  });

  fixStandaloneWindowZoom(statsWindow);
  statsWindow.loadFile(path.join(__dirname, 'stats.html'));
  statsWindow.once('ready-to-show', () => statsWindow.show());

  statsWindow.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file://')) {
      e.preventDefault();
      openOutside(url);
    }
  });
  statsWindow.webContents.setWindowOpenHandler(({ url }) => {
    openOutside(url);
    return { action: 'deny' };
  });

  statsWindow.on('closed', () => { statsWindow = null; });
  return true;
}

ipcMain.handle('leveling:stats:window', event => {
  launcherOnly(event);
  return openStatsWindow();
});

/**
 * Janela da forja. Mesma decisão das outras, e aqui com o motivo mais direto:
 * a tela tem uma grade de onze slots por conta, e é a conferência que o usuário
 * faz **antes** de autorizar a destruição de peças.
 */
let forgeWindow = null;

function openForgeWindow() {
  if (forgeWindow && !forgeWindow.isDestroyed()) {
    resetStandaloneWindowZoom(forgeWindow);
    if (forgeWindow.isMinimized()) forgeWindow.restore();
    forgeWindow.focus();
    return true;
  }

  forgeWindow = new BrowserWindow({
    width: 1080,
    height: 800,
    minWidth: 760,
    minHeight: 480,
    title: 'Forja · Leveling Idle 2D',
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#0b0f14',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      spellcheck: false
    }
  });

  fixStandaloneWindowZoom(forgeWindow);
  forgeWindow.loadFile(path.join(__dirname, 'forge.html'));
  forgeWindow.once('ready-to-show', () => forgeWindow.show());

  forgeWindow.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file://')) {
      e.preventDefault();
      openOutside(url);
    }
  });
  forgeWindow.webContents.setWindowOpenHandler(({ url }) => {
    openOutside(url);
    return { action: 'deny' };
  });

  forgeWindow.on('closed', () => { forgeWindow = null; });
  return true;
}

ipcMain.handle('leveling:forge:window', event => {
  launcherOnly(event);
  return openForgeWindow();
});

ipcMain.handle('leveling:market:window-close', event => {
  launcherOnly(event);
  // Fecha a janela de quem pediu. Vem da própria janela do mercado (Esc), e
  // usar o remetente em vez de `marketWindow` mantém isso correto mesmo que
  // um dia exista mais de uma.
  const janela = BrowserWindow.fromWebContents(event.sender);
  if (janela && !janela.isDestroyed() && janela !== mainWindow) janela.close();
  return true;
});

// ------------------------------------------------------------------- utilidades

/** Abre links no navegador do sistema; nunca numa janela do launcher. */
function openOutside(url) {
  try {
    const parsed = new URL(String(url));
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') shell.openExternal(parsed.href);
  } catch {}
}

function applyKeepAwake(on) {
  try {
    if (on && sleepBlockerId === null) {
      sleepBlockerId = powerSaveBlocker.start('prevent-app-suspension');
    } else if (!on && sleepBlockerId !== null) {
      powerSaveBlocker.stop(sleepBlockerId);
      sleepBlockerId = null;
    }
  } catch (e) {
    logErro('awake', e.message);
  }
}

/**
 * `hide()` + `show()` no Windows perde o estado maximizado, então ele é
 * rastreado e reaplicado ao voltar da bandeja.
 */
let wasMaximized = true;

function showWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const restore = wasMaximized;
  mainWindow.show();
  if (restore && !mainWindow.isMaximized()) mainWindow.maximize();
  mainWindow.focus();
}

function buildTray() {
  const icon = path.join(__dirname, process.platform === 'win32' ? 'icon.ico' : 'icon.png');
  if (!fs.existsSync(icon)) return;
  try {
    tray = new Tray(icon);
    tray.setToolTip('Leveling Idle 2D · Launcher');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Mostrar', click: showWindow },
      { type: 'separator' },
      { label: 'Sair', click: () => app.quit() }
    ]));
    // Clique simples alterna: na bandeja é o gesto esperado para esconder.
    tray.on('click', () => {
      if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()) mainWindow.hide();
      else showWindow();
    });
    tray.on('double-click', showWindow);
  } catch (e) {
    logErro('tray', e.message);
  }
}

// ------------------------------------------------------------------------ janela

function createWindow() {
  const prefs = readPrefs();
  applyAccountCapacity(prefs.tabs);
  // O manager guarda a config para que um monitor iniciado por `bootMonitor`
  // já nasça repondo, sem depender de a tela de refill ter sido aberta.
  levelingHeadlessManager.setRefillConfig(prefs.refill);
  // Mesma razão para o sniper: com `bootMonitor` as contas conectam antes de
  // qualquer tela abrir, e as regras salvas têm de estar valendo nesse momento
  // — é justamente o cenário de deixar o launcher caçando pechincha sozinho.
  levelingHeadlessManager.setSniperConfig(prefs.sniper);
  // E para a expedição: com `bootMonitor` as contas conectam antes de qualquer
  // janela abrir, e é justamente o cenário de deixar o launcher recolhendo e
  // reenviando expedições sozinho por horas.
  levelingHeadlessManager.setExpeditionConfig(prefs.expedition);
  // E para o boss: a rodada é uma por dia, e a janela do auto-boss não fica
  // aberta. Sem a config valendo no boot, um launcher que subiu em monitor
  // perderia o dia inteiro esperando alguém abrir a tela.
  levelingHeadlessManager.setBossConfig(prefs.boss);
  // Repõe o log gravado antes de qualquer tela abrir. Aqui, e não no topo do
  // arquivo, porque `app.getPath('userData')` só é confiável depois do ready —
  // e `sniper:get` responde com este log: sem a reposição a janela diria "o
  // log está vazio" por cima de um arquivo que existe.
  const sniperLogSalvo = readSniperLogFile();
  if (sniperLogSalvo) levelingHeadlessManager.setSniperLog(sniperLogSalvo);

  // E para o auto-anunciar, pelo motivo mais forte da lista: é o único que
  // **vende** item. Com `bootMonitor` as contas conectam sem nenhuma tela
  // aberta, e a configuração que vale nesse instante é a que decide o piso de
  // preço. Subir no padrão por cima de um piso ajustado à mão seria vender
  // mais barato do que o usuário autorizou.
  levelingHeadlessManager.setAutosellConfig(prefs.autosell);
  const autosellLogSalvo = readAutosellLogFile();
  if (autosellLogSalvo) levelingHeadlessManager.setAutosellLog(autosellLogSalvo);

  // E para o câmbio, que é o fim da escala: ele **move ouro entre contas**, e
  // uma troca confirmada não volta. A configuração que vale no boot é a que
  // decide para qual conta o ouro vai — subir no padrão (`destino: 1`) por cima
  // de uma escolha deliberada mandaria tudo para a conta errada.
  //
  // `cambioLastAtMs` entra junto, e não é detalhe: sem ele, um launcher que
  // reinicia logo depois de um hop liberaria o seguinte na hora, furando o
  // intervalo inteiro que o usuário escolheu.
  levelingHeadlessManager.setCambioConfig(prefs.cambio);
  levelingHeadlessManager.setCambioLog(readCambioLogFile() || [], prefs.cambioLastAtMs);
  // O laço não parte aqui mesmo com o câmbio ligado: um hop precisa de duas
  // contas conectadas, e nenhuma está no boot. Quem o liga é o `status` da
  // segunda conta, via `syncCambioPoll`.
  syncCambioPoll();

  // E o status, que é o único cujo erro cobra **recurso do personagem** para
  // desfazer: ponto alocado só volta com token de respec ou cristal. A build
  // salva é a que vale no boot, porque uma conta que subiu de nível com o
  // launcher fechado tem pontos parados e eles são distribuídos no próprio
  // login — no padrão da classe, se a escolha do usuário não for restaurada
  // antes.
  //
  // O catálogo em disco entra primeiro: sem ele, o `character_state` do login
  // chegaria antes das builds e a distribuição recuaria um minuto por
  // `stats.noCatalog`.
  levelingHeadlessManager.setClassCatalog(readClassesFile());
  levelingHeadlessManager.setStatsConfig(prefs.stats);
  levelingHeadlessManager.setStatsLog(readStatsLogFile() || []);

  // E a forja, pelo mesmo motivo levado ao extremo: peça desmontada não volta
  // de jeito nenhum, nem pagando. O alvo salvo é o que vale no boot; sem
  // restaurá-lo a automação nasceria desligada e sem alvo, que é o padrão —
  // seguro, mas não é o que o usuário escolheu.
  levelingHeadlessManager.setForgeConfig(prefs.forge);
  levelingHeadlessManager.setForgeLog(readForgeLogFile() || []);
  levelingHeadlessManager.setOthersConfig(prefs.others);
  levelingHeadlessManager.setOthersLog(readOthersLogFile() || []);
  // Não há laço a ligar: a distribuição é disparada pelo `character_patch` de
  // cada conta, que é o pacote que anuncia os pontos novos.

  mainWindow = new BrowserWindow({
    width: 1600,
    height: 900,
    title: 'Leveling Idle 2D · Launcher',
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#0b0f14',
    ...(process.platform === 'win32' ? { frame: false, thickFrame: true } : {}),
    webPreferences: {
      webviewTag: true,
      preload: path.join(__dirname, 'preload.js'),
      backgroundThrottling: false,
      spellcheck: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    mainWindow.maximize();
  });

  mainWindow.on('maximize', () => { wasMaximized = true; });
  mainWindow.on('unmaximize', () => { wasMaximized = false; });

  // Minimizar para a bandeja libera a barra de tarefas; sem bandeja a janela
  // ficaria inalcançável, então o esconder só vale quando há ícone.
  mainWindow.on('minimize', () => {
    if (readPrefs().minToTray && tray) mainWindow.hide();
  });

  for (const event of ['hide', 'minimize']) mainWindow.on(event, () => notifyVisibility(false));
  for (const event of ['show', 'restore', 'focus']) mainWindow.on(event, () => notifyVisibility(true));
  mainWindow.webContents.on('did-finish-load', () => {
    // Reenvia após cada carga: o renderer novo não sabe o estado da janela.
    windowVisible = null;
    notifyVisibility(mainWindow.isVisible() && !mainWindow.isMinimized());
  });

  memProbe = createMemoryProbe({
    app,
    webContents: require('electron').webContents,
    opts: memOpts,
    getState: () => ({
      vis: mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible() && !mainWindow.isMinimized() ? 1 : 0,
      mon: levelingHeadlessManager.clients.size
    }),
    onTrayAfter: () => { try { mainWindow?.hide(); } catch {} },
    onShowAfter: showWindow,
    onDuration: () => app.quit()
  });
  const memFile = memProbe.start();
  if (memFile) logErro('mem', 'telemetria de memoria em ' + memFile);
  mainWindow.on('closed', () => memProbe?.stop());

  // A janela principal só mostra index.html. Qualquer navegação sai para o
  // navegador: se houvesse XSS, isso fecha o caminho de exfiltração.
  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file://')) {
      e.preventDefault();
      openOutside(url);
    }
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    openOutside(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => { mainWindow = null; });

  applyKeepAwake(readPrefs().keepAwake);
}

// As WebViews do jogo abrem popups (pagamento, login social) que devem ir para
// o navegador, não virar janelas sem moldura dentro do launcher.
app.on('web-contents-created', (_event, contents) => {
  const type = contents.getType();
  contents.on('render-process-gone', (_goneEvent, details) => {
    logGraphicsEvent('render-process-gone', {
      type,
      webContentsId: contents.id,
      reason: details && details.reason,
      exitCode: details && details.exitCode,
      url: contents.getURL() || ''
    });
  });
  contents.on('unresponsive', () => {
    logGraphicsEvent('renderer-unresponsive', {
      type,
      webContentsId: contents.id,
      url: contents.getURL() || ''
    });
  });
  contents.on('responsive', () => {
    logGraphicsEvent('renderer-responsive', {
      type,
      webContentsId: contents.id
    });
  });

  /*
   * Proxy com autenticação: o Chromium não aceita usuário e senha na regra, e
   * pede aqui. Responder uma vez só evita laço infinito com senha errada.
   *
   * Fora do bloco `webview` de propósito: a janela de cadastro é uma
   * `BrowserWindow` na partição da conta, e sem isto ela ficaria presa no
   * desafio do proxy — justamente a janela que precisa sair pela rota certa.
   */
  const asked = new Set();
  contents.on('login', (event, _request, authInfo, callback) => {
    if (!authInfo.isProxy) return;
    const index = accountIndexOf(contents.session);
    const creds = proxyAuth.get(index + 1);
    if (!creds || asked.has(index)) return;
    asked.add(index);
    event.preventDefault();
    callback(creds.username, creds.password);
  });

  if (type !== 'webview') return;

  contents.on('console-message', (_consoleEvent, level, message, line, sourceId) => {
    if (!/(webgl|gpu|context|renderer)/i.test(String(message))) return;
    logGraphicsEvent('webview-console', {
      webContentsId: contents.id,
      level,
      message: String(message).slice(0, 1000),
      line,
      sourceId
    });
  });
  contents.on('did-fail-load', (_loadEvent, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame) return;
    logGraphicsEvent('webview-did-fail-load', {
      webContentsId: contents.id,
      errorCode,
      errorDescription,
      url: validatedURL || ''
    });
  });

  contents.setWindowOpenHandler(({ url }) => {
    openOutside(url);
    return { action: 'deny' };
  });
  contents.on('will-navigate', (e, url) => {
    try {
      if (new URL(url).origin !== GAME_ORIGIN) {
        e.preventDefault();
        openOutside(url);
      }
    } catch {
      e.preventDefault();
    }
  });
});

ipcMain.on('graphics:webgl', (event, kind) => {
  if (event.sender.getType() !== 'webview') return;
  const allowed = new Set(['contextlost', 'contextrestored']);
  if (!allowed.has(kind)) return;
  logGraphicsEvent('webgl-' + kind, {
    webContentsId: event.sender.id,
    account: accountIndexOf(event.sender.session) + 1,
    url: event.sender.getURL() || ''
  });
});

/**
 * O token da sessão web, pedido pelo preload da conta antes de a página rodar.
 * Síncrono porque o preload precisa gravá-lo antes do bundle do jogo; é uma
 * leitura de cache, não de disco, no caminho comum.
 */
ipcMain.on('leveling:token:get', event => {
  const index = accountIndexOf(event.sender.session);
  event.returnValue = index >= 0 ? (levelingCredentials.get(index).token || '') : '';
});

/**
 * O que o preload deve digitar no formulário de autenticação da aba.
 *
 * Síncrono pelo mesmo motivo de `leveling:token:get`: o preload precisa da
 * resposta antes de o bundle do jogo montar a tela, e esperar uma promessa
 * perderia a corrida.
 *
 * `register` só sai quando a credencial está marcada como pendente de
 * cadastro; nesse caso a conta ainda não existe e mostrar a aba de login seria
 * um beco sem saída. Nos outros casos vai `login`, com a senha que o monitor
 * já usa, para não obrigar a redigitar a cada volta do modo monitor.
 *
 * A senha atravessa o IPC aqui porque não há alternativa: é o próprio campo do
 * formulário que precisa dela, e o preload é o único código do launcher que
 * alcança aquele DOM. O destino é a partição da própria conta.
 */
ipcMain.on('leveling:signup:prefill', event => {
  const index = accountIndexOf(event.sender.session);
  if (index < 0) {
    event.returnValue = null;
    return;
  }
  const creds = levelingCredentials.get(index);
  if (!creds.username || !creds.password) {
    event.returnValue = null;
    return;
  }
  event.returnValue = {
    mode: creds.signup ? 'register' : 'login',
    username: creds.username,
    password: creds.password,
    email: creds.email || '',
    // A classe só interessa no cadastro: é ela que diz qual cartão marcar no
    // modal que o jogo abre numa conta sem classe.
    classId: creds.signup ? (creds.classId || '') : ''
  };
});

/**
 * O preload terminou os modais da conta nova: email dispensado, classe
 * escolhida e confirmada, convite de visual recusado.
 *
 * A conta está pronta, então ela vai para o modo monitor — que é onde o
 * launcher a quer. Fechar a janela antes de ligar o monitor não é um detalhe de
 * ordem: as duas sessões se derrubam, e o servidor mantém uma por conta.
 */
ipcMain.on('leveling:signup:post-done', event => {
  const index = accountIndexOf(event.sender.session);
  if (index < 0) return;

  const tab = signupTabs.get(index);
  if (!tab || tab.isDestroyed() || tab.webContents !== event.sender) return;

  levelingCredentials.clearSignupFlag(index);
  signupTabs.delete(index);
  try {
    tab.close();
  } catch { /* já fechando */ }

  const creds = levelingCredentials.get(index);
  if (!creds.username || !creds.password) return;

  // Um tique depois: a sessão da janela precisa soltar o socket antes de o
  // monitor abrir o dele, senão o servidor derruba um dos dois.
  setTimeout(() => {
    try {
      // Pelo pool, como o `leveling:start`: a conta recém-cadastrada já tem
      // rota atribuída, e `creds.proxy` é o campo legado que não serve ao monitor.
      levelingHeadlessManager.start(index, { ...creds, proxy: accountProxyUrl(index) });
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('leveling:signup:monitor', { index });
      }
    } catch (e) {
      logErro('signup-monitor', `conta${index + 1}: ${e.message}`);
    }
  }, 1500);
});

/** A página trocou o token (login manual, renovação): o monitor usa o novo. */
ipcMain.on('leveling:token:set', (event, token) => {
  const index = accountIndexOf(event.sender.session);
  if (index < 0) return;
  const valor = typeof token === 'string' ? token : '';
  levelingCredentials.setToken(index, valor);

  /*
   * A janela de cadastro **não** fecha aqui, e isso é deliberado: o token chega
   * no `auth_ok`, que é *antes* dos modais de email, classe e visual. Fechar
   * agora mataria a janela no meio deles.
   *
   * Quem fecha é `leveling:signup:post-done`, que o preload manda quando os
   * modais acabaram. O token guardado aqui já é o que a WebView do painel vai
   * ler para subir logada.
   */
});

app.whenReady().then(() => {
  try {
    logGraphicsEvent('gpu-feature-status', app.getGPUFeatureStatus());
    app.getGPUInfo('basic')
      .then(info => logGraphicsEvent('gpu-info', info))
      .catch(error => logErro('gpu-info', error && error.message || String(error)));
  } catch (error) {
    logErro('gpu-status', error && error.message || String(error));
  }
  createWindow();
  buildTray();
  // Antes do monitor: uma conta sem rota atribuída não abre, e é aqui que ela
  // ganha uma se houver proxy aprovado sobrando no pool.
  reconcileProxyRoutes();
  startDedicatedSniperMarketAccount();
});

app.on('second-instance', showWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (!BrowserWindow.getAllWindows().length) createWindow();
});

app.on('before-quit', () => {
  levelingHeadlessManager.stopAll();
  applyKeepAwake(false);
  memProbe?.stop();
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
});

module.exports = { GAME_URL, ACCOUNTS, ACCOUNTS_PER_TAB, MAX_TABS, LAYOUTS };

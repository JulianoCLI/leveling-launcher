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
const levelingListing = require('./src/domain/leveling-listing');
const { levelingCredentials } = require('./src/domain/leveling-credentials');
const { createMemoryProbe, parseArgs: parseMemArgs } = require('./src/main/memory-probe');

/** Contas por aba. A aba é a unidade de crescimento do launcher. */
const ACCOUNTS_PER_TAB = 4;
const ACCOUNTS = ACCOUNTS_PER_TAB;
const MAX_TABS = 16;
/**
 * Arranjos da grade, por aba:
 *
 *   split — o de sempre: células iguais, uma por painel;
 *   focus — um painel grande e os outros em faixa menor ao lado;
 *   solo  — um painel ocupando a aba inteira. Os outros continuam vivos,
 *           só não são pintados: é a diferença entre esconder e descarregar;
 *   cols  — todos lado a lado em colunas;
 *   rows  — todos empilhados em linhas.
 */
const LAYOUTS = ['split', 'focus', 'solo', 'cols', 'rows'];
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

// Mantém a composição fora da GPU, como no launcher irmão: menos RAM de vídeo
// e nenhuma diferença visível numa interface de painéis.
app.commandLine.appendSwitch('disable-gpu-compositing');

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

process.on('uncaughtException', err => logErro('uncaught', err && err.stack || String(err)));
process.on('unhandledRejection', err => logErro('rejection', err && err.stack || String(err)));

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
   * Quantos painéis e se sobe em monitor, **por aba**: cada grupo de contas
   * tende a ter um uso próprio — uma aba de quatro jogando, outra só de
   * monitores. `panels` e `bootMonitor` na raiz são o padrão de uma aba nova.
   */
  tabPrefs: [],
  keepAwake: false,
  muted: false,
  minToTray: true,
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
  expedition: levelingExpedition.defaultConfig()
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
  raw.tabPrefs = Array.from({ length: raw.tabs }, (_, t) => {
    const tab = herdado[t] || {};
    const panels = Math.min(ACCOUNTS_PER_TAB, Math.max(1, +tab.panels || +raw.panels || ACCOUNTS_PER_TAB));
    return {
      panels,
      bootMonitor: tab.bootMonitor === undefined ? !!raw.bootMonitor : !!tab.bootMonitor,
      /** Arranjo da grade. `split` é o de sempre; os outros vieram depois. */
      layout: LAYOUTS.includes(tab.layout) ? tab.layout : 'split',
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
 * Aponta a partição da conta para o proxy configurado. É por partição, não por
 * aplicação, porque o ponto é justamente que contas diferentes saiam por IPs
 * diferentes: o servidor recusa várias contas vindas do mesmo endereço.
 *
 * O Chromium quer regras no formato `esquema://host:porta` e não lê credenciais
 * da URL, então o usuário e a senha são respondidos no `login` do webContents.
 */
function applyAccountProxy(index) {
  const num = index + 1;
  const proxy = levelingCredentials.get(index).proxy || '';
  try {
    const ses = session.fromPartition('persist:conta' + num);
    if (typeof ses.setProxy !== 'function') return;

    if (!proxy) {
      ses.setProxy({ mode: 'system' }).catch(e => logErro('proxy', `conta${num}: ${e.message}`));
      proxyAuth.delete(num);
      return;
    }

    const url = new URL(proxy);
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
  setLevels: linhas => { try { return market().setLevels(linhas); } catch { return 0; } }
};

function syncMarketPoll() {
  const ativa = [...levelingHeadlessManager.clients.values()]
    .some(c => c && c.status === 'connected');
  if (ativa) levelingHeadlessManager.startMarketPoll();
  else levelingHeadlessManager.stopMarketPoll();
}

levelingHeadlessManager.on('status', syncMarketPoll);
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
const LAUNCHER_PAGES = ['index.html', 'market.html', 'sniper.html', 'expedition.html'].map(
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
  try {
    // O monitor precisa sair pelo mesmo IP da WebView da conta; falhar aqui é
    // melhor que conectar pela rota errada e tomar `session.multi_account_ip`.
    levelingHeadlessManager.start(index, creds);
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

ipcMain.handle('leveling:proxy:set', (event, index, proxy) => {
  launcherOnly(event);
  // O monitor em curso está conectado pela rota antiga; derrubá-lo é o que
  // garante que a nova valha para os dois modos.
  const wasRunning = levelingHeadlessManager.getClient(index) !== null;
  levelingHeadlessManager.stop(index);
  pendingUpdates.delete(index);

  const ok = levelingCredentials.setProxy(index, proxy);
  applyAccountProxy(index);
  return { ok, wasRunning, status: levelingCredentials.getPublicStatus() };
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
 */
ipcMain.handle('leveling:market:announce', async (event, payload) => {
  launcherOnly(event);
  const index = Number(payload && payload.index) || 0;
  const client = levelingHeadlessManager.getClient(index);
  if (!client || client.status !== 'connected') {
    return { errorCode: 'inv.offline', results: [] };
  }

  const plano = levelingListing.planListings((payload && payload.drafts) || []);
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
  return { results, blocked: plano.blocked };
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
    contas.push({
      ...conta,
      offline: false,
      listings: mine.listings || [],
      active: mine.active || 0,
      limit: mine.limit || 0,
      sales: vendas,
      overview: overview && !overview.errorCode ? overview : null
    });
  }

  return { contas, readAtMs: Date.now() };
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

ipcMain.handle('leveling:sniper:get', event => {
  launcherOnly(event);
  return {
    config: readPrefs().sniper,
    accounts: sniperAccounts(),
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

ipcMain.handle('leveling:market:window', event => {
  launcherOnly(event);
  return openMarketWindow();
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
  // Repõe o log gravado antes de qualquer tela abrir. Aqui, e não no topo do
  // arquivo, porque `app.getPath('userData')` só é confiável depois do ready —
  // e `sniper:get` responde com este log: sem a reposição a janela diria "o
  // log está vazio" por cima de um arquivo que existe.
  const sniperLogSalvo = readSniperLogFile();
  if (sniperLogSalvo) levelingHeadlessManager.setSniperLog(sniperLogSalvo);

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
  if (contents.getType() !== 'webview') return;
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

  // Proxy com autenticação: o Chromium não aceita usuário e senha na regra, e
  // pede aqui. Responder uma vez só evita laço infinito com senha errada.
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

/** A página trocou o token (login manual, renovação): o monitor usa o novo. */
ipcMain.on('leveling:token:set', (event, token) => {
  const index = accountIndexOf(event.sender.session);
  if (index < 0) return;
  levelingCredentials.setToken(index, typeof token === 'string' ? token : '');
});

app.whenReady().then(() => {
  createWindow();
  buildTray();
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

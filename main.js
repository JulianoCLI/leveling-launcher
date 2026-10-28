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
  refill: levelingRefill.defaultConfig()
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

function syncMarketPoll() {
  const ativa = [...levelingHeadlessManager.clients.values()]
    .some(c => c && c.status === 'connected');
  if (ativa) levelingHeadlessManager.startMarketPoll();
  else levelingHeadlessManager.stopMarketPoll();
}

levelingHeadlessManager.on('status', syncMarketPoll);
levelingHeadlessManager.on('market', data => broadcast('leveling:market', data));

/**
 * Venda da própria conta. O feed público anonimiza vendedor e comprador, então
 * esta é a única via que traz quem comprou. `MarketSold` não tem id de venda
 * nem data: o `listing_id` serve de chave (um anúncio vende uma vez) e a hora
 * é a da chegada do push, com erro de segundos.
 */
levelingHeadlessManager.on('market-sold', ({ index, sold }) => {
  if (!sold) return;
  try {
    market().insertSales([{ ...sold, id: sold.listing_id, sold_at_ms: Date.now() }]);
  } catch (e) {
    logErro('market', e.message);
  }
  broadcast('leveling:market-sold', { index, sold });
});

// ------------------------------------------------------------------------- IPC

/** Só o frame principal do launcher fala com estes canais. */
const launcherOnly = event => {
  const expected = require('url').pathToFileURL(path.join(__dirname, 'index.html')).href;
  if (event.senderFrame !== event.sender.mainFrame || event.sender.getURL().split('?')[0] !== expected) {
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

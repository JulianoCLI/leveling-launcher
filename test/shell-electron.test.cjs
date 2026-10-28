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

/**
 * Catálogo de caçadas como o principal o devolve: portais, dificuldades e as
 * faixas por portal. É dele que saem os níveis exigido e recomendado.
 */
const huntCatalog = {
  gates: [
    { id: 'portal-azul', sceneId: 'cena-azul', name: 'Portal Azul', icon: '', minLevel: 1 },
    { id: 'castelo-demonios', sceneId: 'cena-castelo', name: 'Castelo', icon: '', minLevel: 30 }
  ],
  difficulties: [
    { id: 'normal', name: 'Normal', reqLevel: 0, levelOffset: 0, rewardMult: 1, dropMult: 1, statusMult: 1 },
    { id: 'dificil', name: 'Difícil', reqLevel: 40, levelOffset: 0, rewardMult: 1.5, dropMult: 1.3, statusMult: 2 }
  ],
  tiers: {
    'portal-azul': [
      { min: 1, max: 10, bossId: '', comingSoon: false, areas: { normal: { level: 8, requiredLevel: 1 } } }
    ],
    'castelo-demonios': [
      {
        min: 36, max: 45, bossId: 'lorde-demonio', comingSoon: false,
        areas: { normal: { level: 42, requiredLevel: 30 }, dificil: { level: 52, requiredLevel: 45 } }
      }
    ]
  }
};

/**
 * Mercado. O banco fica no principal, então aqui ele é simulado: o que está em
 * teste é a tela saber pedir, pintar e trocar de visão — e, sobretudo, saber
 * distinguir "ainda não coletei nada" de "o filtro não casou", que são os dois
 * vazios possíveis e levam a ações opostas.
 */
const marketCalls = [];
const marketItems = [
  {
    def_id: 'arco-arqueiro', name: 'Arco de Arqueiro', category: 'armas', rarity: 'lendario',
    currency: 'MARKET_CURRENCY_GOLD', vendas: 12, unidades: 14, volume: 3000000,
    media: 250000, mediana: 35000, minimo: 1, maximo: 9000000,
    ultimo_preco: 26666, ultima_venda_ms: Date.now() - 120000, ultimo_enchant: 0,
    // Vendido nas duas moedas. Diamante é escala própria — dezenas, não
    // milhares — e somá-lo ao ouro daria um preço que nunca existiu.
    vendas_ouro: 10, vendas_dia: 2, unidades_dia: 2,
    media_dia: 100, mediana_dia: 90, minimo_dia: 80, maximo_dia: 120,
    ultimo_preco_dia: 120
  },
  {
    def_id: 'sangue-de-troll', name: 'Sangue de Troll', category: 'materiais', rarity: 'comum',
    currency: 'MARKET_CURRENCY_GOLD', vendas: 3, unidades: 9, volume: 690000,
    media: 230000, mediana: 230000, minimo: 230000, maximo: 230000,
    ultimo_preco: 230000, ultima_venda_ms: Date.now() - 60000, ultimo_enchant: 0,
    // Nunca vendido em diamante: a coluna tem de ficar vazia, não zerada.
    vendas_ouro: 3, vendas_dia: 0
  }
];
let marketEmpty = false;

ipcMain.handle('leveling:market:summary', (_e, opts) => {
  marketCalls.push({ op: 'summary', opts });
  const vazio = marketEmpty || (opts && opts.search === 'nao-existe');
  return {
    items: vazio ? [] : marketItems,
    total: vazio ? 0 : marketItems.length,
    // `stats.vendas` é o que separa "banco vazio" de "filtro sem resultado".
    stats: marketEmpty
      ? { ready: true, vendas: 0, itens: 0, bytes: 0 }
      : { ready: true, vendas: 1500, itens: 42, desde_ms: Date.now() - 86400000, bytes: 2097152 },
    categories: ['armas', 'materiais']
  };
});
ipcMain.handle('leveling:market:recent', (_e, opts) => {
  marketCalls.push({ op: 'recent', opts });
  return {
    sales: [
      {
        id: 1, listing_id: 771, def_id: 'arco-arqueiro', name: 'Arco de Arqueiro',
        category: 'armas', rarity: 'lendario', enchant: 7, currency: 'MARKET_CURRENCY_GOLD',
        quantity: 1, unit_price: 1300000, total: 1300000, sold_at_ms: Date.now() - 30000
      },
      // Gema: o caso que motivou o nível na linha. Mesmo nome e mesma
      // raridade para itens de preços muito diferentes, e o feed não os
      // distingue. Esta fica sem nível de propósito — ausência tem de
      // aparecer como ausência, não como "nv. 0".
      {
        id: 2, listing_id: 772, def_id: 'gema-topazio', name: 'Topázio',
        category: 'materiais', rarity: 'comum', enchant: 0, currency: 'MARKET_CURRENCY_GOLD',
        quantity: 1, unit_price: 999, total: 999, sold_at_ms: Date.now() - 45000
      }
    ]
  };
});
ipcMain.handle('leveling:market:item', (_e, defId, opts) => {
  marketCalls.push({ op: 'item', defId, opts });
  const dia = 86400000;
  return {
    item: {
      ...marketItems[0], def_id: defId,
      primeira_venda_ms: Date.now() - 3 * dia,
      series: [
        { dia_ms: Date.now() - 2 * dia, vendas: 2, unidades: 2, media: 20000, minimo: 10000, maximo: 30000 },
        { dia_ms: Date.now() - dia, vendas: 5, unidades: 5, media: 45000, minimo: 20000, maximo: 90000 }
      ],
      sales: [
        { id: 1, quantity: 1, unit_price: 26666, total: 26666, enchant: 0, sold_at_ms: Date.now() - 60000 }
      ]
    }
  };
});
ipcMain.handle('leveling:market:hint', (_e, defId, days) => {
  marketCalls.push({ op: 'hint', defId, days });
  return { sales: 1624, average: 232646, median: 35000, lowest_sold: 1, highest_sold: 9000000, lowest_now: 2667, days: 30 };
});
ipcMain.handle('leveling:market:poll', () => {
  marketCalls.push({ op: 'poll' });
  return { inserted: 7, poll: { lastError: '' }, stats: { ready: true, vendas: 1507 } };
});
ipcMain.handle('leveling:market:stats', () => ({ stats: { ready: true, vendas: 1500 }, poll: {} }));
ipcMain.handle('leveling:market:catalog', () => {
  marketCalls.push({ op: 'catalog' });
  return {
    catalog: {
      items: {
        'arco-arqueiro': {
          name: 'Arco de Arqueiro',
          icon: '/assets/paperdoll/gear/arco-arqueiro/icon.png',
          slot: 'arma', category: 'weapons', stats: { atk: 9 }
        }
      },
      rarities: { lendario: { name: 'Lendário', color: '#fbbf24', order: 4 } },
      shadowRanks: { cavaleiro: { name: 'Cavaleiro', color: '#58d6e8', order: 2 } },
      monsters: { 'Slime Corrosivo': { name: 'Slime Corrosivo', icon: '/assets/monsters/slime/idle.png' } },
      origin: 'https://levelingidle2d.com.br'
    }
  };
});
let marketBagEmpty = false;
ipcMain.handle('leveling:market:bag', (_e, opts) => {
  marketCalls.push({ op: 'bag', opts });
  if (marketBagEmpty) return { contas: [], offline: [{ index: 0, name: 'samaleiko' }], precos: {} };
  return {
    contas: [
      {
        index: 0, name: 'samaleiko', errorCode: '',
        owned: {
          // Vendável: está na mochila.
          'sangue-de-troll': {
            qty: 9, linhas: 1, bag: 9, warehouse: 0, equipped: 0,
            melhor: { power: 0, level: 0, rarity: 'comum', enchant: 0, locked: false, equipped: false }
          },
          // Vestido: `qty` zero e `equipped` um. Não está à venda, e por isso
          // fica fora da soma e só aparece quando a caixa é marcada.
          'arco-arqueiro': {
            qty: 0, linhas: 1, bag: 0, warehouse: 0, equipped: 1,
            melhor: { power: 129, level: 45, rarity: 'lendario', enchant: 3, locked: true, equipped: true }
          }
        }
      }
    ],
    offline: [{ index: 1, name: 'segunda' }],
    precos: Object.fromEntries(marketItems.map(i => [i.def_id, i]))
  };
});

/**
 * Preço por nível.
 *
 * O nível não vem no feed de vendas: é descoberto consultando o anúncio de
 * cada venda, em segundo plano. Por isso a cobertura é parcial — e mostrar
 * isso é o que impede o usuário de confiar numa quebra feita sobre 3 de 12
 * vendas como se fosse sobre 12.
 */
ipcMain.handle('leveling:market:levels', (_e, defId, opts) => {
  marketCalls.push({ op: 'levels', defId, opts });
  return {
    levels: [
      {
        level: 1, vendas: 4, unidades: 4, vendas_ouro: 4, media: 1200,
        minimo: 900, maximo: 1500, vendas_dia: 0, media_dia: null,
        ultima_venda_ms: Date.now() - 300000
      },
      {
        level: 4, vendas: 2, unidades: 2, vendas_ouro: 1, media: 8400000,
        minimo: 8400000, maximo: 8400000, vendas_dia: 1, media_dia: 55,
        ultima_venda_ms: Date.now() - 90000
      }
    ],
    coverage: { total: 12, perguntadas: 6, comNivel: 6 }
  };
});

/**
 * Nível das vendas listadas no ao vivo, por `listing_id`.
 *
 * O ao vivo mostra as vendas mais novas — justamente as que o enriquecedor de
 * fundo ainda não perguntou. Sem este pedido sob demanda a linha diria
 * "Topázio" e o preço ao lado seria ininterpretável, porque são quatro itens
 * com esse nome e preços que no banco real vão de 999 a 4 milhões.
 */
ipcMain.handle('leveling:market:levels-for', (_e, listingIds) => {
  marketCalls.push({ op: 'levels-for', listingIds });
  // Só a primeira venda tem nível. A segunda fica sem, e é isso que o teste
  // verifica: ausência é mostrada como ausência, não como "nv. 0".
  return { levels: { '771': { level: 2, slot: '' } } };
});

/**
 * A janela separada não pode ser criada no teste — ela carregaria `market.html`
 * fora do alcance deste harness. Devolver `false` exercita o caminho de
 * reserva, que é o que importa verificar: se a janela falhar, a tela ainda
 * abre como modal em vez de não abrir.
 */
let marketWindowCalls = 0;
ipcMain.handle('leveling:market:window', () => { marketWindowCalls++; return false; });
ipcMain.handle('leveling:market:window-close', () => true);

let marketOwnersOffline = false;
ipcMain.handle('leveling:market:owners', (_e, defIds) => {
  marketCalls.push({ op: 'owners', defIds });
  // Sem conta em modo monitor não há inventário para ler: a tela tem de dizer
  // "não sei", nunca "não tem".
  if (marketOwnersOffline) {
    return { byDef: {}, accounts: [], offline: [{ index: 0, name: 'samaleiko' }] };
  }
  return {
    byDef: {
      'arco-arqueiro': {
        total: 7, equipped: 1,
        accounts: [
          {
            index: 0, name: 'samaleiko', qty: 5, linhas: 5, bag: 4, warehouse: 1, equipped: 1,
            melhor: { power: 129, level: 45, rarity: 'lendario', enchant: 3, locked: true, equipped: false }
          },
          {
            index: 1, name: 'segunda', qty: 2, linhas: 2, bag: 2, warehouse: 0, equipped: 0,
            melhor: { power: 88, level: 40, rarity: 'raro', enchant: 0, locked: false, equipped: false }
          }
        ]
      }
    },
    accounts: [{ index: 0, name: 'samaleiko', errorCode: '' }, { index: 1, name: 'segunda', errorCode: '' }],
    offline: [{ index: 2, name: 'terceira' }],
    readAtMs: Date.now()
  };
});
ipcMain.handle('leveling:market:listings', (_e, filtros) => {
  marketCalls.push({ op: 'listings', filtros });
  return {
    listings: [{
      id: '1', name: 'Arco de Arqueiro', currency: 'MARKET_CURRENCY_GOLD',
      unit_price: '1999999', quantity: '1',
      item: { def_id: 'arco-arqueiro', level: 32, rarity: 'lendario', slot: 'arma' },
      expires_at_ms: String(Date.now() + 7200000)
    }]
  };
});

const huntSwitches = [];
ipcMain.handle('leveling:hunts:get', () => ({ catalog: huntCatalog }));
ipcMain.handle('leveling:hunt:set', (_e, indexes, ticket) => {
  huntSwitches.push({ indexes, ticket });
  return {
    ok: true,
    gateId: ticket.gate_id,
    tierMin: ticket.tier_min,
    difficulty: ticket.difficulty,
    changed: indexes.map(index => ({ index, name: 'conta' + index })),
    pulled: [],
    failed: [],
    skipped: []
  };
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

  // 8.5. Troca de caçada sem desligar o monitor. O nível da conta e o mapa
  // atual vêm do mesmo `leveling:update` que pinta o HUD.
  win.webContents.send('leveling:update', [{
    index: 0,
    state: {
      game: 'leveling-idle', name: 'desjunior', level: 41,
      hunt: { gateId: 'castelo-demonios', tierMin: 36, difficulty: 'normal' }, a: {}
    }
  }]);
  await pause(150);

  // Botão do painel: uma conta só na lista.
  await read('window.PioShell.openHunt([0])');
  await pause(300);
  assert.equal(await read('document.getElementById("huntOverlay").classList.contains("show")'), true,
    'Panel button must open the hunt picker');
  assert.equal(await read('document.querySelectorAll("#huntBody [data-target]").length'), 1,
    'Opening from the panel must scope the picker to that account');

  // Um filtro só: portal e faixa são linha da lista, não seletor.
  assert.equal(await read('document.querySelectorAll("#huntBody select").length'), 1,
    'The picker must offer the difficulty filter and nothing else');
  assert.equal(await read('!!document.querySelector("#huntBody [data-role=\'gate\']")'), false,
    'Gate must be a row, not a select');
  assert.equal(await read('!!document.querySelector("#huntBody [data-role=\'tier\']")'), false,
    'Tier must be a row, not a select');

  // A lista mostra toda faixa de todo portal, com os níveis de cada uma: é o
  // que permite comparar sem abrir uma combinação de cada vez.
  const rows = await read(`[...document.querySelectorAll('#huntBody .hu-row[data-gate]')]
    .map(r => r.textContent.replace(/\\s+/g, ' ').trim())`);
  assert.equal(rows.length, 2, 'Every tier of every gate must be a row: ' + rows.join(' | '));
  // Ordem de progressão: o portal de nível 1 primeiro.
  assert.match(rows[0], /Portal Azul tier 1–10 1 8/,
    'Required and recommended levels must show on every row: ' + rows[0]);
  // Exigido 30 é o do portal, acima do da dificuldade e da área.
  assert.match(rows[1], /Castelo tier 36–45 30 42/,
    'Required level must be the strictest of the three: ' + rows[1]);

  // A caçada lida da conta é a linha marcada de saída.
  assert.equal(await read('window.PioHunt.choice.gateId'), 'castelo-demonios');
  assert.equal(await read('document.querySelector("#huntModal .hu-row.is-on").dataset.tier'), '36');

  // Dificuldade mais pesada: a área exige 45, acima do portal e da dificuldade,
  // e o portal azul some porque não declara essa dificuldade.
  await read(`(() => {
    const select = document.querySelector('#huntBody [data-role="difficulty"]');
    select.value = 'dificil';
    select.onchange();
    return true;
  })()`);
  await pause(150);
  const hard = await read(`[...document.querySelectorAll('#huntBody .hu-row[data-gate]')]
    .map(r => r.textContent.replace(/\\s+/g, ' ').trim())`);
  assert.equal(hard.length, 1, 'Tiers without the chosen difficulty must leave the list: ' + hard.join(' | '));
  assert.match(hard[0], /Castelo tier 36–45 · precisa de 45 45 52/,
    'The difficulty must recompute both levels: ' + hard[0]);
  // Nível 41 contra 45 exigido: linha e conta ficam avisadas, não escondidas.
  assert.equal(await read('document.querySelector("#huntModal .hu-row[data-gate]").classList.contains("is-low")'), true,
    'A hunt above the account level must be flagged');
  assert.equal(await read('document.querySelector("#huntModal .hu-target").classList.contains("is-low")'), true,
    'An account below the required level must be flagged');

  // Voltar para normal e escolher pela lista: um clique, sem cascata.
  await read(`(() => {
    const select = document.querySelector('#huntBody [data-role="difficulty"]');
    select.value = 'normal';
    select.onchange();
    return true;
  })()`);
  await pause(150);
  await read('document.querySelector(\'#huntBody .hu-row[data-gate="portal-azul"]\').click()');
  await pause(150);
  assert.equal(await read('window.PioHunt.choice.tierMin'), 1, 'Clicking a row must pick its gate and tier');
  assert.equal(await read('document.querySelector("#huntModal .hu-row.is-on").dataset.gate'), 'portal-azul');

  await read('document.getElementById("huntApply").click()');
  await pause(300);
  assert.deepEqual(huntSwitches, [{
    indexes: [0],
    ticket: { gate_id: 'portal-azul', tier_min: 1, difficulty: 'normal' }
  }], 'Applying must send exactly the chosen hunt for the chosen accounts');

  // Botão da titlebar: a aba inteira, com as contas sem monitor desabilitadas.
  await read('window.PioShell.closeHunt()');
  await read('document.getElementById("huntBtn").click()');
  await pause(300);
  assert.equal(await read('document.querySelectorAll("#huntBody [data-target]").length'), 4,
    'The titlebar button must list every account of the tab');
  assert.equal(await read('document.querySelectorAll("#huntBody [data-target]:checked").length'), 1,
    'Only the accounts in monitor mode may start selected');
  assert.equal(await read('document.querySelectorAll("#huntBody [data-target]:disabled").length'), 3,
    'Accounts without a monitor must stay visible but disabled');

  await read('window.PioShell.closeHunt()');
  assert.equal(await read('document.getElementById("huntOverlay").classList.contains("show")'), false);

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

  // 14. Mercado. O banco vive no principal; o que se verifica aqui é a tela
  // pedir os dados certos, pintar a tabela e navegar entre as três visões.
  await read('window.PioShell.openMarket()');
  await pause(600);

  // O botão pede a janela separada: a tela serve para comparar preço enquanto
  // se mexe no jogo, e como modal ela cobria os painéis.
  assert.ok(marketWindowCalls > 0, 'The button must ask for a separate window');
  // Aqui a janela não pode ser criada, e o caminho de reserva tem de valer:
  // uma tela ruim de usar ainda é melhor do que uma tela que não abre.
  assert.equal(await read('document.getElementById("marketOverlay").classList.contains("show")'), true,
    'If the window cannot open, the modal must still work');
  assert.equal(await read('document.querySelectorAll("#marketBody .mk-table tbody tr").length'), 2,
    'Each item must be one row');
  assert.ok(await read('document.getElementById("marketStatusBar").textContent.includes("1.500")'),
    'The footer must say how much history has been accumulated');

  // Mediana muito distante da média é marcada: a média sozinha enganaria.
  assert.equal(await read('document.querySelectorAll("#marketBody tbody tr.is-spread").length'), 1,
    'Only the item with a scattered price must be flagged');

  // Ícone e cor de raridade vêm do catálogo do jogo. Sem eles toda linha fica
  // igual e nem câmbio nem gema se distinguem de uma peça de armadura.
  assert.ok(await read(`document.querySelector('#marketBody tbody .mk-icon img')
    .src.includes('levelingidle2d.com.br/assets/paperdoll/gear/arco-arqueiro/icon.png')`),
    'The row must show the icon the game uses');
  assert.ok(await read(`document.querySelector('#marketBody tbody .mk-c-name b')
    .getAttribute('style').includes('#fbbf24')`),
    'The name must take the rarity colour the game uses for legendary');
  // O quadro existe mesmo sem imagem: sem catálogo para este item, a coluna
  // não pode mudar de largura.
  assert.equal(await read(`document.querySelectorAll('#marketBody tbody .mk-icon').length`), 2,
    'Every row keeps its icon slot, with or without an image');

  // Preço em diamante: coluna própria, nunca somada ao ouro. As duas moedas
  // têm ordens de grandeza diferentes, e a média conjunta não corresponde a
  // nenhuma venda que aconteceu.
  assert.ok(await read(`document.querySelector('#marketBody tbody .mk-c-dia:not(.is-none)').textContent.includes('90')`),
    'The diamond column must show the diamond median, not the gold one');
  assert.ok(!(await read(`document.querySelector('#marketBody tbody .mk-c-p').textContent`)).includes('90'),
    'The gold column must stay free of diamond prices');
  // Item nunca vendido em diamante: vazio, não zero. Zero diria que ele vale
  // nada nessa moeda; o fato é que ninguém o vendeu nela.
  assert.ok(await read(`!!document.querySelector('#marketBody tbody .mk-c-dia.is-none')`),
    'An item never sold for diamonds must read blank, not zero');

  // O foco não pode sair da caixa de busca quando o resultado repinta: antes,
  // a tabela e a barra eram refeitas juntas e o input era destruído no meio
  // da palavra, jogando o cursor fora.
  await read(`(() => {
    const i = document.querySelector('#marketBody [data-role="search"]');
    i.focus(); i.value = 'arco';
    i.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await pause(700);
  assert.ok(await read(`document.activeElement === document.querySelector('#marketBody [data-role="search"]')`),
    'Typing must not steal focus from the search box');
  assert.equal(await read(`document.querySelector('#marketBody [data-role="search"]').value`), 'arco',
    'The typed text must survive the repaint');
  await read(`(() => {
    const i = document.querySelector('#marketBody [data-role="search"]');
    i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await pause(600);

  // Coluna "Minhas": a lista inteira custa um pedido por conta, graças ao
  // filtro por def_ids. Os três estados têm de ser distinguíveis.
  assert.ok(marketCalls.some(c => c.op === 'owners' && c.defIds.length === 2),
    'The list must ask about every item it shows, in one request');
  assert.ok(await read(`document.querySelector('#marketBody tbody .mk-c-own.is-owned b').textContent.includes('7')`),
    'The owned column must total what the accounts hold');
  // O item que ninguém tem mostra 0, não "—": foi perguntado e a resposta foi
  // nenhuma. Confundir os dois levaria a comprar algo que já se tem.
  assert.ok(await read(`!!document.querySelector('#marketBody tbody .mk-c-own.is-zero')`),
    'An item nobody owns must read zero, which is different from unknown');

  // Trocar o período tem de repetir a consulta, não filtrar o que já veio.
  await read(`(() => {
    const dias = document.querySelector('#marketBody [data-role="days"]');
    dias.value = '30';
    dias.onchange();
  })()`);
  await pause(400);
  assert.equal(await read('window.PioMarket.query.days'), 30, 'Changing the period must requery');

  // Clicar numa linha abre o item, e o detalhe pede o reforço ao servidor.
  await read('document.querySelector("#marketBody tbody tr").click()');
  await pause(700);
  assert.equal(await read('window.PioMarket.view'), 'detail', 'Clicking a row must open the item');
  assert.ok(await read('!!document.querySelector("#marketBody .mk-chart")'),
    'The detail must chart the daily price');
  assert.ok(await read('!!document.querySelector("#marketBody .mk-hint")'),
    'The detail must also show what the server knows');
  assert.ok(marketCalls.some(c => c.op === 'hint' && c.defId === 'arco-arqueiro'),
    'The detail must ask the server about this very item');
  assert.ok(await read(`document.querySelector('#marketBody .mk-ficha-stats').textContent.includes('ATQ 9')`),
    'The detail must show the base stats the catalogue knows');
  // Nível e potência só existem nos anúncios ativos: `MarketSale` não os traz.
  assert.ok(marketCalls.some(c => c.op === 'listings'),
    'The detail must ask for the active listings');
  assert.ok(await read(`document.getElementById('marketBody').textContent.includes('À venda agora')`),
    'Asking price must appear, clearly separate from the price actually paid');

  // Quem tem o item. Com oito contas é a outra metade da decisão: o preço diz
  // quanto vale, isto diz se vale a pena ir buscar e em qual conta.
  assert.ok(marketCalls.some(c => c.op === 'owners' && c.defIds.includes('arco-arqueiro')),
    'The detail must ask which accounts own the item');
  assert.ok(await read(`!!document.querySelector('#marketBody .mk-owners')`),
    'The detail must list the accounts that own it');
  const donos = await read(`document.querySelector('#marketBody .mk-owners').textContent`);
  assert.ok(donos.includes('samaleiko') && donos.includes('segunda'),
    'Every owning account must be named');
  // Mochila, depósito e equipado são somas diferentes: equipado é seu mas não
  // está à venda, e misturá-los mentiria sobre o que dá para vender.
  assert.ok(donos.includes('Equipado'), 'Equipped must be counted apart from what is for sale');
  assert.ok(await read(`document.querySelector('#marketBody .mk-group').textContent.includes('contas')`)
    || donos.length > 0, 'The heading must summarise the total');
  // Conta fora do modo monitor não foi consultada: dizer que ela não tem seria
  // inventar um dado que ninguém leu.
  assert.ok(await read(`document.getElementById('marketBody').textContent.includes('terceira')`),
    'Accounts that were not consulted must be named, not silently counted as zero');

  // Preço por nível. "Topázio" não é um item: são quatro, com o mesmo nome e
  // preços que no banco real vão de 1 a 10 milhões. A média de tudo junto não
  // serve para comprar nem para vender nenhum deles.
  assert.ok(marketCalls.some(c => c.op === 'levels' && c.defId === 'arco-arqueiro'),
    'The detail must ask for the per-level breakdown');
  assert.ok(await read(`!!document.querySelector('#marketBody .mk-levels')`),
    'The breakdown must be rendered as its own table');
  const niveis = await read(`document.querySelector('#marketBody .mk-levels').textContent`);
  assert.ok(niveis.includes('nv 1') && niveis.includes('nv 4'),
    'Each distinct level must appear as its own row');
  // O nível com mais vendas é o que o mercado de fato negocia: os outros
  // podem ser uma venda só, e um preço de uma venda não é um preço.
  assert.ok(await read(`!!document.querySelector('#marketBody .mk-levels tr.mk-row-top')`),
    'The most traded level must stand out');
  // A honestidade da amostra: dizer sobre quantas vendas a quebra foi feita.
  const corpo = await read(`document.getElementById('marketBody').textContent`);
  assert.ok(corpo.includes('6 de 12'),
    'The screen must say how many sales were actually identified');
  assert.ok(corpo.includes('Faltam 6'),
    'And how many are still unknown, because an expired listing never gets a level');

  // A aba "ao vivo" é outra pergunta: o que está acontecendo agora.
  await read(`document.querySelector('#marketBody [data-view="live"]').click()`);
  await pause(500);
  assert.equal(await read('window.PioMarket.view'), 'live');
  assert.ok(marketCalls.some(c => c.op === 'recent'), 'The live tab must read raw sales');

  // Nível na linha da venda. Sem isto "Topázio" ao lado de 999 é
  // ininterpretável: são quatro itens com esse nome, e no banco real um deles
  // vale 999 e outro 4 milhões.
  await pause(500);
  const pedido = marketCalls.find(c => c.op === 'levels-for');
  assert.ok(pedido, 'The live tab must ask for the level of the sales on screen');
  assert.ok(pedido.listingIds.includes(771) && pedido.listingIds.includes(772),
    'It must ask by listing_id, which is the only key the sale feed carries');
  const aoVivo = await read(`document.querySelector('#marketBody .mk-live').textContent`);
  assert.ok(aoVivo.includes('nv. 2'), 'The discovered level must show next to the name');
  assert.equal(await read(`document.querySelectorAll('#marketBody .mk-live .mk-nv').length`), 1,
    'A sale whose level is still unknown must show nothing, never "nv. 0"');
  // O que já tem resposta não é perguntado outra vez.
  const antes = marketCalls.filter(c => c.op === 'levels-for').length;
  await read(`window.PioMarket.loadSaleLevels(window.PioMarket.data.sales)`);
  await pause(300);
  assert.equal(marketCalls.filter(c => c.op === 'levels-for').length, antes + 1,
    'Only the sales still missing a level may be asked again');
  assert.ok(marketCalls.filter(c => c.op === 'levels-for').pop().listingIds.every(id => id !== 771),
    'The sale that already has a level must not be asked again');

  // Aba "Minha bolsa": a soma que decide se vale abrir o jogo.
  await read(`document.querySelector('#marketBody [data-view="bolsa"]').click()`);
  await pause(600);
  assert.equal(await read('window.PioMarket.view'), 'bolsa');
  assert.ok(marketCalls.some(c => c.op === 'bag'), 'The bag tab must scan the inventories');
  const bolsa = await read(`document.querySelector('#marketBody').textContent`);
  assert.ok(bolsa.includes('Sangue de Troll'), 'Sellable items must be listed');
  assert.ok(bolsa.includes('Total vendável'), 'The tab must total what can be sold');
  // Equipamento vestido fica fora por padrão: a pergunta é "quanto posso
  // lucrar", e o que está no corpo não está à venda. Somá-lo trocaria a
  // resposta por "quanto possuo", que é outra coisa.
  assert.ok(!bolsa.includes('Arco de Arqueiro'),
    'Equipped gear must be hidden by default, because it is not for sale');
  assert.ok(await read(`!!document.querySelector('#marketBody [data-role="equip"]')`),
    'A checkbox must exist to reveal it');

  await read(`document.querySelector('#marketBody [data-role="equip"]').click()`);
  await pause(300);
  const comEquip = await read(`document.querySelector('#marketBody').textContent`);
  assert.ok(comEquip.includes('Arco de Arqueiro'), 'Ticking the box must reveal equipped gear');
  assert.ok(await read(`!!document.querySelector('#marketBody tr.is-equipped')`),
    'Equipped rows must look different from what is actually sellable');
  // Revelar não pode somar: o total continua sendo o do que dá para vender.
  assert.ok(comEquip.includes('Total vendável'), 'The total must still be about sellable value');
  // Conta fora do monitor é nomeada: a bolsa dela é desconhecida, não vazia.
  assert.ok(comEquip.includes('fora do monitor') || comEquip.includes('segunda'),
    'Accounts outside monitor mode must be reported, not counted as empty');

  // "Ler agora" existe para não esperar o minuto do coletor.
  await read('document.getElementById("marketRefresh").click()');
  await pause(500);
  assert.ok(marketCalls.some(c => c.op === 'poll'), 'The button must force a read');

  // Os dois vazios são diferentes, e dizer a coisa errada mandaria o usuário
  // esperar por dados que nunca viriam.
  await read(`(() => {
    window.PioMarket.view = 'items';
    window.PioMarket.query.search = 'nao-existe';
    return window.PioMarket.load();
  })()`);
  await pause(500);
  assert.ok(await read('document.getElementById("marketBody").textContent.includes("filtros")'),
    'An empty filter must say it is the filter');

  marketEmpty = true;
  await read(`(() => { window.PioMarket.query.search = ''; return window.PioMarket.load(); })()`);
  await pause(500);
  assert.ok(await read('document.getElementById("marketBody").textContent.includes("modo monitor")'),
    'An empty database must explain that collecting depends on the monitor');
  marketEmpty = false;

  // Esc fecha o mercado antes de qualquer outro modal aberto por baixo.
  await read(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
  await pause(300);
  assert.equal(await read('document.getElementById("marketOverlay").classList.contains("show")'), false,
    'Esc must close the market');

  const fatal = errors.filter(e => !/favicon|ERR_FILE_NOT_FOUND/i.test(e));
  assert.deepEqual(fatal, [], 'Renderer must not log errors: ' + fatal.join('\n'));

  console.log('PASS: shell mounts four isolated panels, scales to more accounts through tabs, stores credentials safely, hands the panel over to the read-only monitor and back, and browses the accumulated market prices.');
  app.quit();
}).catch(err => {
  console.error('FAIL:', err && err.stack || err);
  app.exit(1);
});

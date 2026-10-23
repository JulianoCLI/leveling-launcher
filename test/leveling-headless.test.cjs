const { test } = require('node:test');
const assert = require('node:assert/strict');
const { getCodec } = require('../src/domain/leveling-codec');
const {
  LevelingHeadlessClient,
  LevelingHeadlessManager,
  IGNORED_CASES,
  IGNORED_PUSHES,
  RATELIMIT_RETRY_MS
} = require('../src/domain/leveling-headless-service');

const codec = getCodec();

/** Socket de mentira que fala o mesmo protobuf binário do servidor real. */
class MockWebSocket {
  constructor(url, options) {
    this.url = url;
    this.options = options;
    this.readyState = 0;
    this.sent = [];
    this.closeCode = null;
    MockWebSocket.last = this;
    /** Requests já respondidos, por id. Cada socket tem a sua contagem. */
    this.replied = new Set();
    setTimeout(() => {
      this.readyState = 1;
      if (this.onopen) this.onopen();
    }, 1);
  }

  send(data) {
    this.sent.push(codec.ClientMessage.decode(data).toJSON());
  }

  close(code) {
    this.closeCode = code;
    this.readyState = 3;
    if (this.onclose) this.onclose({ code: code || 1000 });
  }

  /** Entrega um ServerMessage como o servidor faria, em binário. */
  push(caseName, value, requestId = 0) {
    const payload = { [caseName]: value };
    if (requestId) payload.request_id = requestId;
    const buf = codec.ServerMessage.encode(codec.ServerMessage.create(payload)).finish();
    if (this.onmessage) this.onmessage({ data: Buffer.from(buf) });
  }

  /**
   * Responde ao request pendente de um determinado case. Um mesmo case pode ser
   * enviado várias vezes — o refill compra em série e repete `buy_consumable` —
   * então responder sempre o primeiro acertaria um pedido já resolvido e o
   * cliente ficaria esperando para sempre. Cada request é respondido uma vez.
   */
  reply(clientCase, caseName, value) {
    const match = this.sent.find(m => m[clientCase] !== undefined && !this.replied.has(m.request_id));
    assert.ok(match, `nenhum request de ${clientCase} pendente de resposta`);
    this.replied.add(match.request_id);
    this.push(caseName, value, Number(match.request_id));
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

function makeClient(options = {}) {
  return new LevelingHeadlessClient(0, {
    WebSocket: MockWebSocket,
    username: 'cacador',
    password: 'segredo',
    autoReconnect: false,
    // O timeout real é de 15 s; a suíte não deve esperar por um request que o
    // caso de teste não pretende responder.
    requestTimeoutMs: 200,
    ...options
  });
}

test('autentica com login e guarda o token devolvido pelo servidor', async () => {
  const client = makeClient();
  const tokens = [];
  client.on('token', ({ token }) => tokens.push(token));

  client.connect();
  await sleep(10);

  const ws = MockWebSocket.last;
  assert.equal(ws.options.headers.Origin, 'https://levelingidle2d.com.br');
  assert.deepEqual(ws.sent[0].login, { username: 'cacador', password: 'segredo' });

  ws.reply('login', 'auth_ok', { token: 'tok-abc', account_id: 12920, username: 'desjunior' });
  await sleep(5);

  assert.equal(client.status, 'connected');
  assert.equal(client.state.accountId, '12920');
  assert.equal(client.state.name, 'desjunior');
  assert.deepEqual(tokens, ['tok-abc']);

  client.disconnect();
});

test('reconecta por resume quando já existe token', async () => {
  const client = makeClient({ token: 'tok-salvo' });
  client.connect();
  await sleep(10);

  const ws = MockWebSocket.last;
  assert.deepEqual(ws.sent[0].resume, { token: 'tok-salvo' });
  assert.equal(ws.sent[0].login, undefined);

  client.disconnect();
});

test('token expirado cai para login com as credenciais', async () => {
  const client = makeClient({ token: 'tok-velho' });
  client.connect();
  await sleep(10);

  const ws = MockWebSocket.last;
  ws.reply('resume', 'error', { code: 'session.expired' });
  await sleep(10);

  assert.ok(ws.sent.some(m => m.login), 'deveria tentar login após o resume falhar');
  client.disconnect();
});

test('sem refill configurado, somente login, resume, ping e a leitura do grupo saem', async () => {
  // Intervalos curtos: o heartbeat real é de 15 s, para não pagar um
  // round-trip por segundo por conta.
  const client = makeClient({ pingIntervalMs: 20, tickIntervalMs: 20 });
  client.connect();
  await sleep(10);

  const ws = MockWebSocket.last;
  ws.reply('login', 'auth_ok', { token: 't', account_id: 1 });
  await sleep(100);

  const cases = new Set();
  for (const msg of ws.sent) {
    for (const key of Object.keys(msg)) if (key !== 'request_id') cases.add(key);
  }
  for (const used of cases) {
    assert.ok(['login', 'resume', 'ping', 'party_request'].includes(used),
      `case proibido enviado: ${used}`);
  }
  assert.ok(cases.has('ping'), 'o heartbeat precisa rodar');

  // `party_request` é o único case que teria uma forma de escrita: `get` lê,
  // mas `invite`, `kick` e `leave` agiriam pelo jogador. Permitir o case sem
  // olhar o conteúdo deixaria a regra de somente leitura sem guarda.
  for (const msg of ws.sent.filter(m => m.party_request)) {
    assert.deepEqual(Object.keys(msg.party_request), ['get'],
      'do grupo, só a leitura inicial pode sair');
  }

  client.disconnect();
});

test('o tráfego de mundo é descartado sem virar atualização', async () => {
  const client = makeClient();
  client.connect();
  await sleep(10);
  const ws = MockWebSocket.last;
  ws.reply('login', 'auth_ok', { token: 't', account_id: 1 });
  await sleep(5);

  let updates = 0;
  client.on('update', () => updates++);

  for (let i = 0; i < 50; i++) {
    ws.push('world_snapshot', { tick: i, server_time_ms: Date.now(), full: false });
    ws.push('world_events', { tick: i });
  }
  await sleep(5);

  assert.equal(updates, 0, 'pacotes de mundo não devem gerar atualização de painel');
  assert.ok(IGNORED_CASES.has('world_snapshot'));

  client.disconnect();
});

test('hunt_session acumula deltas esparsos em vez de zerar', async () => {
  const client = makeClient();
  client.connect();
  await sleep(10);
  const ws = MockWebSocket.last;
  ws.reply('login', 'auth_ok', { token: 't', account_id: 1 });
  await sleep(5);

  const started = Date.now() - 60000;
  ws.push('hunt_session', {
    gate_id: 'castelo-demonios',
    tier_min: 31,
    difficulty: 'normal',
    started_at_ms: started,
    kills: 10,
    xp: 5000,
    gold: 900
  });
  await sleep(5);

  assert.equal(client.state.hunt.gateId, 'castelo-demonios');
  assert.equal(client.state.hunt.kills, 10);

  // Delta seguinte traz só `kills`: proto3 omite o resto, que deve persistir.
  ws.push('hunt_session', { started_at_ms: started, kills: 14 });
  await sleep(5);

  assert.equal(client.state.hunt.kills, 14);
  assert.equal(client.state.hunt.xp, 5000, 'xp não pode ser zerado por omissão');
  assert.equal(client.state.hunt.gold, 900, 'gold não pode ser zerado por omissão');
  assert.equal(client.state.hunt.gateId, 'castelo-demonios');

  client.disconnect();
});

test('caçada nova zera os contadores e preserva o recorde de streak', async () => {
  const client = makeClient();
  client.connect();
  await sleep(10);
  const ws = MockWebSocket.last;
  ws.reply('login', 'auth_ok', { token: 't', account_id: 1 });
  await sleep(5);

  ws.push('character_state', { hunt: { best_streak: 35672 } });
  ws.push('hunt_session', { started_at_ms: 1000, kills: 99, xp: 1234 });
  await sleep(5);
  assert.equal(client.state.hunt.kills, 99);

  ws.push('hunt_session', { started_at_ms: 2000, gate_id: 'ilha-jeju' });
  await sleep(5);

  assert.equal(client.state.hunt.kills, 0, 'contadores reiniciam na caçada nova');
  assert.equal(client.state.hunt.xp, 0);
  assert.equal(client.state.hunt.gateId, 'ilha-jeju');
  assert.equal(client.state.hunt.bestStreak, 35672, 'recorde é da conta, não da sessão');

  client.disconnect();
});

test('character_state alimenta os números do painel', async () => {
  const client = makeClient();
  client.connect();
  await sleep(10);
  const ws = MockWebSocket.last;
  ws.reply('login', 'auth_ok', { token: 't', account_id: 1 });
  await sleep(5);

  ws.push('character_state', {
    identity: { name: 'desjunior', class_id: 'guerreiro' },
    progress: { level: 41, xp: 2109800, xp_to_next: 2759986, hp: 6065, level_cap: 50 },
    wallet: { gold: 604617 },
    derived: { max_hp: 6275, power: 4297 },
    hunt: { tier_min: 31, difficulty: 'normal', streak: 80, best_streak: 35672 },
    multipliers: { xp: 1.5 }
  });
  await sleep(5);

  const s = client.state;
  assert.equal(s.level, 41);
  assert.equal(s.levelCap, 50);
  assert.equal(s.classId, 'guerreiro');
  assert.equal(s.gold, 604617);
  assert.equal(s.maxHp, 6275);
  assert.equal(s.power, 4297);
  assert.equal(s.hunt.streak, 80);
  assert.equal(s.multipliers.xp, 1.5);

  client.disconnect();
});

test('a morte é apenas reportada, sem enviar revive', async () => {
  const client = makeClient();
  client.connect();
  await sleep(10);
  const ws = MockWebSocket.last;
  ws.reply('login', 'auth_ok', { token: 't', account_id: 1 });
  await sleep(5);

  const deaths = [];
  client.on('death', ({ death }) => deaths.push(death));

  const sentBefore = ws.sent.length;
  ws.push('death_state', { dead: true, died_at_ms: 1700, xp_lost: 500, xp_lost_pct: 0.05 });
  await sleep(5);

  assert.equal(deaths.length, 1);
  assert.equal(client.state.death.dead, true);
  assert.equal(client.state.death.xpLost, 500);

  const novos = ws.sent.slice(sentBefore).filter(m => !m.ping);
  assert.deepEqual(novos, [], 'o headless é somente leitura: nada além de ping');

  ws.push('death_state', { dead: false });
  await sleep(5);
  assert.equal(client.state.death, null);

  client.disconnect();
});

test('session.replaced encerra o monitor e proíbe reconexão', async () => {
  const client = makeClient({ autoReconnect: true });
  client.connect();
  await sleep(10);
  const ws = MockWebSocket.last;
  ws.reply('login', 'auth_ok', { token: 't', account_id: 1 });
  await sleep(5);

  const ended = [];
  client.on('ended', e => ended.push(e));

  ws.push('session_ended', { code: 'session.replaced' });
  await sleep(5);

  assert.equal(ended.length, 1);
  assert.equal(ended[0].code, 'session.replaced');
  assert.equal(client.autoReconnect, false, 'reconectar brigaria com a sessão que assumiu');

  ws.close(1001);
  await sleep(2600);
  assert.equal(client.reconnectTimer, null, 'não deve haver reconexão agendada');

  client.disconnect();
});

test('o manager encerra a conta quando a sessão é substituída', async () => {
  const manager = new LevelingHeadlessManager({ WebSocket: MockWebSocket, autoReconnect: false });
  manager.start(2, { username: 'u', password: 'p' });
  await sleep(10);

  const ws = MockWebSocket.last;
  ws.reply('login', 'auth_ok', { token: 't', account_id: 7 });
  await sleep(5);
  assert.equal(manager.isActive(2), true);

  const ended = [];
  manager.on('ended', e => ended.push(e));
  ws.push('session_ended', { code: 'session.replaced' });
  await sleep(5);

  assert.equal(ended.length, 1);
  assert.equal(manager.getClient(2), null, 'o cliente sai do registro');
  assert.deepEqual(manager.getStatus(2), { active: false, status: 'disconnected', state: null });

  manager.stopAll();
});

test('scene_enter registra a cena e a caçada corrente', async () => {
  const client = makeClient();
  client.connect();
  await sleep(10);
  const ws = MockWebSocket.last;
  ws.reply('login', 'auth_ok', { token: 't', account_id: 1 });
  await sleep(5);

  ws.push('scene_enter', {
    scene_id: 'castelo-demonios',
    instance_id: 157216,
    kind: 2, // SCENE_KIND_HUNT; o servidor manda o número, o codec resolve o nome
    your_entity: 2,
    snapshot_hz: 20,
    hunt: { gate_id: 'castelo-demonios', tier_min: 31, difficulty: 'normal' }
  });
  await sleep(5);

  assert.equal(client.state.scene.id, 'castelo-demonios');
  assert.equal(client.state.scene.kind, 'SCENE_KIND_HUNT');
  assert.equal(client.state.scene.instanceId, '157216');
  assert.equal(client.state.hunt.gateId, 'castelo-demonios');
  assert.equal(client.state.hunt.tierMin, 31);

  client.disconnect();
});

test('ratelimit.login espera longo em vez de desistir da conta', async () => {
  const client = makeClient({ autoReconnect: true });
  client.connect();
  await sleep(10);

  const ws = MockWebSocket.last;
  ws.reply('login', 'error', { code: 'ratelimit.login' });
  await sleep(10);

  assert.equal(client.status, 'reconnecting');
  assert.equal(client.lastError, 'ratelimit.login');
  assert.equal(client.endedReason, null, 'a credencial pode estar certa; não encerrar a conta');
  assert.ok(client.reconnectTimer, 'deve haver nova tentativa agendada');
  assert.equal(client.reconnectDelay, RATELIMIT_RETRY_MS, 'o teto normal não encurta a espera');

  client.disconnect();
});

test('credencial inválida encerra a conta sem insistir', async () => {
  const client = makeClient({ autoReconnect: true });
  client.connect();
  await sleep(10);

  const ws = MockWebSocket.last;
  ws.reply('login', 'error', { code: 'account.invalid_credentials' });
  await sleep(10);

  assert.equal(client.status, 'error');
  assert.equal(client.endedReason, 'account.invalid_credentials');
  assert.equal(client.autoReconnect, false, 'insistir só geraria ratelimit');
  assert.equal(client.reconnectTimer, null);

  client.disconnect();
});

test('arise_result contabiliza as sombras extraídas automaticamente', async () => {
  const client = makeClient();
  client.connect();
  await sleep(10);
  const ws = MockWebSocket.last;
  ws.reply('login', 'auth_ok', { token: 't', account_id: 1 });
  await sleep(5);

  const arises = [];
  client.on('arise', e => arises.push(e));

  ws.push('arise_result', { success: false, monster_id: 'goblin-sl', attempts: 3 });
  ws.push('arise_result', { success: true, monster_id: 'orc-jovem', rank: 'Normal', attempts: 1, new_species: true });
  ws.push('arise_result', { success: true, monster_id: 'troll-cavernas', rank: 'Elite', attempts: 2, awakened: true });
  await sleep(5);

  const s = client.state.shadows;
  assert.equal(s.attempts, 6);
  assert.equal(s.captured, 2);
  assert.equal(s.awakened, 1);
  assert.equal(s.newSpecies, 1);
  assert.equal(s.lastMonsterId, 'troll-cavernas');
  assert.equal(arises.length, 2, 'só capturas viram evento');

  client.disconnect();
});

test('inventory_delta guarda só a ocupação da mochila', async () => {
  const client = makeClient();
  client.connect();
  await sleep(10);
  const ws = MockWebSocket.last;
  ws.reply('login', 'auth_ok', { token: 't', account_id: 1 });
  await sleep(5);

  ws.push('inventory_delta', { used_slots: 42, capacity: 120 });
  await sleep(5);

  assert.deepEqual(client.state.inventory, { usedSlots: 42, capacity: 120 });
  assert.equal(client.state.inventory.capacity, 120);

  client.disconnect();
});

test('o catálogo de conteúdo não é desserializado', async () => {
  // São mais de 1 MB por login; nada ali alimenta o painel da caçada.
  assert.ok(IGNORED_PUSHES.has('content_catalog'));
  assert.ok(IGNORED_PUSHES.has('shadow_delta'));

  const client = makeClient();
  client.connect();
  await sleep(10);
  const ws = MockWebSocket.last;
  ws.reply('login', 'auth_ok', { token: 't', account_id: 1 });
  await sleep(5);

  let updates = 0;
  client.on('update', () => updates++);
  ws.push('content_catalog', { gates: [{ id: 'blue-gate', name: 'Portal Azul', min_level: 1 }] });
  await sleep(5);

  assert.equal(updates, 0);
  client.disconnect();
});

test('as taxas por hora saem do início real da caçada', async () => {
  const client = makeClient();
  client.connect();
  await sleep(10);
  const ws = MockWebSocket.last;
  ws.reply('login', 'auth_ok', { token: 't', account_id: 1 });
  await sleep(5);

  ws.push('hunt_session', {
    started_at_ms: Date.now() - 3600000, // uma hora de caçada
    kills: 500,
    xp: 120000,
    gold: 45000
  });
  await sleep(5);

  assert.equal(client.state.a.xph, 120000, 'xp/h após exatamente uma hora');
  assert.equal(client.state.a.killsph, 500);
  assert.equal(client.state.a.goldph, 45000);

  client.disconnect();
});

test('a conta sem proxy sai pelo IP local, e com proxy leva um dispatcher', async () => {
  // O `WebSocket` do undici só aceita rota pela opção `dispatcher`; é isso que
  // mantém cada conta num IP diferente e evita `session.multi_account_ip`.
  const direto = makeClient();
  direto.connect();
  await sleep(10);
  assert.equal(MockWebSocket.last.options.dispatcher, undefined,
    'sem proxy configurado, nada deve ser injetado na conexão');
  direto.disconnect();

  const viaProxy = makeClient({ proxy: 'http://127.0.0.1:9' });
  viaProxy.connect();
  await sleep(10);
  assert.ok(MockWebSocket.last.options.dispatcher, 'proxy configurado precisa chegar ao socket');
  assert.equal(MockWebSocket.last.options.headers.Origin, 'https://levelingidle2d.com.br',
    'o Origin continua o do jogo, independente da rota');
  viaProxy.disconnect();
});

// ----------------------------------------------------------------- auto-refill

/**
 * Catálogo como o servidor manda: enums pelo número, que é o que vai no fio. O
 * codec os resolve para nome na desserialização, e é por nome que o
 * planejador os indexa.
 */
const catalogPush = {
  version: 'test',
  consumables: [
    { kind: 1, tier: 1, price: 10 },  // HP pequena
    { kind: 2, tier: 1, price: 20 }   // mana pequena
  ],
  shop: [
    { id: 'ess', category: 2, item_def_id: 'essencia', price: 100, qty: 1 } // ESSENCE
  ],
  // A cidade da loja sai das regras: é o destino do `travel`.
  rules: { city_scene_id: 'cidade-seul' }
};

const refillOn = items => ({ enabled: true, reserveGold: 0, items });

/** A caçada em que a conta está; é ela que o `start_hunt` de volta reproduz. */
const HUNT = { gate_id: 'castelo-demonios', tier_min: 36, difficulty: 'normal' };

/** O NPC de loja da cidade, como o servidor real o descreve. */
const SHOP_NPC = {
  entity: 2,
  npc_id: 'comerciante',
  name: 'Brok, o Comerciante',
  pos: { x: 13330, y: 15500 },
  service: 2 // NPC_SERVICE_SHOP
};

/**
 * Conecta, autentica, entrega o catálogo e põe a conta na caçada. A cena de
 * caçada importa: sem ela não há bilhete de volta, e o refill se recusa a
 * viajar — comprar deixaria a conta parada na cidade.
 */
async function bootRefill(client) {
  client.connect();
  await sleep(10);
  const ws = MockWebSocket.last;
  ws.reply('login', 'auth_ok', { token: 't', account_id: 1 });
  await sleep(5);
  ws.push('content_catalog', catalogPush);
  ws.push('scene_enter', {
    scene_id: 'castelo-demonios',
    kind: 2, // SCENE_KIND_HUNT
    your_entity: 7,
    hunt: HUNT
  });
  await sleep(5);
  return ws;
}

const sentCount = (ws, caseName) => ws.sent.filter(m => m[caseName] !== undefined).length;

/** Espera o cliente enviar um pacote, sem prazo fixo no caso de teste. */
async function waitSent(ws, caseName, afterCount = 0) {
  for (let i = 0; i < 100; i++) {
    if (sentCount(ws, caseName) > afterCount) return ws.sent.filter(m => m[caseName] !== undefined).pop();
    await sleep(5);
  }
  return null;
}

/**
 * Faz o papel do servidor na viagem até a loja: responde o `travel` com a cena
 * da cidade, o `move_to` com a snapshot já no balcão e o `interact` com a
 * confirmação de loja aberta. Depois disso o cliente está apto a comprar.
 *
 * O servidor real exige os três: medido, `interact` sem o personagem ter andado
 * é ignorado em silêncio e a compra responde `shop.npcRequired`.
 */
async function serveTripToShop(ws, { npc = SHOP_NPC, skip } = {}) {
  assert.ok(await waitSent(ws, 'travel'), 'o refill precisa viajar para comprar');
  if (skip === 'travel') return;

  ws.push('scene_enter', {
    scene_id: 'cidade-seul',
    kind: 1, // SCENE_KIND_CITY
    your_entity: 7,
    npcs: npc ? [npc] : []
  });
  await sleep(5);
  if (skip === 'scene' || !npc) return;

  assert.ok(await waitSent(ws, 'move_to'), 'sem andar o servidor ignora o interact');
  if (skip === 'move') return;
  // Chegada ao balcão: é a snapshot que confirma, não um prazo.
  // `entities` é `EntityState` direto, sem invólucro: é assim que o servidor
  // manda, e foi o que fez a primeira sonda medir posição nula.
  ws.push('world_snapshot', { entities: [{ id: 7, x: npc.pos.x, y: npc.pos.y }] });
  await sleep(5);

  assert.ok(await waitSent(ws, 'interact'), 'a loja abre pelo interact no NPC');
  if (skip === 'interact') return;
  ws.push('npc_interaction', { entity: npc.entity, npc_id: npc.npc_id, service: 2 });
  await sleep(5);
}

/** Responde uma compra de consumível com o `gold_cost` que o servidor cobraria. */
async function serveBuy(ws, { qty, cost, owned, afterCount = 0 }) {
  const enviado = await waitSent(ws, 'buy_consumable', afterCount);
  assert.ok(enviado, 'nenhuma compra foi enviada');
  ws.reply('buy_consumable', 'buy_consumable_result', { qty, gold_cost: cost, owned });
  await sleep(5);
  return enviado;
}

/** Fecha o ciclo: confirma a volta à caçada e responde ao `start_hunt`. */
async function serveReturn(ws) {
  const volta = await waitSent(ws, 'start_hunt');
  assert.ok(volta, 'a conta precisa voltar à caçada depois de comprar');
  assert.deepEqual(volta.start_hunt, HUNT, 'a volta é para a mesma caçada, não outra');
  ws.reply('start_hunt', 'start_hunt_result', { ...HUNT, scene_id: 'castelo-demonios' });
  // A cena só depois de o cliente processar a resposta: ele registra a espera
  // por `scene_enter` ao retomar, e empurrar os dois juntos perderia o aviso.
  await sleep(5);
  ws.push('scene_enter', {
    scene_id: 'castelo-demonios',
    kind: 2,
    your_entity: 7,
    hunt: HUNT
  });
  // Tempo para o `finally` do ciclo encerrar e emitir o resultado.
  await sleep(10);
  return volta;
}

test('o estoque guarda as tiers separadas, além da soma do HUD', async () => {
  const client = makeClient();
  client.connect();
  await sleep(10);
  const ws = MockWebSocket.last;
  ws.reply('login', 'auth_ok', { token: 't', account_id: 1 });
  await sleep(5);

  ws.push('character_state', {
    consumables: {
      hp_potions: { pequena: 7, media: 3, grande: 1 },
      mana_potions: { pequena: 4 },
      revives: { grande: 2 }
    }
  });
  await sleep(5);

  // A soma é o que o painel mostra; a tier é o que a compra precisa.
  assert.equal(client.state.potions.hp, 11);
  assert.deepEqual(client.state.stock.hp, { pequena: 7, media: 3, grande: 1 });
  assert.deepEqual(client.state.stock.mana, { pequena: 4, media: 0, grande: 0 });
  assert.deepEqual(client.state.stock.revives, { pequena: 0, media: 0, grande: 2 });

  client.disconnect();
});

test('com o refill desligado o catálogo continua sem ser desserializado', async () => {
  const client = makeClient();
  client.connect();
  await sleep(10);
  const ws = MockWebSocket.last;
  ws.reply('login', 'auth_ok', { token: 't', account_id: 1 });
  await sleep(5);

  ws.push('content_catalog', catalogPush);
  await sleep(5);

  assert.equal(client.catalog, null, 'mais de 1 MB não deve entrar sem motivo');
  client.disconnect();
});

test('o catálogo é lido uma vez e guarda só preços e o id da essência', async () => {
  const client = makeClient({
    refillConfig: refillOn({ hpPequena: { min: 10, target: 10 } })
  });
  const ws = await bootRefill(client);

  assert.deepEqual(Object.keys(client.catalog), ['prices', 'essence', 'citySceneId']);
  assert.equal(client.catalog.essence.defId, 'essencia');

  // Lido uma vez: um segundo catálogo não deve voltar a desserializar.
  const primeiro = client.catalog;
  ws.push('content_catalog', catalogPush);
  await sleep(5);
  assert.equal(client.catalog, primeiro);

  client.disconnect();
});

test('o ciclo completo: viaja, anda até o NPC, compra e volta à caçada', async () => {
  const client = makeClient({
    refillConfig: refillOn({ hpPequena: { min: 20, target: 50 } })
  });
  const ws = await bootRefill(client);

  ws.push('character_state', {
    progress: { level: 40 },
    wallet: { gold: 100000 },
    consumables: { hp_potions: { pequena: 5 } }
  });

  // O servidor não vende à distância: `buy_consumable` numa cena de caçada
  // responde `shop.npcRequired`. A compra só pode sair depois da viagem.
  await serveTripToShop(ws);

  // O HUD mostra a viagem: sem isto a cena virar cidade pareceria um bug.
  assert.equal(client.state.refillTrip, true, 'a viagem aparece no estado emitido');

  // Primeira compra: uma unidade, porque o preço real ainda é desconhecido.
  const sonda = await serveBuy(ws, { qty: 1, cost: 11, owned: 6 });
  assert.equal(sonda.buy_consumable.qty, 1, 'uma unidade para aprender o preço');
  assert.equal(client.learnedPrices.hpPequena, 11,
    'o gold_cost cobrado é o preço real, não o do catálogo');

  // Segunda: já no balcão, o lote restante sai com o preço aprendido.
  const lote = await serveBuy(ws, { qty: 44, cost: 484, owned: 50, afterCount: 1 });
  assert.equal(lote.buy_consumable.qty, 44, 'o que faltava para o alvo de 50');

  await serveReturn(ws);

  assert.equal(client.state.scene.id, 'castelo-demonios', 'a conta não fica na cidade');
  assert.equal(client.state.stock.hp.pequena, 50);
  assert.equal(client.trip, null, 'o ciclo encerrou');
  assert.equal(client.state.refillTrip, false, 'e o HUD para de avisar a viagem');
  client.disconnect();
});

test('a ordem dos pacotes do ciclo é travel, move_to, interact, compra, volta', async () => {
  const client = makeClient({
    refillConfig: refillOn({ hpPequena: { min: 20, target: 21 } })
  });
  const ws = await bootRefill(client);

  ws.push('character_state', {
    progress: { level: 40 },
    wallet: { gold: 100000 },
    consumables: { hp_potions: { pequena: 5 } }
  });
  await serveTripToShop(ws);
  await serveBuy(ws, { qty: 1, cost: 11, owned: 21 });
  await serveReturn(ws);

  const ordem = ws.sent
    .map(m => Object.keys(m).find(k => k !== 'request_id'))
    .filter(k => ['travel', 'move_to', 'interact', 'buy_consumable', 'start_hunt'].includes(k));

  assert.deepEqual(ordem, ['travel', 'move_to', 'interact', 'buy_consumable', 'start_hunt']);
  client.disconnect();
});

test('o resultado da compra atualiza o estoque pelo owned e desconta o ouro', async () => {
  const client = makeClient({
    refillConfig: refillOn({ hpPequena: { min: 20, target: 50 } })
  });
  const ws = await bootRefill(client);

  const events = [];
  client.on('refill', e => events.push(e));

  ws.push('character_state', {
    progress: { level: 40 },
    wallet: { gold: 100000 },
    consumables: { hp_potions: { pequena: 5 } }
  });
  await serveTripToShop(ws);
  await serveBuy(ws, { qty: 1, cost: 11, owned: 6 });
  await serveBuy(ws, { qty: 44, cost: 484, owned: 50, afterCount: 1 });
  await serveReturn(ws);

  assert.equal(client.state.stock.hp.pequena, 50, '`owned` é o total da tier comprada');
  assert.equal(client.state.potions.hp, 50, 'a soma do HUD acompanha');
  assert.equal(client.state.gold, 100000 - 11 - 484);

  const ok = events.filter(e => e.ok);
  assert.equal(ok.length, 1, 'um evento por ciclo, não por compra');
  assert.equal(ok[0].cost, 495, 'o custo é o total do ciclo');

  client.disconnect();
});

test('a conta volta à caçada mesmo quando a compra é recusada', async () => {
  // O pior defeito possível aqui é a conta ficar parada na cidade rendendo
  // nada por causa de um erro no meio do ciclo.
  const client = makeClient({
    refillConfig: refillOn({ hpPequena: { min: 20, target: 50 } }),
    refillBackoffMs: 60000
  });
  const ws = await bootRefill(client);

  const events = [];
  client.on('refill', e => events.push(e));

  ws.push('character_state', {
    progress: { level: 40 },
    wallet: { gold: 100000 },
    consumables: { hp_potions: { pequena: 5 } }
  });
  await serveTripToShop(ws);

  assert.ok(await waitSent(ws, 'buy_consumable'));
  ws.reply('buy_consumable', 'error', { code: 'wallet.insufficient_gold' });
  await sleep(5);

  await serveReturn(ws);

  assert.equal(client.state.scene.id, 'castelo-demonios');
  assert.equal(events[0].ok, false);
  assert.equal(events[0].error, 'wallet.insufficient_gold');
  client.disconnect();
});

test('sem NPC de loja na cidade a conta é devolvida sem comprar', async () => {
  const client = makeClient({
    refillConfig: refillOn({ hpPequena: { min: 20, target: 50 } }),
    refillBackoffMs: 60000
  });
  const ws = await bootRefill(client);

  const events = [];
  client.on('refill', e => events.push(e));

  ws.push('character_state', {
    progress: { level: 40 },
    wallet: { gold: 100000 },
    consumables: { hp_potions: { pequena: 5 } }
  });
  await serveTripToShop(ws, { npc: null });
  await serveReturn(ws);

  assert.equal(sentCount(ws, 'buy_consumable'), 0, 'sem balcão não há compra');
  assert.equal(events[0].error, 'refill.noShopNpc');
  assert.equal(client.state.scene.id, 'castelo-demonios');
  // Viagem sem compra também precisa aparecer: a conta saiu da caçada por nada.
  assert.equal(client.state.refill.error, 'refill.noShopNpc');
  assert.deepEqual(client.state.refill.items, []);
  client.disconnect();
});

test('sem bilhete de volta o refill não viaja', async () => {
  // Monitor que entrou com a conta fora de caçada: viajar a deixaria parada na
  // cidade sem nada que a recolocasse.
  const client = makeClient({
    refillConfig: refillOn({ hpPequena: { min: 20, target: 50 } })
  });
  client.connect();
  await sleep(10);
  const ws = MockWebSocket.last;
  ws.reply('login', 'auth_ok', { token: 't', account_id: 1 });
  await sleep(5);
  ws.push('content_catalog', catalogPush);
  ws.push('scene_enter', { scene_id: 'cidade-seul', kind: 1, your_entity: 7 });
  await sleep(5);

  ws.push('character_state', {
    progress: { level: 40 },
    wallet: { gold: 100000 },
    consumables: { hp_potions: { pequena: 1 } }
  });
  await sleep(30);

  assert.equal(client.huntTicket, null);
  assert.equal(sentCount(ws, 'travel'), 0, 'sem volta garantida, não sai da cena');
  assert.equal(sentCount(ws, 'buy_consumable'), 0);
  client.disconnect();
});

test('viagem interrompida pela queda da conexão é resgatada no login seguinte', async () => {
  const client = makeClient({
    refillConfig: refillOn({ hpPequena: { min: 20, target: 50 } }),
    autoReconnect: false
  });
  const ws = await bootRefill(client);

  ws.push('character_state', {
    progress: { level: 40 },
    wallet: { gold: 100000 },
    consumables: { hp_potions: { pequena: 5 } }
  });
  await serveTripToShop(ws);

  // A conexão cai com a conta na cidade, antes do `start_hunt`.
  assert.equal(client.tripInterrupted, true);
  ws.close(1006);
  await sleep(10);

  // Novo login: a conta aparece na cidade e precisa ser devolvida à caçada.
  client.connect();
  await sleep(10);
  const ws2 = MockWebSocket.last;
  // Reconexão com token usa `resume`, não `login`.
  ws2.reply('resume', 'auth_ok', { token: 't', account_id: 1 });
  await sleep(5);
  ws2.push('scene_enter', { scene_id: 'cidade-seul', kind: 1, your_entity: 7 });
  await sleep(10);

  const volta = await waitSent(ws2, 'start_hunt');
  assert.ok(volta, 'a conta não pode ficar esquecida na cidade');
  assert.deepEqual(volta.start_hunt, HUNT);
  client.disconnect();
});

test('o resgate não reinicia a caçada de quem já voltou sozinho', async () => {
  const client = makeClient({
    refillConfig: refillOn({ hpPequena: { min: 20, target: 50 } }),
    autoReconnect: false
  });
  const ws = await bootRefill(client);

  ws.push('character_state', {
    progress: { level: 40 },
    wallet: { gold: 100000 },
    consumables: { hp_potions: { pequena: 5 } }
  });
  await serveTripToShop(ws);
  ws.close(1006);
  await sleep(10);

  client.connect();
  await sleep(10);
  const ws2 = MockWebSocket.last;
  ws2.reply('resume', 'auth_ok', { token: 't', account_id: 1 });
  await sleep(5);
  // O servidor devolveu a conta à caçada por conta própria.
  ws2.push('scene_enter', { scene_id: 'castelo-demonios', kind: 2, your_entity: 7, hunt: HUNT });
  await sleep(20);

  assert.equal(sentCount(ws2, 'start_hunt'), 0,
    'reiniciar a caçada em curso zeraria os contadores da sessão sem motivo');
  client.disconnect();
});

test('estoque no mínimo não compra nada', async () => {
  const client = makeClient({
    refillConfig: refillOn({ hpPequena: { min: 20, target: 50 } })
  });
  const ws = await bootRefill(client);

  ws.push('character_state', {
    progress: { level: 40 },
    wallet: { gold: 100000 },
    consumables: { hp_potions: { pequena: 20 } }
  });
  await sleep(10);

  assert.equal(ws.sent.some(m => m.buy_consumable), false);
  client.disconnect();
});

test('o intervalo impede uma viagem por patch durante a caçada', async () => {
  const client = makeClient({
    refillConfig: refillOn({ hpPequena: { min: 20, target: 50 } }),
    refillIntervalMs: 5000
  });
  const ws = await bootRefill(client);

  ws.push('character_state', {
    progress: { level: 40 },
    wallet: { gold: 100000 },
    consumables: { hp_potions: { pequena: 5 } }
  });
  await serveTripToShop(ws);
  await serveBuy(ws, { qty: 1, cost: 11, owned: 6 });
  await serveBuy(ws, { qty: 44, cost: 484, owned: 50, afterCount: 1 });
  await serveReturn(ws);

  // A automação gasta poção a cada segundo, e cada uso traz um patch novo. Cada
  // viagem custa ~3 s fora da caçada, então isto é o que impede o monitor de
  // passar o dia indo e voltando da cidade.
  for (let i = 10; i > 0; i--) {
    ws.push('character_patch', { consumables: { hp_potions: { pequena: i } } });
    await sleep(2);
  }
  await sleep(10);

  assert.equal(sentCount(ws, 'travel'), 1, 'dez patches não podem virar dez viagens');
  client.disconnect();
});

test('recusa do servidor recua em vez de repetir a viagem', async () => {
  const client = makeClient({
    refillConfig: refillOn({ hpPequena: { min: 20, target: 50 } }),
    refillIntervalMs: 1,
    refillBackoffMs: 60000
  });
  const ws = await bootRefill(client);

  const events = [];
  client.on('refill', e => events.push(e));

  ws.push('character_state', {
    progress: { level: 40 },
    wallet: { gold: 100000 },
    consumables: { hp_potions: { pequena: 5 } }
  });
  await serveTripToShop(ws);
  assert.ok(await waitSent(ws, 'buy_consumable'));
  ws.reply('buy_consumable', 'error', { code: 'wallet.insufficient_gold' });
  await sleep(5);
  await serveReturn(ws);

  assert.equal(events.length, 1);
  assert.equal(events[0].ok, false);
  assert.equal(events[0].error, 'wallet.insufficient_gold');
  assert.ok(client.refillAt > Date.now() + 30000, 'o recuo precisa ser longo');

  // O estoque continua abaixo do mínimo: sem o recuo isto viraria um laço de
  // viagens, que é muito pior do que um laço de requests.
  ws.push('character_patch', { consumables: { hp_potions: { pequena: 4 } } });
  await sleep(10);
  assert.equal(sentCount(ws, 'travel'), 1);

  client.disconnect();
});

test('vários itens saem em série, não em paralelo, numa viagem só', async () => {
  const client = makeClient({
    refillConfig: refillOn({
      hpPequena: { min: 10, target: 10 },
      manaPequena: { min: 10, target: 10 }
    })
  });
  const ws = await bootRefill(client);

  ws.push('character_state', { progress: { level: 40 }, wallet: { gold: 100000 } });
  await serveTripToShop(ws);

  // Em paralelo as duas dividiriam o mesmo ouro sem o servidor conciliar.
  assert.equal(sentCount(ws, 'buy_consumable'), 1,
    'a segunda compra só pode sair após a primeira responder');

  // Uma unidade de cada por passagem, até os preços serem conhecidos.
  await serveBuy(ws, { qty: 1, cost: 11, owned: 1 });
  const segunda = await serveBuy(ws, { qty: 1, cost: 8, owned: 1, afterCount: 1 });
  assert.equal(segunda.buy_consumable.kind, 'CONSUMABLE_KIND_MANA_POTION');

  // Segunda passagem, já com os preços aprendidos: o lote restante de cada um.
  await serveBuy(ws, { qty: 9, cost: 99, owned: 10, afterCount: 2 });
  await serveBuy(ws, { qty: 9, cost: 72, owned: 10, afterCount: 3 });
  await serveReturn(ws);

  // O que importa: os dois itens cabem na mesma ida à cidade.
  assert.equal(sentCount(ws, 'travel'), 1, 'dois itens não são duas viagens');
  assert.equal(client.learnedPrices.manaPequena, 8,
    'cada item tem o seu preço: a mesma base custa diferente');

  client.disconnect();
});

test('essência é comprada por buy_essence, com saldo vindo dos materiais', async () => {
  const client = makeClient({
    refillConfig: refillOn({ essence: { min: 50, target: 80 } })
  });
  const ws = await bootRefill(client);

  ws.push('character_state', {
    progress: { level: 40 },
    wallet: { gold: 100000 },
    // Essência não tem campo próprio: é material, achado pelo id do catálogo.
    inventory: { bag_used: 10, bag_capacity: 120, materials: [
      { def_id: 'pedra', qty: 500 },
      { def_id: 'essencia', qty: 12 }
    ] }
  });
  await serveTripToShop(ws);

  assert.equal(client.state.stock.essence, 12);
  const sonda = await waitSent(ws, 'buy_essence');
  assert.ok(sonda, 'essência usa buy_essence, não buy_consumable');
  assert.deepEqual(sonda.buy_essence, { qty: 1 }, 'uma unidade, para aprender o preço');
  ws.reply('buy_essence', 'buy_essence_result', { qty: 1, gold_cost: 1 });
  await sleep(5);

  // Medido contra o servidor: a essência custa 1 e o catálogo acertou. Mesmo
  // assim o preço só é tratado como conhecido depois de o servidor cobrá-lo.
  assert.equal(client.learnedPrices.essence, 1);
  const lote = await waitSent(ws, 'buy_essence', 1);
  assert.deepEqual(lote.buy_essence, { qty: 67 }, 'o resto do alvo de 80');
  ws.reply('buy_essence', 'buy_essence_result', { qty: 67, gold_cost: 67 });
  await sleep(5);

  assert.equal(sentCount(ws, 'buy_consumable'), 0);
  await serveReturn(ws);
  client.disconnect();
});

test('sem o catálogo o refill não compra às cegas', async () => {
  const client = makeClient({
    refillConfig: refillOn({ hpPequena: { min: 20, target: 50 } })
  });
  client.connect();
  await sleep(10);
  const ws = MockWebSocket.last;
  ws.reply('login', 'auth_ok', { token: 't', account_id: 1 });
  await sleep(5);
  // Nenhum `content_catalog`: o preço é desconhecido.

  ws.push('character_state', {
    progress: { level: 40 },
    wallet: { gold: 100000 },
    consumables: { hp_potions: { pequena: 1 } }
  });
  await sleep(30);

  assert.equal(sentCount(ws, 'travel'), 0, 'sem preço conhecido nem sai da caçada');
  assert.equal(sentCount(ws, 'buy_consumable'), 0);
  client.disconnect();
});

test('a reserva de ouro limita a compra', async () => {
  const client = makeClient({
    refillConfig: {
      enabled: true,
      reserveGold: 9800,
      items: { hpPequena: { min: 100, target: 1000 } }
    }
  });
  const ws = await bootRefill(client);

  ws.push('character_state', { progress: { level: 40 }, wallet: { gold: 10000 } });
  await serveTripToShop(ws);

  // Sonda uma unidade e descobre que o preço real é 11, não os 10 do catálogo.
  await serveBuy(ws, { qty: 1, cost: 11, owned: 1 });

  // Restam 189 dos 200 livres. A 11 cada, cabem 17 — e é o preço cobrado que
  // manda, não o do catálogo, senão a reserva seria furada.
  const lote = await serveBuy(ws, { qty: 17, cost: 187, owned: 18, afterCount: 1 });
  assert.equal(lote.buy_consumable.qty, 17);
  assert.equal(client.state.gold, 10000 - 11 - 187);
  assert.ok(client.state.gold >= 9800, 'a reserva continua intocada');

  await serveReturn(ws);
  client.disconnect();
});

test('o manager aplica a configuração nos monitores em execução', async () => {
  const manager = new LevelingHeadlessManager({ WebSocket: MockWebSocket, autoReconnect: false });
  manager.start(0, { username: 'u', password: 'p' });
  await sleep(10);
  const ws = MockWebSocket.last;
  ws.reply('login', 'auth_ok', { token: 't', account_id: 1 });
  await sleep(5);

  const client = manager.getClient(0);
  assert.equal(client.refillConfig.enabled, false, 'nasce desligado');

  manager.setRefillConfig(refillOn({ hpPequena: { min: 10, target: 20 } }));
  assert.equal(client.refillConfig.enabled, true);
  assert.equal(client.refillConfig.items.hpPequena.min, 10);

  // A configuração guardada vale para um monitor iniciado depois.
  manager.start(1, { username: 'u2', password: 'p2' });
  await sleep(10);
  assert.equal(manager.getClient(1).refillConfig.items.hpPequena.min, 10);

  manager.stopAll();
});

test('contas na mesma rota compartilham o dispatcher', () => {
  const { proxyDispatcher } = require('../src/domain/leveling-headless-service');
  const a = proxyDispatcher('http://127.0.0.1:9');
  const b = proxyDispatcher('http://127.0.0.1:9');
  const c = proxyDispatcher('http://127.0.0.1:10');

  assert.equal(a, b, 'duas contas no mesmo proxy não devem abrir dois pools');
  assert.notEqual(a, c);
  assert.equal(proxyDispatcher(''), null, 'sem proxy não há dispatcher');
});

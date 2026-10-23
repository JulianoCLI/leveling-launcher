const { test } = require('node:test');
const assert = require('node:assert/strict');

// O módulo é escrito para o renderizador; aqui basta um `window` de mentira.
global.window = {};
const metrics = require('../src/ui/hud-metrics');

test('estado sem jogo declarado cai no PokeIdle', () => {
  const resolved = metrics.resolve({ balls: 12, a: { seconds: 65, xph: 1500 } });
  assert.equal(resolved.game, 'pokeidle');
  assert.deepEqual(resolved.columns.map(c => c.key), ['time', 'balls', 'xph', 'shinies']);
});

test('PokeIdle mostra infinito quando a bola é ilimitada', () => {
  const infinita = metrics.resolve({ equippedBall: { infinite: true }, balls: 3 });
  assert.equal(infinita.columns.find(c => c.key === 'balls').value, '∞');

  const porContagem = metrics.resolve({ balls: 999999 });
  assert.equal(porContagem.columns.find(c => c.key === 'balls').value, '∞');
});

const levelingState = () => ({
  game: 'leveling-idle',
  name: 'desjunior',
  level: 41,
  hp: 5700,
  maxHp: 6275,
  power: 4297,
  hunt: {
    gateId: 'castelo-demonios',
    difficulty: 'normal',
    tierMin: 31,
    kills: 248,
    chests: 2,
    wave: 2,
    streak: 86,
    bestStreak: 35672,
    redPortalUntilMs: 0
  },
  shadows: { attempts: 6, captured: 2 },
  inventory: { usedSlots: 42, capacity: 120 },
  a: { seconds: 3600, xph: 376634, goldph: 16386, killsph: 248 },
  death: null
});

test('Leveling declara as métricas da caçada, não as do PokeIdle', () => {
  const resolved = metrics.resolve(levelingState());
  const keys = resolved.columns.map(c => c.key);

  assert.equal(resolved.game, 'leveling-idle');
  assert.ok(!keys.includes('balls'), 'Pokébolas não existem nesse jogo');
  assert.ok(!keys.includes('shinies'));
  assert.deepEqual(keys, [
    'time', 'kills', 'xph', 'goldph', 'streak', 'wave', 'shadows', 'chests', 'bag',
    'statPoints', 'talentPoints', 'party'
  ]);

  const byKey = Object.fromEntries(resolved.columns.map(c => [c.key, c.value]));
  assert.equal(byKey.time, '1h 00m 00s');
  assert.equal(byKey.kills, '248');
  assert.equal(byKey.xph, '377k');
  assert.equal(byKey.streak, '86 / 36k', 'acima de 10k o formato compacto perde a decimal');
  assert.equal(byKey.wave, '2 · T31');
  assert.equal(byKey.shadows, '2 / 6', 'tentativas importam: a extração falha quase sempre');
  assert.equal(byKey.bag, '42 / 120');
  // Sem estado de pontos nem de grupo, as colunas mostram o zero e o "Sozinho"
  // em vez de sumir: elas valem sempre, ao contrário da mochila.
  assert.equal(byKey.statPoints, '0');
  assert.equal(byKey.talentPoints, '0');
  assert.equal(byKey.party, 'Sozinho');
});

test('pontos de talento separam as árvores em vez de somá-las', () => {
  const state = levelingState();
  state.points = { stat: 12, talent: 3, shadowTalent: 2, ambitionTalent: 1 };
  const byKey = Object.fromEntries(metrics.resolve(state).columns.map(c => [c.key, c.value]));

  assert.equal(byKey.statPoints, '12');
  assert.equal(byKey.talentPoints, '3 (+2 sombra, 1 ambição)',
    'somar esconderia em qual árvore os pontos podem ser gastos');
});

test('grupo mostra a lotação, e sozinho não vira "0 / 0"', () => {
  const state = levelingState();
  state.party = { id: 'p1', members: [{ name: 'a' }, { name: 'b' }], maxMembers: 4 };
  const comParty = Object.fromEntries(metrics.resolve(state).columns.map(c => [c.key, c.value]));
  assert.equal(comParty.party, '2 / 4');

  state.party = { id: '', members: [] };
  const sozinho = Object.fromEntries(metrics.resolve(state).columns.map(c => [c.key, c.value]));
  assert.equal(sozinho.party, 'Sozinho');
});

test('coluna que devolve null é omitida', () => {
  const state = levelingState();
  state.inventory = { usedSlots: 0, capacity: 0 };
  const keys = metrics.resolve(state).columns.map(c => c.key);
  assert.ok(!keys.includes('bag'), 'sem capacidade conhecida, a mochila não aparece');
});

test('morte vira alerta de perigo, sem sugerir ação', () => {
  const state = levelingState();
  state.death = { dead: true, xpLost: 12500 };

  const banner = metrics.resolve(state).banner;
  assert.equal(banner.kind, 'danger');
  assert.match(banner.text, /reviver automático/);
  assert.match(banner.text, /−13k xp/);
});

test('portal vermelho ativo mostra o tempo restante', () => {
  const state = levelingState();
  state.hunt.redPortalUntilMs = Date.now() + 30000;

  const banner = metrics.resolve(state).banner;
  assert.equal(banner.kind, 'warn');
  assert.match(banner.text, /Portal vermelho/);
});

test('portal vermelho expirado não gera alerta', () => {
  const state = levelingState();
  state.hunt.redPortalUntilMs = Date.now() - 1000;
  assert.equal(metrics.resolve(state).banner, null);
});

test('HP abaixo de 25% alerta', () => {
  const state = levelingState();
  state.hp = 900;
  const banner = metrics.resolve(state).banner;
  assert.equal(banner.kind, 'warn');
  assert.match(banner.text, /HP baixo/);
});

test('estado saudável não gera alerta', () => {
  assert.equal(metrics.resolve(levelingState()).banner, null);
});

test('estado vazio ou nulo não quebra o HUD', () => {
  for (const state of [null, undefined, {}, { game: 'leveling-idle' }]) {
    const resolved = metrics.resolve(state);
    assert.ok(Array.isArray(resolved.columns));
    for (const column of resolved.columns) assert.equal(typeof column.value, 'string');
  }
});

test('adapter que lança não derruba o painel', () => {
  metrics.register({
    id: 'quebrado',
    metrics: [
      { key: 'ruim', label: 'Ruim', value: () => { throw new Error('boom'); } },
      { key: 'bom', label: 'Bom', value: () => 'ok' }
    ],
    banner: () => { throw new Error('boom'); }
  });

  const resolved = metrics.resolve({ game: 'quebrado' });
  assert.deepEqual(resolved.columns.map(c => c.key), ['bom']);
  assert.equal(resolved.banner, null);
});

test('jogo desconhecido não some com o painel', () => {
  const resolved = metrics.resolve({ game: 'jogo-que-nao-existe', balls: 5 });
  assert.equal(resolved.game, 'pokeidle');
});

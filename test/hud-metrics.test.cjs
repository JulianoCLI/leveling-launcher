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
  gold: 1840000,
  diamonds: 320,
  xp: 10000,
  xpToNext: 188317,
  scene: { id: 'castelo-demonios', kind: 'hunt', channel: 3 },
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
  for (const removida of ['streak', 'wave', 'shadows', 'chests']) {
    assert.ok(!keys.includes(removida), `${removida} saiu do painel`);
  }
  assert.deepEqual(keys, [
    'kills', 'time', 'xph', 'levelEta', 'gold', 'diamonds', 'bag',
    'statPoints', 'talentPoints', 'party'
  ]);

  const byKey = Object.fromEntries(resolved.columns.map(c => [c.key, c.value]));
  assert.equal(byKey.gold, '1.8M');
  assert.equal(byKey.diamonds, '320');
  // 188317 xp a 376634 xp/h é meia hora.
  assert.equal(byKey.levelEta, '30m 00s');
  assert.equal(byKey.time, '1h 00m 00s');
  assert.equal(byKey.kills, '248');
  assert.equal(byKey.xph, '377k');
  assert.equal(byKey.bag, '42 / 120');
  // Sem estado de pontos nem de grupo, as colunas mostram o zero e o "Sozinho"
  // em vez de sumir: elas valem sempre, ao contrário da mochila.
  assert.equal(byKey.statPoints, '0');
  assert.equal(byKey.talentPoints, '0');
  assert.equal(byKey.party, 'Sozinho');
});

test('sem taxa de xp medida, o prazo cai para o xp que falta', () => {
  const state = levelingState();
  state.a.xph = 0;
  const byKey = Object.fromEntries(metrics.resolve(state).columns.map(c => [c.key, c.value]));
  assert.equal(byKey.levelEta, '188k xp',
    'um prazo inventado sem taxa seria pior que nenhum');

  state.xpToNext = 0;
  const nivelado = Object.fromEntries(metrics.resolve(state).columns.map(c => [c.key, c.value]));
  assert.equal(nivelado.levelEta, '—');
});

test('local vira bloco próprio, com o id do servidor virando rótulo', () => {
  const place = metrics.resolve(levelingState()).location;
  assert.equal(place.label, 'Caçando em');
  assert.equal(place.map, 'Castelo Demonios');
  assert.equal(place.detail, 'Tier 31 · Normal · Canal 3');
  assert.equal(place.hunting, true);
});

test('na cidade o local não diz que está caçando', () => {
  const state = levelingState();
  state.scene = { id: 'cidade-central', kind: 'city' };
  const place = metrics.resolve(state).location;
  assert.equal(place.label, 'Local');
  assert.equal(place.hunting, false);
});

test('sem mapa conhecido o bloco de local não aparece', () => {
  const state = levelingState();
  state.hunt.gateId = '';
  state.scene = {};
  assert.equal(metrics.resolve(state).location, null);
});

test('pontos de talento separam as árvores em vez de somá-las', () => {
  const state = levelingState();
  state.points = { stat: 12, talent: 3, shadowTalent: 2, ambitionTalent: 1 };
  const byKey = Object.fromEntries(metrics.resolve(state).columns.map(c => [c.key, c]));

  assert.equal(byKey.statPoints.value, '12');
  assert.equal(byKey.talentPoints.value, '3');
  assert.equal(byKey.talentPoints.hint, '2 sombra · 1 ambição',
    'somar esconderia em qual árvore os pontos podem ser gastos');
  assert.equal(byKey.statPoints.tone, 'warn', 'ponto parado é poder não usado');
});

test('abates mostram o ritmo, não só o total', () => {
  const kills = metrics.resolve(levelingState()).columns.find(c => c.key === 'kills');
  assert.equal(kills.value, '248');
  assert.equal(kills.hint, '248/h', 'o total sem o ritmo não compara um painel com outro');
});

test('mochila enchendo muda de tom antes de encher', () => {
  const state = levelingState();
  const tomDe = () => metrics.resolve(state).columns.find(c => c.key === 'bag').tone;

  assert.equal(tomDe(), '', '42 de 120 não é assunto');
  state.inventory = { usedSlots: 100, capacity: 120 };
  assert.equal(tomDe(), 'warn');
  state.inventory = { usedSlots: 119, capacity: 120 };
  assert.equal(tomDe(), 'bad', 'com a bolsa cheia o drop é perdido');
});

test('colunas vêm agrupadas por assunto, sem bloco vazio', () => {
  const state = levelingState();
  // Sem capacidade a mochila some, e com ela sairia o único item do bloco.
  state.inventory = { usedSlots: 0, capacity: 0 };
  state.potions = {};

  const groups = metrics.resolve(state).groups;
  assert.deepEqual(groups.map(g => g.id), ['rendimento', 'carteira', 'conta'],
    'um título sozinho sobre espaço em branco parece painel quebrado');
  assert.deepEqual(
    groups.find(g => g.id === 'rendimento').columns.map(c => c.key),
    ['kills', 'time', 'xph', 'levelEta']
  );
});

test('jogo sem blocos declarados vira um bloco só, sem título', () => {
  const groups = metrics.resolve({ balls: 3 }).groups;
  assert.equal(groups.length, 1);
  assert.equal(groups[0].title, '');
  assert.deepEqual(groups[0].columns.map(c => c.key), ['time', 'balls', 'xph', 'shinies']);
});

test('ouro da caçada mostra o que foi gasto nela', () => {
  const state = levelingState();
  state.hunt.gold = 2000000;
  state.hunt.goldSpent = 1800000;
  const col = metrics.resolve(state).columns.find(c => c.key === 'huntGold');
  assert.equal(col.value, '2M');
  assert.equal(col.hint, '−1.8M gasto', 'sem o gasto, "ganhei 2M" é meia verdade');
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

const lootState = () => {
  const state = levelingState();
  const t = Date.UTC(2024, 0, 1, 12, 0, 0);
  state.loot = {
    session: {
      'essencia-extracao': {
        defId: 'essencia-extracao', name: 'Essência', order: 1,
        color: '#aaa', qty: 999, bag: 4200, lastAtMs: t + 500
      },
      'chave-portal-vermelho': {
        defId: 'chave-portal-vermelho', name: 'Chave do Portal', order: 3,
        color: '#ffd27a', key: true, qty: 2, bag: 2, lastAtMs: t
      },
      'po-arcano': {
        defId: 'po-arcano', name: 'Pó Arcano', order: 2,
        color: '#8cf', qty: 51, bag: 51, lastAtMs: t + 900
      }
    },
    log: [
      { defId: 'chave-portal-vermelho', name: 'Chave do Portal', color: '#ffd27a', key: true, qty: 1, bag: 2, reason: 'baú', atMs: t },
      { defId: 'essencia-extracao', name: 'Essência', color: '#aaa', qty: 12, bag: 4200, reason: 'drop', atMs: t - 4000 }
    ],
    events: 1052,
    startedAtMs: t - 60000
  };
  return state;
};

test('drops aparecem com chave na frente, e não por quantidade', () => {
  const loot = metrics.resolve(lootState()).loot;

  assert.equal(loot.title, 'Drops da caçada');
  assert.deepEqual(loot.items.map(i => i.defId),
    ['chave-portal-vermelho', 'po-arcano', 'essencia-extracao'],
    'ordenar por quantidade poria mil essências na frente da chave');
  assert.equal(loot.items[0].qty, '2');
  assert.equal(loot.items[0].key, true);
});

test('saldo da bolsa só aparece quando difere do que caiu', () => {
  const loot = metrics.resolve(lootState()).loot;
  const porId = Object.fromEntries(loot.items.map(i => [i.defId, i]));

  assert.equal(porId['essencia-extracao'].bag, '4.200 na bolsa');
  assert.equal(porId['chave-portal-vermelho'].bag, '',
    'repetir "2 · 2 na bolsa" gasta a linha sem dizer nada');
});

test('o registro traz horário com segundos e o motivo quando não é drop', () => {
  const log = metrics.resolve(lootState()).loot.log;

  assert.match(log[0].time, /^\d{2}:\d{2}:\d{2}$/,
    'sem segundos, cinco linhas no mesmo minuto perdem a ordem');
  assert.equal(log[0].reason, 'baú');
  assert.equal(log[1].reason, '', 'dizer "drop" num log de drops é ruído');
  assert.equal(log[1].qty, '12');
});

test('sem nada caído o bloco de drops não aparece', () => {
  assert.equal(metrics.resolve(levelingState()).loot, null);

  const vazio = levelingState();
  vazio.loot = { session: {}, log: [] };
  assert.equal(metrics.resolve(vazio).loot, null);
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
    banner: () => { throw new Error('boom'); },
    loot: () => { throw new Error('boom'); }
  });

  const resolved = metrics.resolve({ game: 'quebrado' });
  assert.deepEqual(resolved.columns.map(c => c.key), ['bom']);
  assert.equal(resolved.banner, null);
  assert.equal(resolved.loot, null);
});

test('enfeite que quebra não leva junto o número', () => {
  metrics.register({
    id: 'enfeite-ruim',
    metrics: [{
      key: 'n',
      label: 'N',
      value: () => '42',
      hint: () => { throw new Error('boom'); },
      tone: () => { throw new Error('boom'); }
    }]
  });

  const col = metrics.resolve({ game: 'enfeite-ruim' }).columns[0];
  assert.equal(col.value, '42', 'o número é a razão da coluna existir');
  assert.equal(col.hint, '');
  assert.equal(col.tone, '');
});

test('jogo desconhecido não some com o painel', () => {
  const resolved = metrics.resolve({ game: 'jogo-que-nao-existe', balls: 5 });
  assert.equal(resolved.game, 'pokeidle');
});

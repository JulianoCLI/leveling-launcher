const { test } = require('node:test');
const assert = require('node:assert/strict');

const loot = require('../src/domain/leveling-loot');

const catalog = {
  items: {
    'essencia-extracao': { name: 'Essência', category: 'materials', rarity: 'comum' },
    'chave-portal-vermelho': { name: 'Chave do Portal Vermelho', category: 'materials', rarity: 'epico' },
    'arco-arqueiro': { name: 'Arco do Arqueiro', category: 'weapons', rarity: 'raro' },
    'elmo-sombrio': { name: 'Elmo Sombrio', category: 'armor', rarity: 'raro' },
    'membrana-sombria': { name: 'Membrana Sombria', category: 'imbue_materials', rarity: 'raro' }
  },
  rarities: {
    comum: { name: 'Comum', color: '#9aa', order: 1 },
    raro: { name: 'Raro', color: '#49f', order: 3 },
    epico: { name: 'Épico', color: '#b6f', order: 5 }
  }
};

const delta = (over = {}) => ({
  scope: 'INVENTORY_SCOPE_BAG',
  reason: 'DELTA_REASON_DROP',
  added: [],
  updated: [],
  removed: [],
  ...over
});

const novo = () => ({ loot: loot.initialLoot(), stacks: new Map() });

function aplicar(ctx, value, nowMs) {
  return loot.apply(ctx.loot, value, { stacks: ctx.stacks, catalog, nowMs });
}

test('pilha nova conta a quantidade inteira', () => {
  const ctx = novo();
  const mudou = aplicar(ctx, delta({
    added: [{ uid: '1', def_id: 'chave-portal-vermelho', qty: 2, rarity: 'epico' }]
  }), 1000);

  assert.equal(mudou, true);
  const linha = ctx.loot.session['chave-portal-vermelho'];
  assert.equal(linha.qty, 2);
  assert.equal(linha.bag, 2);
  assert.equal(linha.name, 'Chave do Portal Vermelho');
  assert.equal(linha.color, '#b6f');
  assert.equal(linha.key, true, 'o nome diz "chave" e isso basta');
});

test('pilha nunca vista só é registrada, não contada', () => {
  const ctx = novo();
  // Primeiro delta depois do login: a pilha já existia, o usuário não ganhou
  // 4.000 essências agora.
  const mudou = aplicar(ctx, delta({
    updated: [{ uid: '9', def_id: 'essencia-extracao', qty: 4000 }]
  }), 1000);

  assert.equal(mudou, false);
  assert.deepEqual(ctx.loot.session, {});
  assert.equal(ctx.stacks.get('9'), 4000, 'mas fica guardada para medir a próxima');

  aplicar(ctx, delta({
    updated: [{ uid: '9', def_id: 'essencia-extracao', qty: 4012 }]
  }), 2000);
  assert.equal(ctx.loot.session['essencia-extracao'].qty, 12, 'só o ganho real');
  assert.equal(ctx.loot.session['essencia-extracao'].bag, 4012);
});

test('pilha que encolhe não vira drop negativo', () => {
  const ctx = novo();
  aplicar(ctx, delta({ added: [{ uid: '9', def_id: 'essencia-extracao', qty: 50 }] }), 1000);
  aplicar(ctx, delta({
    reason: 'DELTA_REASON_SHOP',
    updated: [{ uid: '9', def_id: 'essencia-extracao', qty: 10 }]
  }), 2000);

  assert.equal(ctx.loot.session['essencia-extracao'].qty, 50, 'gastar não é cair');
});

test('equipamento não entra: afogaria a chave que cai uma vez por hora', () => {
  const ctx = novo();
  const mudou = aplicar(ctx, delta({
    added: [
      { uid: '1', def_id: 'arco-arqueiro', qty: 1 },
      { uid: '2', def_id: 'elmo-sombrio', qty: 1 }
    ]
  }), 1000);

  assert.equal(mudou, false);
  assert.deepEqual(Object.keys(ctx.loot.session), []);
  assert.equal(ctx.stacks.get('1'), 1, 'a pilha ainda é rastreada, só não é mostrada');
});

test('sem catálogo, equipamento é reconhecido pela cara da peça', () => {
  // O catálogo chega uma vez por login e os drops começam antes dele: sem uma
  // segunda opinião, o primeiro minuto da sessão é só armadura.
  const peca = extra => ({ uid: '1', def_id: 'item-desconhecido', qty: 1, ...extra });
  for (const extra of [
    { power: 318 },
    { enchant: 4 },
    { durability: 90 },
    { stats: { atk: 42, def: 0, hp: 0 } },
    { sockets: [{ gem_id: 'citrino', level: 1 }] },
    { affixes: [{ id: 'vigor', value: 3 }] },
    { equipped_slot: 'EQUIP_SLOT_PEITORAL' }
  ]) {
    const l = loot.initialLoot();
    const mudou = loot.apply(l, delta({ added: [peca(extra)] }),
      { stacks: new Map(), catalog: null, nowMs: 1000 });
    assert.equal(mudou, false, `${Object.keys(extra)[0]} só existe em equipamento`);
  }
});

test('material sem catálogo continua entrando', () => {
  const l = loot.initialLoot();
  const mudou = loot.apply(l, delta({
    // Como um empilhável chega: sem poder, sem atributo, sem encantamento.
    added: [{ uid: '1', def_id: 'chave-misteriosa', qty: 3, equipped_slot: 'EQUIP_SLOT_UNSPECIFIED' }]
  }), { stacks: new Map(), catalog: null, nowMs: 1000 });

  assert.equal(mudou, true, 'a heurística não pode custar o caso principal');
  assert.equal(l.session['chave-misteriosa'].qty, 3);
});

test('o catálogo vence a heurística quando ele classifica', () => {
  const ctx = novo();
  // Um material que por acaso traz `power`: o catálogo diz que é material.
  aplicar(ctx, delta({
    added: [{ uid: '1', def_id: 'essencia-extracao', qty: 2, power: 5 }]
  }), 1000);

  assert.equal(ctx.loot.session['essencia-extracao'].qty, 2);
});

test('material de imbuição entra: é tesouro, não equipamento', () => {
  const ctx = novo();
  aplicar(ctx, delta({ added: [{ uid: '1', def_id: 'membrana-sombria', qty: 3 }] }), 1000);
  assert.equal(ctx.loot.session['membrana-sombria'].qty, 3);
});

test('compra, venda e depósito não são drop', () => {
  for (const reason of ['SHOP', 'SELL', 'WAREHOUSE', 'EQUIP', 'FUSION', 'CONSUME']) {
    const ctx = novo();
    const mudou = aplicar(ctx, delta({
      reason: `DELTA_REASON_${reason}`,
      added: [{ uid: '1', def_id: 'essencia-extracao', qty: 10 }]
    }), 1000);
    assert.equal(mudou, false, `${reason} não pode virar linha de drop`);
  }
});

test('baú e chave de boss são drop, com o motivo no registro', () => {
  const ctx = novo();
  aplicar(ctx, delta({
    reason: 'DELTA_REASON_CHEST',
    added: [{ uid: '1', def_id: 'chave-portal-vermelho', qty: 1 }]
  }), 1000);

  assert.equal(ctx.loot.log[0].reason, 'baú');
});

test('motivo ausente é tratado como drop, porque proto3 omite o zero', () => {
  const ctx = novo();
  const sem = delta({ added: [{ uid: '1', def_id: 'essencia-extracao', qty: 5 }] });
  delete sem.reason;
  assert.equal(aplicar(ctx, sem, 1000), true);
});

test('delta do depósito ou da forja não é drop', () => {
  for (const scope of ['INVENTORY_SCOPE_WAREHOUSE', 'INVENTORY_SCOPE_FORGE']) {
    const ctx = novo();
    const mudou = aplicar(ctx, delta({
      scope,
      added: [{ uid: '1', def_id: 'essencia-extracao', qty: 10 }]
    }), 1000);
    assert.equal(mudou, false, `${scope} é movimentação, não queda`);
  }
});

test('ganhos seguidos do mesmo item fundem numa linha só', () => {
  const ctx = novo();
  aplicar(ctx, delta({ added: [{ uid: '1', def_id: 'essencia-extracao', qty: 4 }] }), 1000);
  aplicar(ctx, delta({ added: [{ uid: '2', def_id: 'essencia-extracao', qty: 6 }] }), 3000);

  assert.equal(ctx.loot.log.length, 1, 'três linhas iguais empurram o resto para fora');
  assert.equal(ctx.loot.log[0].qty, 10);
  assert.equal(ctx.loot.session['essencia-extracao'].qty, 10);

  // Passados os quinze segundos, é outro momento e vira outra linha.
  aplicar(ctx, delta({ added: [{ uid: '3', def_id: 'essencia-extracao', qty: 1 }] }), 30000);
  assert.equal(ctx.loot.log.length, 2);
});

test('item diferente nunca funde, por mais perto que caia', () => {
  const ctx = novo();
  aplicar(ctx, delta({ added: [{ uid: '1', def_id: 'essencia-extracao', qty: 4 }] }), 1000);
  aplicar(ctx, delta({ added: [{ uid: '2', def_id: 'chave-portal-vermelho', qty: 1 }] }), 1001);

  assert.equal(ctx.loot.log.length, 2);
  assert.equal(ctx.loot.log[0].defId, 'chave-portal-vermelho', 'o mais recente no topo');
});

test('o registro tem teto e descarta o mais antigo', () => {
  const ctx = novo();
  for (let i = 0; i < loot.LOG_MAX + 10; i++) {
    aplicar(ctx, delta({
      added: [{ uid: String(i), def_id: 'essencia-extracao', qty: 1 }]
    }), i * 60000);
  }
  assert.equal(ctx.loot.log.length, loot.LOG_MAX);
});

test('o acumulado tem teto, e a chave sobrevive à poda', () => {
  const ctx = novo();
  aplicar(ctx, delta({
    added: [{ uid: 'k', def_id: 'chave-portal-vermelho', qty: 1 }]
  }), 1000);

  // Enche de material comum muito depois, para a chave ser a linha mais velha.
  for (let i = 0; i < loot.SESSION_MAX + 20; i++) {
    aplicar(ctx, delta({
      added: [{ uid: `m${i}`, def_id: `material-${i}`, qty: 1 }]
    }), 2000 + i);
  }

  const ids = Object.keys(ctx.loot.session);
  assert.ok(ids.length <= loot.SESSION_MAX + 1);
  assert.ok(ids.includes('chave-portal-vermelho'),
    'a chave de uma hora atrás importa mais que o material de agora');
});

test('sem catálogo o item ainda aparece, com o id virando nome', () => {
  const l = loot.initialLoot();
  loot.apply(l, delta({
    added: [{ uid: '1', def_id: 'chave-portal-vermelho', qty: 1 }]
  }), { stacks: new Map(), catalog: null, nowMs: 1000 });

  const linha = l.session['chave-portal-vermelho'];
  assert.equal(linha.name, 'Chave Portal Vermelho', 'esperar o catálogo deixaria o painel vazio');
  assert.equal(linha.color, '');
  assert.equal(linha.key, true, 'o id basta para reconhecer uma chave');
});

test('a cor chega depois e preenche a linha já criada', () => {
  const l = loot.initialLoot();
  const stacks = new Map();
  loot.apply(l, delta({ added: [{ uid: '1', def_id: 'chave-portal-vermelho', qty: 1 }] }),
    { stacks, catalog: null, nowMs: 1000 });
  loot.apply(l, delta({ added: [{ uid: '2', def_id: 'chave-portal-vermelho', qty: 1 }] }),
    { stacks, catalog, nowMs: 2000 });

  const linha = l.session['chave-portal-vermelho'];
  assert.equal(linha.qty, 2);
  assert.equal(linha.color, '#b6f');
  assert.equal(linha.name, 'Chave do Portal Vermelho');
});

test('item removido some do rastreio, mesmo saindo por um motivo que não é drop', () => {
  const ctx = novo();
  aplicar(ctx, delta({ added: [{ uid: '1', def_id: 'essencia-extracao', qty: 10 }] }), 1000);
  aplicar(ctx, delta({ reason: 'DELTA_REASON_SELL', removed: ['1'] }), 2000);

  assert.equal(ctx.stacks.has('1'), false,
    'o servidor reaproveita uid: a pilha seguinte seria medida contra a morta');
});

test('compra atualiza o tamanho da pilha sem contar como queda', () => {
  const ctx = novo();
  aplicar(ctx, delta({ added: [{ uid: '1', def_id: 'essencia-extracao', qty: 10 }] }), 1000);
  // Auto-refill compra 90: não é drop, mas a pilha agora tem 100.
  aplicar(ctx, delta({
    reason: 'DELTA_REASON_SHOP',
    updated: [{ uid: '1', def_id: 'essencia-extracao', qty: 100 }]
  }), 2000);
  // E então cai uma de verdade.
  aplicar(ctx, delta({
    updated: [{ uid: '1', def_id: 'essencia-extracao', qty: 101 }]
  }), 3000);

  assert.equal(ctx.loot.session['essencia-extracao'].qty, 11,
    'sem registrar a compra, a queda seguinte contaria os 91 comprados junto');
});

test('caçada nova zera o acumulado e preserva o registro', () => {
  const ctx = novo();
  aplicar(ctx, delta({ added: [{ uid: '1', def_id: 'essencia-extracao', qty: 10 }] }), 1000);
  loot.resetSession(ctx.loot, 5000);

  assert.deepEqual(ctx.loot.session, {});
  assert.equal(ctx.loot.events, 0);
  assert.equal(ctx.loot.startedAtMs, 5000);
  assert.equal(ctx.loot.log.length, 1,
    'o que caiu há dois minutos ainda responde "o que caiu agora"');
});

test('pacote vazio ou malformado não quebra nem suja o estado', () => {
  const ctx = novo();
  for (const value of [null, undefined, {}, delta(), delta({ added: [{}] }), delta({ added: [{ uid: '1' }] })]) {
    assert.equal(aplicar(ctx, value, 1000), false);
  }
  assert.deepEqual(ctx.loot.session, {});
  assert.deepEqual(ctx.loot.log, []);
});

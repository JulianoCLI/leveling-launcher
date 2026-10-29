const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  defaultConfig,
  normalizeConfig,
  isConfigured,
  accountEnabled,
  readPanel,
  summarize,
  plan,
  isDone,
  pickDestination,
  availableShadows,
  FALLBACK_MINUTES,
  FALLBACK_VIP_MINUTES,
  FALLBACK_SLOTS,
  FALLBACK_VIP_SLOTS
} = require('../src/domain/leveling-expedition');

/**
 * Painel cru como o servidor manda, em snake_case e com os zeros ausentes:
 * proto3 omite o campo zero, e metade dos testes existe por causa disso.
 */
const NOW = 1700000000000;

const shadow = (uid, power, over = {}) => ({
  uid: String(uid),
  name: 'Sombra ' + uid,
  rank: 'B',
  level: 10,
  stats: { power },
  ...over
});

const candidate = (uid, power, over = {}) => ({
  shadow: shadow(uid, power, over),
  power
});

const rawPanel = (over = {}) => ({
  enabled: true,
  vip: false,
  slots: 4,
  squad_max: 3,
  durations: [60, 240, 720],
  vip_durations: [1440],
  now_ms: NOW,
  destinations: [
    { gate: 'portal-alto', difficulty: 'normal', level: 40, unlock_level: 35, unlocked: true },
    { gate: 'portal-baixo', difficulty: 'normal', level: 5, unlock_level: 1, unlocked: true },
    { gate: 'portal-travado', difficulty: 'normal', level: 1, unlock_level: 99 }
  ],
  candidates: [
    candidate(1, 100),
    candidate(2, 300),
    candidate(3, 200)
  ],
  ...over
});

// ------------------------------------------------------------- configuração

test('a configuração padrão não manda nada', () => {
  const cfg = defaultConfig();
  assert.equal(cfg.enabled, false);
  assert.equal(isConfigured(cfg), false);

  const result = plan({ panel: rawPanel(), config: cfg });
  assert.deepEqual(result.sends, []);
  assert.deepEqual(result.collect, []);
});

test('o intervalo é limitado às duas pontas', () => {
  assert.equal(normalizeConfig({ intervalMs: 1 }).intervalMs, 15000);
  assert.equal(normalizeConfig({ intervalMs: 1e9 }).intervalMs, 600000);
  assert.equal(normalizeConfig({ intervalMs: 0 }).intervalMs, 60000);
});

test('a lista de contas excluídas é limpa e ordenada', () => {
  const cfg = normalizeConfig({ disabled: [3, 1, 1, -5, 'x', 0] });
  assert.deepEqual(cfg.disabled, [0, 1, 3]);
});

test('conta participa por padrão e é excluída pela lista', () => {
  const cfg = { enabled: true, disabled: [2] };
  assert.equal(accountEnabled(cfg, 0), true);
  assert.equal(accountEnabled(cfg, 7), true);
  assert.equal(accountEnabled(cfg, 2), false);
  // Desligado no mestre nenhuma conta participa, mesmo fora da lista.
  assert.equal(accountEnabled({ enabled: false, disabled: [] }, 0), false);
});

// -------------------------------------------------------------- leitura

test('readPanel converte os campos e descarta o que não tem chave', () => {
  const p = readPanel(rawPanel());
  assert.equal(p.enabled, true);
  assert.equal(p.vip, false);
  assert.equal(p.nowMs, NOW);
  // O destino sem `gate` não existe para o planejador.
  assert.equal(p.destinations.length, 3);
  assert.equal(p.candidates.length, 3);
  assert.equal(p.candidates[0].uid, '1');
});

test('sem VIP o tempo máximo é o da lista comum; com VIP entra a lista extra', () => {
  assert.equal(readPanel(rawPanel()).maxMinutes, 720);
  assert.equal(readPanel(rawPanel({ vip: true })).maxMinutes, 1440);
});

test('painel sem lista de durações cai no chão medido do jogo', () => {
  const sem = readPanel({ enabled: true, slots: 4 });
  assert.equal(sem.maxMinutes, FALLBACK_MINUTES);
  const vip = readPanel({ enabled: true, vip: true, slots: 4 });
  assert.equal(vip.maxMinutes, FALLBACK_VIP_MINUTES);
});

test('painel sem vagas declaradas cai no chão: 4 sem VIP, 5 com VIP', () => {
  assert.equal(readPanel({ enabled: true }).capacity, FALLBACK_SLOTS);
  assert.equal(readPanel({ enabled: true, vip: true }).capacity, FALLBACK_VIP_SLOTS);
});

test('a vaga extra por nível soma ao total', () => {
  const p = readPanel(rawPanel({ slots: 4, level_extra_slot: 1 }));
  assert.equal(p.capacity, 5);
});

test('com VIP vale o maior entre slots e vip_slots', () => {
  const p = readPanel(rawPanel({ vip: true, slots: 4, vip_slots: 5 }));
  assert.equal(p.capacity, 5);
});

// --------------------------------------------------------------- escolhas

test('o destino escolhido é o de menor nível entre os liberados', () => {
  const p = readPanel(rawPanel());
  const d = pickDestination(p.destinations);
  assert.equal(d.gate, 'portal-baixo');
});

test('destino travado nunca é escolhido, mesmo sendo o mais baixo', () => {
  // `portal-travado` tem level 1 — o menor de todos — e `unlocked` ausente.
  const p = readPanel(rawPanel({
    destinations: [
      { gate: 'portal-travado', level: 1, unlock_level: 99 },
      { gate: 'portal-liberado', level: 50, unlock_level: 1, unlocked: true }
    ]
  }));
  assert.equal(pickDestination(p.destinations).gate, 'portal-liberado');
});

test('sem destino liberado não há envio', () => {
  const p = rawPanel({ destinations: [{ gate: 'x', level: 1, unlock_level: 99 }] });
  const r = plan({ panel: p, config: { enabled: true } });
  assert.deepEqual(r.sends, []);
  assert.equal(r.skipped[0].reason, 'exp.noDestination');
});

test('as sombras saem da mais forte para a mais fraca', () => {
  const p = readPanel(rawPanel());
  assert.deepEqual(availableShadows(p.candidates).map(s => s.uid), ['2', '3', '1']);
});

test('sombra do time nunca sai, mesmo sendo a mais forte', () => {
  const p = readPanel(rawPanel({
    candidates: [candidate(1, 100), candidate(9, 9999, { team_slot: 1 })]
  }));
  assert.deepEqual(availableShadows(p.candidates).map(s => s.uid), ['1']);
});

test('sombra já em expedição e sombra morta ficam de fora', () => {
  const p = readPanel(rawPanel({
    candidates: [
      candidate(1, 100),
      candidate(2, 500, { expedition: 3 }),
      candidate(3, 400, { dead: true })
    ]
  }));
  assert.deepEqual(availableShadows(p.candidates).map(s => s.uid), ['1']);
});

// --------------------------------------------------------------- conclusão

test('ready do servidor vale mais que o prazo', () => {
  assert.equal(isDone({ ready: true, endsAtMs: NOW + 1e6 }, NOW), true);
});

test('prazo vencido conta como terminada mesmo sem ready', () => {
  assert.equal(isDone({ ready: false, endsAtMs: NOW - 1 }, NOW), true);
  assert.equal(isDone({ ready: false, endsAtMs: NOW + 1 }, NOW), false);
});

test('o tempo do servidor é que vale, não o relógio do PC', () => {
  // `now_ms` do painel está atrasado em relação ao prazo: a expedição corre.
  const p = rawPanel({
    now_ms: NOW,
    active: [{ id: 1, gate: 'g', ends_at_ms: NOW + 60000 }]
  });
  const r = plan({ panel: p, config: { enabled: true } });
  assert.deepEqual(r.collect, []);
});

// ------------------------------------------------------------------- plano

test('conta vazia enche todas as vagas, uma sombra por expedição', () => {
  const p = rawPanel({ slots: 2 });
  const r = plan({ panel: p, config: { enabled: true } });

  assert.equal(r.sends.length, 2);
  // A mais forte primeiro, e nenhuma repetida.
  assert.deepEqual(r.sends.map(s => s.uids), [['2'], ['3']]);
  assert.ok(r.sends.every(s => s.uids.length === 1));
  // Destino mais baixo e tempo máximo da conta.
  assert.ok(r.sends.every(s => s.gate === 'portal-baixo'));
  assert.ok(r.sends.every(s => s.minutes === 720));
});

test('conta VIP manda 5 expedições de 24h', () => {
  const p = rawPanel({
    vip: true, slots: 5,
    candidates: [1, 2, 3, 4, 5, 6].map(i => candidate(i, i * 10))
  });
  const r = plan({ panel: p, config: { enabled: true } });
  assert.equal(r.sends.length, 5);
  assert.ok(r.sends.every(s => s.minutes === 1440));
  // Sobra a mais fraca: 6 sombras, 5 vagas, a de potência 10 fica.
  assert.deepEqual(r.sends.map(s => s.uids[0]), ['6', '5', '4', '3', '2']);
});

test('conta sem VIP manda 4 expedições de 12h', () => {
  const p = rawPanel({
    slots: 4,
    candidates: [1, 2, 3, 4, 5].map(i => candidate(i, i * 10))
  });
  const r = plan({ panel: p, config: { enabled: true } });
  assert.equal(r.sends.length, 4);
  assert.ok(r.sends.every(s => s.minutes === 720));
});

test('vaga ocupada por expedição correndo não é reutilizada', () => {
  const p = rawPanel({
    slots: 2,
    active: [{ id: 7, gate: 'g', ends_at_ms: NOW + 60000, shadows: [shadow(1, 100)] }]
  });
  const r = plan({ panel: p, config: { enabled: true } });
  assert.deepEqual(r.collect, []);
  assert.equal(r.free, 1);
  assert.equal(r.sends.length, 1);
});

test('a expedição terminada é coletada e a vaga dela é reaproveitada', () => {
  const p = rawPanel({
    slots: 2,
    active: [
      { id: 7, gate: 'g', ends_at_ms: NOW - 1, ready: true, shadows: [shadow(1, 100)] },
      { id: 8, gate: 'g', ends_at_ms: NOW + 60000, shadows: [shadow(4, 100)] }
    ]
  });
  const r = plan({ panel: p, config: { enabled: true } });
  assert.deepEqual(r.collect, [7]);
  // Uma vaga ocupada pela 8, uma liberada pela coleta da 7.
  assert.equal(r.free, 1);
  assert.equal(r.sends.length, 1);
});

test('vagas cheias e nada terminado: só não faz nada', () => {
  const p = rawPanel({
    slots: 1,
    active: [{ id: 7, gate: 'g', ends_at_ms: NOW + 60000 }]
  });
  const r = plan({ panel: p, config: { enabled: true } });
  assert.deepEqual(r.collect, []);
  assert.deepEqual(r.sends, []);
  assert.equal(r.skipped[0].reason, 'exp.full');
});

test('menos sombras que vagas manda as que há e registra a falta', () => {
  const p = rawPanel({ slots: 4, candidates: [candidate(1, 10)] });
  const r = plan({ panel: p, config: { enabled: true } });
  assert.equal(r.sends.length, 1);
  assert.equal(r.skipped.find(s => s.reason === 'exp.fewShadows').missing, 3);
});

test('armazém vazio não impede a coleta do que terminou', () => {
  const p = rawPanel({
    slots: 2,
    candidates: [],
    active: [{ id: 7, gate: 'g', ready: true, ends_at_ms: NOW - 1 }]
  });
  const r = plan({ panel: p, config: { enabled: true } });
  assert.deepEqual(r.collect, [7]);
  assert.deepEqual(r.sends, []);
  assert.equal(r.skipped.find(s => s.reason === 'exp.noShadows').reason, 'exp.noShadows');
});

test('conta sem expedição liberada no servidor é deixada em paz', () => {
  const r = plan({ panel: rawPanel({ enabled: false }), config: { enabled: true } });
  assert.deepEqual(r.sends, []);
  assert.equal(r.skipped[0].reason, 'exp.locked');
});

test('conta excluída na tela não recebe nem coleta', () => {
  const p = rawPanel({ active: [{ id: 7, gate: 'g', ready: true }] });
  const r = plan({ panel: p, config: { enabled: true, disabled: [3] }, index: 3 });
  assert.deepEqual(r.collect, []);
  assert.deepEqual(r.sends, []);
  assert.equal(r.skipped[0].reason, 'exp.accountOff');
});

test('o plano aceita painel cru ou já lido', () => {
  const cru = plan({ panel: rawPanel(), config: { enabled: true } });
  const lido = plan({ panel: readPanel(rawPanel()), config: { enabled: true } });
  assert.deepEqual(cru.sends, lido.sends);
});

// ------------------------------------------------------------------ resumo

test('o resumo conta as sombras fora e o prazo da primeira a voltar', () => {
  const s = summarize(rawPanel({
    slots: 3,
    active: [
      { id: 1, gate: 'g', ends_at_ms: NOW + 90000, shadows: [shadow(9, 1)] },
      { id: 2, gate: 'g', ends_at_ms: NOW + 30000, shadows: [shadow(8, 1)] }
    ]
  }));
  assert.equal(s.active, 2);
  assert.equal(s.shadows, 2);
  assert.equal(s.free, 1);
  // A primeira a voltar, não a última: é onde está a novidade.
  assert.equal(s.nextEndsAtMs, NOW + 30000);
  assert.equal(s.lastEndsAtMs, NOW + 90000);
  assert.equal(s.ready, 0);
  assert.equal(s.available, 3);
});

test('o resumo conta quantas já estão prontas para coletar', () => {
  const s = summarize(rawPanel({
    active: [
      { id: 1, gate: 'g', ready: true, ends_at_ms: NOW - 1 },
      { id: 2, gate: 'g', ends_at_ms: NOW + 1000 }
    ]
  }));
  assert.equal(s.ready, 1);
});

test('resumo de conta sem nada é zerado, não nulo', () => {
  const s = summarize({ enabled: true });
  assert.equal(s.active, 0);
  assert.equal(s.nextEndsAtMs, 0);
  assert.equal(s.capacity, FALLBACK_SLOTS);
});

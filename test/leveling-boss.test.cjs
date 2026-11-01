const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  defaultConfig,
  normalizeConfig,
  isConfigured,
  accountEnabled,
  readState,
  plan,
  summarize,
  eligible,
  resultTimeoutMs,
  nextLocalResetMs,
  isNewDay,
  MIN_INTERVAL_MS,
  MAX_INTERVAL_MS,
  DEFAULT_INTERVAL_MS,
  RESULT_TIMEOUT_MS,
  RESULT_GRACE_MS
} = require('../src/domain/leveling-boss');

/**
 * Estado cru como o servidor manda, em snake_case e com os zeros ausentes:
 * proto3 omite o campo zero, e boa parte destes testes existe por causa disso —
 * `done_today: false` e `min_level: 0` nunca chegam no pacote.
 */
const RESET = 1700000000000;

const rawBoss = (id, over = {}) => ({
  id,
  boss_id: 'monstro-' + id,
  rank: 1,
  min_level: 10,
  boss_level: 10,
  time_limit_secs: 60,
  ...over
});

const rawState = (over = {}) => ({
  bosses: [
    rawBoss('medio', { boss_level: 20, min_level: 20 }),
    rawBoss('facil', { boss_level: 10, min_level: 10 }),
    rawBoss('dificil', { boss_level: 30, min_level: 30 })
  ],
  reset_at_ms: RESET,
  ...over
});

const ligado = (over = {}) => normalizeConfig({ enabled: true, ...over });

// --------------------------------------------------------------- configuração

test('a configuração nasce desligada: a tentativa do dia não volta', () => {
  const cfg = defaultConfig();
  assert.equal(cfg.enabled, false);
  assert.equal(isConfigured(cfg), false);
  assert.deepEqual(cfg.disabled, []);
});

test('o intervalo é preso entre o mínimo e o máximo', () => {
  assert.equal(normalizeConfig({ intervalMs: 1 }).intervalMs, MIN_INTERVAL_MS);
  assert.equal(normalizeConfig({ intervalMs: 99999999 }).intervalMs, MAX_INTERVAL_MS);
  assert.equal(normalizeConfig({}).intervalMs, DEFAULT_INTERVAL_MS);
  assert.equal(normalizeConfig(null).intervalMs, DEFAULT_INTERVAL_MS);
});

test('a lista de exclusão é limpa, única e ordenada', () => {
  const cfg = normalizeConfig({ disabled: [3, 1, 1, -5, 'x', 0] });
  assert.deepEqual(cfg.disabled, [0, 1, 3]);
});

test('conta nova participa por padrão; só a excluída fica de fora', () => {
  const cfg = ligado({ disabled: [2] });
  assert.equal(accountEnabled(cfg, 0), true);
  // Índice que nunca foi visto: uma aba nova não pode entrar silenciosamente
  // de fora, que é o que uma lista de permissões faria.
  assert.equal(accountEnabled(cfg, 7), true);
  assert.equal(accountEnabled(cfg, 2), false);
});

test('desligado no mestre desliga todas as contas', () => {
  const cfg = normalizeConfig({ enabled: false, disabled: [] });
  assert.equal(accountEnabled(cfg, 0), false);
});

// -------------------------------------------------------------------- leitura

test('o estado cru é recortado em camelCase', () => {
  const s = readState(rawState());
  assert.equal(s.read, true);
  assert.equal(s.bosses.length, 3);
  assert.equal(s.resetAtMs, RESET);
  const facil = s.bosses.find(b => b.id === 'facil');
  assert.equal(facil.bossId, 'monstro-facil');
  assert.equal(facil.minLevel, 10);
  assert.equal(facil.timeLimitSecs, 60);
  assert.equal(facil.doneToday, false);
});

test('campos ausentes viram zero e falso, não undefined', () => {
  const s = readState({ bosses: [{ id: 'cru' }] });
  const b = s.bosses[0];
  assert.equal(b.minLevel, 0);
  assert.equal(b.bossLevel, 0);
  assert.equal(b.doneToday, false);
  assert.equal(b.bossId, '');
  assert.equal(s.resetAtMs, 0);
});

test('boss sem id é descartado: não dá para entrar nele', () => {
  const s = readState({ bosses: [{ boss_id: 'sem-id' }, rawBoss('ok')] });
  assert.deepEqual(s.bosses.map(b => b.id), ['ok']);
});

test('reler um estado já lido perde os níveis, e é por isso que existe a marca', () => {
  const uma = readState(rawState());
  const duas = readState(uma);

  // `id` tem o mesmo nome nos dois formatos, então a lista sobrevive — o que
  // se perde em silêncio são os campos de duas palavras, que no recortado já
  // estão em camelCase e não casam com `min_level`/`boss_level`. Um boss com
  // exigência 30 passaria a valer como sem exigência.
  assert.equal(duas.bosses.length, 3);
  assert.equal(duas.bosses[0].minLevel, 0);
  assert.equal(duas.bosses[0].bossLevel, 0);
  assert.equal(duas.resetAtMs, 0);

  // Daí a marca `read`: `plan` a usa para não recortar duas vezes, e com ela o
  // estado já lido produz a mesma fila do cru.
  assert.equal(uma.read, true);
  const out = plan({ state: uma, config: ligado(), level: 20 });
  assert.deepEqual(out.targets.map(t => t.id), ['facil', 'medio']);
});

test('entrada ilegível não derruba a leitura', () => {
  assert.deepEqual(readState(null).bosses, []);
  assert.deepEqual(readState('texto').bosses, []);
  assert.deepEqual(readState({ bosses: 'não é lista' }).bosses, []);
});

// -------------------------------------------------------------------- nível

test('o nível exigido corta o boss fora do alcance', () => {
  const boss = readState(rawState()).bosses.find(b => b.id === 'dificil');
  assert.equal(eligible(boss, 29), false);
  assert.equal(eligible(boss, 30), true);
  assert.equal(eligible(boss, 31), true);
});

test('exigência zero passa sempre: é ausência de exigência, não nível 0', () => {
  const [boss] = readState({ bosses: [rawBoss('livre', { min_level: 0 })] }).bosses;
  assert.equal(boss.minLevel, 0);
  assert.equal(eligible(boss, 1), true);
});

test('boss já feito hoje nunca é elegível, mesmo com nível sobrando', () => {
  const [boss] = readState({ bosses: [rawBoss('feito', { done_today: true })] }).bosses;
  assert.equal(eligible(boss, 999), false);
});

// ---------------------------------------------------------------- a fila

test('a fila sai do mais fraco para o mais forte', () => {
  const out = plan({ state: rawState(), config: ligado(), level: 99 });
  assert.deepEqual(out.targets.map(t => t.id), ['facil', 'medio', 'dificil']);
});

test('a ordem é a mesma em duas leituras seguidas', () => {
  // Dois bosses de nível idêntico: sem o desempate pelo id a fila poderia
  // trocar entre tiques, e o relatório pareceria aleatório.
  const estado = {
    bosses: [rawBoss('zz', { boss_level: 5, min_level: 5 }), rawBoss('aa', { boss_level: 5, min_level: 5 })],
    reset_at_ms: RESET
  };
  const uma = plan({ state: estado, config: ligado(), level: 99 });
  const duas = plan({ state: estado, config: ligado(), level: 99 });
  assert.deepEqual(uma.targets.map(t => t.id), ['aa', 'zz']);
  assert.deepEqual(uma.targets.map(t => t.id), duas.targets.map(t => t.id));
});

test('boss acima do nível fica de fora e diz o quanto falta', () => {
  const out = plan({ state: rawState(), config: ligado(), level: 20 });
  assert.deepEqual(out.targets.map(t => t.id), ['facil', 'medio']);
  const barrado = out.skipped.find(s => s.id === 'dificil');
  assert.equal(barrado.reason, 'boss.level');
  assert.equal(barrado.minLevel, 30);
  assert.equal(barrado.level, 20);
});

test('boss já feito hoje sai da fila e entra no relatório como feito', () => {
  const estado = rawState({
    bosses: [
      rawBoss('facil', { boss_level: 10, min_level: 10, done_today: true, my_best_ms: 12000 }),
      rawBoss('medio', { boss_level: 20, min_level: 20 })
    ]
  });
  const out = plan({ state: estado, config: ligado(), level: 99 });
  assert.deepEqual(out.targets.map(t => t.id), ['medio']);
  assert.deepEqual(out.done, [{ id: 'facil', bossId: 'monstro-facil', myBestMs: 12000 }]);
});

test('dia inteiro já feito devolve fila vazia sem erro', () => {
  const estado = rawState({
    bosses: [rawBoss('a', { done_today: true }), rawBoss('b', { done_today: true })]
  });
  const out = plan({ state: estado, config: ligado(), level: 99 });
  assert.deepEqual(out.targets, []);
  assert.equal(out.done.length, 2);
});

test('desligado e conta excluída não produzem fila', () => {
  const desligado = plan({ state: rawState(), config: normalizeConfig({}), level: 99 });
  assert.deepEqual(desligado.targets, []);
  assert.equal(desligado.skipped[0].reason, 'boss.off');

  const fora = plan({ state: rawState(), config: ligado({ disabled: [1] }), index: 1, level: 99 });
  assert.deepEqual(fora.targets, []);
  assert.equal(fora.skipped[0].reason, 'boss.accountOff');
});

test('servidor sem bosses listados é dito com nome próprio', () => {
  const out = plan({ state: { bosses: [] }, config: ligado(), level: 99 });
  assert.deepEqual(out.targets, []);
  assert.equal(out.skipped[0].reason, 'boss.noneListed');
});

test('a fila aceita estado cru ou já lido', () => {
  const cru = plan({ state: rawState(), config: ligado(), level: 99 });
  const lido = plan({ state: readState(rawState()), config: ligado(), level: 99 });
  assert.deepEqual(cru.targets.map(t => t.id), lido.targets.map(t => t.id));
});

test('cada alvo carrega o próprio teto de espera', () => {
  const out = plan({ state: rawState(), config: ligado(), level: 99 });
  // O limite é o do servidor mais a folga de saída de cena; sem limite
  // informado vale o teto fixo, porque esperar para sempre prenderia o laço.
  assert.equal(out.targets[0].timeoutMs, 60 * 1000 + RESULT_GRACE_MS);
});

test('boss sem limite de tempo informado cai no teto fixo', () => {
  const [boss] = readState({ bosses: [rawBoss('sem', { time_limit_secs: 0 })] }).bosses;
  assert.equal(resultTimeoutMs(boss), RESULT_TIMEOUT_MS);
  assert.equal(resultTimeoutMs(null), RESULT_TIMEOUT_MS);
});

// --------------------------------------------------------------- o dia

test('o dia do servidor é o que decide, não o do PC', () => {
  // Mesmo `reset_at_ms` da última rodada: o dia já foi feito.
  assert.equal(isNewDay(RESET, RESET), false);
  // Reset diferente: o servidor virou o dia.
  assert.equal(isNewDay(RESET + 86400000, RESET), true);
});

test('estado sem reset cai no lado seguro: tentar', () => {
  // Quem decide de verdade são os `done_today` dos bosses — se todos vierem
  // feitos, a fila sai vazia e nada é enviado de qualquer forma.
  assert.equal(isNewDay(0, RESET), true);
  assert.equal(isNewDay(undefined, 0), true);
});

test('primeira rodada da execução é sempre dia novo', () => {
  assert.equal(isNewDay(RESET, 0), true);
});

test('a virada local é a próxima 00:01, nunca uma já passada', () => {
  const meioDia = new Date(2024, 0, 10, 12, 0, 0, 0).getTime();
  const alvo = new Date(nextLocalResetMs(meioDia));
  assert.equal(alvo.getHours(), 0);
  assert.equal(alvo.getMinutes(), 1);
  assert.equal(alvo.getDate(), 11);
  assert.ok(alvo.getTime() > meioDia);
});

test('à 00:00 a virada é a deste dia; à 00:01 já é a do seguinte', () => {
  const antes = new Date(2024, 0, 10, 0, 0, 0, 0).getTime();
  assert.equal(new Date(nextLocalResetMs(antes)).getDate(), 10);

  // No instante exato da virada o alvo passa para amanhã, senão o despertador
  // seria reagendado para agora e dispararia em laço.
  const exato = new Date(2024, 0, 10, 0, 1, 0, 0).getTime();
  assert.equal(new Date(nextLocalResetMs(exato)).getDate(), 11);
});

test('a virada atravessa a troca de mês', () => {
  const fimDoMes = new Date(2024, 0, 31, 23, 50, 0, 0).getTime();
  const alvo = new Date(nextLocalResetMs(fimDoMes));
  assert.equal(alvo.getMonth(), 1);
  assert.equal(alvo.getDate(), 1);
});

// ------------------------------------------------------------------ resumo

test('o resumo separa feito, pendente e fora do nível', () => {
  const estado = rawState({
    bosses: [
      rawBoss('facil', { boss_level: 10, min_level: 10, done_today: true, my_best_ms: 9000 }),
      rawBoss('medio', { boss_level: 20, min_level: 20 }),
      rawBoss('dificil', { boss_level: 30, min_level: 30 })
    ]
  });
  const r = summarize(estado, { level: 25 });
  assert.equal(r.total, 3);
  assert.equal(r.done, 1);
  assert.equal(r.pending, 1, 'só o médio está ao alcance');
  assert.equal(r.blocked, 1, 'o difícil exige nível 30');
  assert.equal(r.resetAtMs, RESET);
});

test('o resumo traz linha por boss, para a tela dizer qual é qual', () => {
  const r = summarize(rawState(), { level: 20 });
  const porId = new Map(r.bosses.map(b => [b.id, b]));
  assert.equal(porId.get('facil').eligible, true);
  assert.equal(porId.get('dificil').eligible, false);
  assert.equal(porId.get('dificil').minLevel, 30);
});

test('resumo de conta sem boss é zerado, não nulo', () => {
  const r = summarize({});
  assert.equal(r.total, 0);
  assert.equal(r.done, 0);
  assert.equal(r.pending, 0);
  assert.deepEqual(r.bosses, []);
});

test('o resumo aceita estado cru ou já lido', () => {
  const cru = summarize(rawState(), { level: 99 });
  const lido = summarize(readState(rawState()), { level: 99 });
  assert.deepEqual(cru, lido);
});

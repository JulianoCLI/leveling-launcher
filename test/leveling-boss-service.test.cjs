/**
 * @file leveling-boss-service.test.cjs
 * O auto-boss contra um servidor de mentira que fala o mesmo protobuf.
 *
 * O módulo de regras tem a sua própria suíte (`leveling-boss.test.cjs`); o que
 * se prova aqui é o que só existe no serviço: a fila sai em série, o resultado
 * é lido do push, a conta volta para a caçada em que estava, e a rodada
 * acontece uma vez por dia.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { getCodec } = require('../src/domain/leveling-codec');
const { LevelingHeadlessClient } = require('../src/domain/leveling-headless-service');

const codec = getCodec();

/** Socket de mentira que fala o mesmo protobuf binário do servidor real. */
class MockWebSocket {
  constructor(url, options) {
    this.url = url;
    this.options = options;
    this.readyState = 0;
    this.sent = [];
    MockWebSocket.last = this;
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
    this.readyState = 3;
    if (this.onclose) this.onclose({ code: code || 1000 });
  }

  push(caseName, value, requestId = 0) {
    const payload = { [caseName]: value };
    if (requestId) payload.request_id = requestId;
    const buf = codec.ServerMessage.encode(codec.ServerMessage.create(payload)).finish();
    if (this.onmessage) this.onmessage({ data: Buffer.from(buf) });
  }

  /** Responde ao request pendente de um case. Cada um é respondido uma vez. */
  reply(clientCase, caseName, value) {
    const match = this.sent.find(m => m[clientCase] !== undefined && !this.replied.has(m.request_id));
    assert.ok(match, `nenhum request de ${clientCase} pendente de resposta`);
    this.replied.add(match.request_id);
    this.push(caseName, value, Number(match.request_id));
    return match;
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** A caçada em que a conta está; é ela que o `start_hunt` de volta reproduz. */
const HUNT = { gate_id: 'castelo-demonios', tier_min: 36, difficulty: 'normal' };

const RESET = 1700000000000;

const bossOn = (over = {}) => ({ enabled: true, intervalMs: 60000, disabled: [], ...over });

/** Estado como o servidor manda: snake_case, e sem os campos que valem zero. */
const stateWith = (bosses, over = {}) => ({ bosses, reset_at_ms: RESET, ...over });

const entry = (id, over = {}) => ({
  id,
  boss_id: 'monstro-' + id,
  min_level: 10,
  boss_level: 10,
  time_limit_secs: 60,
  ...over
});

function makeClient(options = {}) {
  return new LevelingHeadlessClient(0, {
    WebSocket: MockWebSocket,
    username: 'cacador',
    password: 'segredo',
    autoReconnect: false,
    requestTimeoutMs: 300,
    // Sem a pausa entre bosses: ela existe para o servidor real soltar a cena,
    // e na suíte só somaria espera a cada caso de teste.
    bossGapMs: 0,
    ...options
  });
}

const sentCount = (ws, caseName) => ws.sent.filter(m => m[caseName] !== undefined).length;

/** Espera o cliente enviar um pacote, sem prazo fixo no caso de teste. */
async function waitSent(ws, caseName, afterCount = 0) {
  for (let i = 0; i < 200; i++) {
    if (sentCount(ws, caseName) > afterCount) {
      return ws.sent.filter(m => m[caseName] !== undefined).pop();
    }
    await sleep(5);
  }
  return null;
}

/** Os `daily_boss` enviados, na ordem, já desembrulhados do envelope. */
const bossSends = ws => ws.sent.filter(m => m.daily_boss !== undefined).map(m => m.daily_boss);

/**
 * Conecta, autentica e põe a conta na caçada.
 *
 * A cena de caçada importa: é dela que sai o bilhete de volta, e sem ele não há
 * o que restaurar depois dos bosses.
 */
async function boot(client, { hunt = HUNT } = {}) {
  client.connect();
  await sleep(10);
  const ws = MockWebSocket.last;
  ws.reply('login', 'auth_ok', { token: 't', account_id: 1 });
  await sleep(5);
  ws.push('character_state', { progress: { level: 40 } });
  if (hunt) {
    ws.push('scene_enter', {
      scene_id: hunt.gate_id, kind: 2 /* SCENE_KIND_HUNT */, your_entity: 7, hunt
    });
  } else {
    ws.push('scene_enter', { scene_id: 'cidade-seul', kind: 1, your_entity: 7 });
  }
  await sleep(5);
  return ws;
}

/** Responde o `daily_boss{info}` com o estado dado. */
async function serveInfo(ws, state, afterCount = 0) {
  const pedido = await waitSent(ws, 'daily_boss', afterCount);
  assert.ok(pedido, 'o auto-boss precisa ler o estado antes de entrar');
  assert.equal(pedido.daily_boss.info, true, 'a primeira operação é a leitura');
  ws.reply('daily_boss', 'daily_boss_state', state);
  await sleep(5);
  return pedido;
}

/**
 * Faz o papel do servidor num boss: aceita o `start` e empurra o resultado.
 *
 * O resultado é um push, e não a resposta do `start`: o `start` responde o
 * estado. É por isso que o cliente abre a espera antes de enviar.
 */
async function serveBoss(ws, { victory = true, timeMs = 9000, state, afterCount, ...extra } = {}) {
  const antes = afterCount === undefined ? sentCount(ws, 'daily_boss') - 1 : afterCount;
  const pedido = await waitSent(ws, 'daily_boss', antes);
  assert.ok(pedido, 'nenhuma entrada de boss foi enviada');
  const id = pedido.daily_boss.start;
  assert.ok(id, 'a entrada tem de ser a operação start');

  ws.reply('daily_boss', 'daily_boss_state', state || stateWith([]));
  await sleep(5);
  ws.push('daily_boss_result', {
    id, boss_id: 'monstro-' + id, victory, time_ms: timeMs, ...extra
  });
  await sleep(5);
  return id;
}

/** Fecha a rodada: confirma a volta à caçada e responde ao `start_hunt`. */
async function serveReturn(ws, { hunt = HUNT } = {}) {
  const volta = await waitSent(ws, 'start_hunt');
  assert.ok(volta, 'a conta precisa voltar à caçada depois dos bosses');
  assert.deepEqual(volta.start_hunt, hunt, 'a volta é para a mesma caçada, não outra');
  ws.reply('start_hunt', 'start_hunt_result', { ...hunt, scene_id: hunt.gate_id });
  await sleep(5);
  ws.push('scene_enter', { scene_id: hunt.gate_id, kind: 2, your_entity: 7, hunt });
  await sleep(10);
  return volta;
}

// --------------------------------------------------------------- a guarda

test('desligado, nenhum pacote de boss sai', async () => {
  const client = makeClient();
  const ws = await boot(client);
  await sleep(40);

  assert.equal(sentCount(ws, 'daily_boss'), 0);
  assert.equal(client.bossTimer, null, 'nem o relógio liga');
  client.disconnect();
});

test('conta excluída na tela fica de fora', async () => {
  const client = makeClient({ bossConfig: bossOn({ disabled: [0] }) });
  const ws = await boot(client);
  await sleep(40);

  assert.equal(sentCount(ws, 'daily_boss'), 0);
  client.disconnect();
});

test('ligar pela janela não espera o próximo login', async () => {
  const client = makeClient();
  const ws = await boot(client);
  assert.equal(sentCount(ws, 'daily_boss'), 0);

  client.setBossConfig(bossOn());
  assert.ok(await waitSent(ws, 'daily_boss'), 'a configuração nova vale na hora');
  client.disconnect();
});

// -------------------------------------------------------------- a rodada

test('a rodada faz os bosses do mais fraco ao mais forte e volta à caçada', async () => {
  const client = makeClient({ bossConfig: bossOn() });
  const relatorios = [];
  client.on('boss', data => relatorios.push(data));

  const ws = await boot(client);

  await serveInfo(ws, stateWith([
    entry('medio', { boss_level: 20, min_level: 20 }),
    entry('facil', { boss_level: 10, min_level: 10 }),
    entry('dificil', { boss_level: 30, min_level: 30 })
  ]));

  // A rodada está em curso: o HUD avisa, senão a cena virar boss pareceria bug.
  assert.equal(client.state.bossRun, true);

  assert.equal(await serveBoss(ws, { timeMs: 5000 }), 'facil');
  assert.equal(await serveBoss(ws, { timeMs: 8000 }), 'medio');
  assert.equal(await serveBoss(ws, { timeMs: 11000 }), 'dificil');

  await serveReturn(ws);

  assert.equal(client.state.bossRun, false, 'e o HUD para de avisar');
  assert.equal(client.state.scene.id, 'castelo-demonios', 'a conta não fica na cidade');

  const relatorio = relatorios.pop();
  assert.equal(relatorio.attempted, 3);
  assert.equal(relatorio.victories, 3);
  assert.deepEqual(relatorio.run.results.map(r => r.id), ['facil', 'medio', 'dificil']);
  assert.ok(relatorio.run.results.every(r => r.ok));
  client.disconnect();
});

test('a ordem dos pacotes é info, cada start em série, e um start_hunt no fim', async () => {
  const client = makeClient({ bossConfig: bossOn() });
  const ws = await boot(client);

  await serveInfo(ws, stateWith([
    entry('a', { boss_level: 10 }),
    entry('b', { boss_level: 20 })
  ]));
  await serveBoss(ws);
  await serveBoss(ws);
  await serveReturn(ws);

  const ordem = ws.sent
    .map(m => {
      if (m.daily_boss) return m.daily_boss.info ? 'info' : `start:${m.daily_boss.start}`;
      if (m.start_hunt) return 'start_hunt';
      return null;
    })
    .filter(Boolean);

  // Um `start_hunt` só, e no fim: a conta volta à cidade entre dois bosses de
  // qualquer forma, e devolvê-la à caçada no meio pagaria duas trocas de cena.
  assert.deepEqual(ordem, ['info', 'start:a', 'start:b', 'start_hunt']);
  client.disconnect();
});

test('o boss perdido vira linha de falha e não é tentado de novo', async () => {
  const client = makeClient({ bossConfig: bossOn() });
  const relatorios = [];
  client.on('boss', data => relatorios.push(data));

  const ws = await boot(client);
  await serveInfo(ws, stateWith([
    entry('facil', { boss_level: 10 }),
    entry('duro', { boss_level: 20 })
  ]));

  await serveBoss(ws, { victory: true, timeMs: 4000 });
  await serveBoss(ws, { victory: false, timeMs: 60000 });
  await serveReturn(ws);

  const run = relatorios.pop().run;
  assert.deepEqual(run.results.map(r => [r.id, r.ok]), [['facil', true], ['duro', false]]);
  assert.equal(run.results[1].error, 'boss.defeat');

  // A derrota gasta a tentativa do dia: nenhuma segunda entrada no mesmo boss.
  const entradas = bossSends(ws).filter(d => d.start === 'duro');
  assert.equal(entradas.length, 1, 'perdeu, perdeu: a chance volta no reset');
  client.disconnect();
});

test('o relatório guarda tempo, recorde e posição da vitória', async () => {
  const client = makeClient({ bossConfig: bossOn() });
  const relatorios = [];
  client.on('boss', data => relatorios.push(data));

  const ws = await boot(client);
  await serveInfo(ws, stateWith([entry('unico')]));
  await serveBoss(ws, { timeMs: 7250, new_record: true, position: 3, mailed: true });
  await serveReturn(ws);

  const [resultado] = relatorios.pop().run.results;
  assert.equal(resultado.timeMs, 7250);
  assert.equal(resultado.newRecord, true);
  assert.equal(resultado.position, 3);
  assert.equal(resultado.mailed, true);
  client.disconnect();
});

test('boss acima do nível não é tentado, e o relatório diz por quê', async () => {
  const client = makeClient({ bossConfig: bossOn() });
  const relatorios = [];
  client.on('boss', data => relatorios.push(data));

  const ws = await boot(client);
  // A conta é nível 40; o segundo boss exige 90.
  await serveInfo(ws, stateWith([
    entry('possivel', { boss_level: 10, min_level: 10 }),
    entry('impossivel', { boss_level: 90, min_level: 90 })
  ]));
  await serveBoss(ws);
  await serveReturn(ws);

  assert.deepEqual(bossSends(ws).filter(d => d.start).map(d => d.start), ['possivel'],
    'tentar sem nível só gastaria a tentativa do dia');

  const run = relatorios.pop().run;
  const barrado = run.skipped.find(s => s.id === 'impossivel');
  assert.equal(barrado.reason, 'boss.level');
  assert.equal(barrado.minLevel, 90);
  client.disconnect();
});

test('boss já feito hoje sai da fila sem gastar pacote', async () => {
  const client = makeClient({ bossConfig: bossOn() });
  const ws = await boot(client);

  await serveInfo(ws, stateWith([
    entry('feito', { done_today: true, my_best_ms: 5000 }),
    entry('aberto')
  ]));
  await serveBoss(ws);
  await serveReturn(ws);

  assert.deepEqual(bossSends(ws).filter(d => d.start).map(d => d.start), ['aberto']);
  client.disconnect();
});

test('dia inteiro já feito não envia start nem start_hunt', async () => {
  const client = makeClient({ bossConfig: bossOn() });
  const relatorios = [];
  client.on('boss', data => relatorios.push(data));

  const ws = await boot(client);
  await serveInfo(ws, stateWith([
    entry('a', { done_today: true }),
    entry('b', { done_today: true })
  ]));
  await sleep(20);

  assert.equal(bossSends(ws).filter(d => d.start).length, 0);
  // Sem fila a conta nunca saiu da caçada, então não há volta a mandar: um
  // `start_hunt` aqui seria uma troca de cena por nada.
  assert.equal(sentCount(ws, 'start_hunt'), 0, 'a conta não saiu da caçada');
  assert.equal(relatorios.pop().nothingToDo, true);
  client.disconnect();
});

// -------------------------------------------------- a volta para a caçada

test('a conta volta à caçada mesmo quando o servidor recusa a entrada', async () => {
  const client = makeClient({ bossConfig: bossOn() });
  const relatorios = [];
  client.on('boss', data => relatorios.push(data));

  const ws = await boot(client);
  await serveInfo(ws, stateWith([entry('a'), entry('b', { boss_level: 20 })]));

  // Recusa na primeira entrada. Ficar na cidade seria pior que não tentar.
  await waitSent(ws, 'daily_boss', 1);
  ws.reply('daily_boss', 'error', { code: 'boss.inCombat' });
  await sleep(10);

  await serveReturn(ws);

  const run = relatorios.pop().run;
  assert.equal(run.results[0].error, 'boss.inCombat');
  // Recusa encerra a fila: o código se repetiria igual no alvo seguinte.
  assert.equal(run.results.length, 1);
  assert.equal(bossSends(ws).filter(d => d.start).length, 1);
  client.disconnect();
});

test('resultado que nunca chega não prende a rodada', async () => {
  // O teto de espera sai do `time_limit_secs` do servidor mais a folga de
  // saída de cena; um limite de 0 s deixa o caso de teste rápido.
  const client = makeClient({ bossConfig: bossOn() });
  const relatorios = [];
  client.on('boss', data => relatorios.push(data));

  const ws = await boot(client);
  await serveInfo(ws, stateWith([entry('mudo', { time_limit_secs: 0 })]));

  const pedido = await waitSent(ws, 'daily_boss', 1);
  assert.ok(pedido.daily_boss.start, 'a entrada saiu');
  ws.reply('daily_boss', 'daily_boss_state', stateWith([]));
  // E nenhum `daily_boss_result` depois disso.

  // O teto fixo é de minutos; forçar o despertar prova que a espera é por push
  // e não por prazo, sem a suíte esperar o limite real.
  await sleep(10);
  client.wake('daily_boss_result', null);
  await sleep(10);

  await serveReturn(ws);
  const run = relatorios.pop().run;
  assert.equal(run.results[0].error, 'boss.noResult');
  client.disconnect();
});

test('sem bilhete de volta a conta não é mandada para caçada nenhuma', async () => {
  // A conta entrou já na cidade: não há caçada anterior, e escolher uma por
  // conta própria é exatamente o que este monitor não faz.
  const client = makeClient({ bossConfig: bossOn() });
  const ws = await boot(client, { hunt: null });

  await serveInfo(ws, stateWith([entry('a')]));
  await serveBoss(ws);
  await sleep(20);

  assert.equal(sentCount(ws, 'start_hunt'), 0);
  assert.equal(client.state.bossRun, false, 'a rodada encerra de qualquer forma');
  client.disconnect();
});

test('a troca de caçada é recusada durante a rodada, para não ser desfeita', async () => {
  const client = makeClient({ bossConfig: bossOn() });
  const ws = await boot(client);
  await serveInfo(ws, stateWith([entry('a')]));

  // A rodada guardou o bilhete antigo e vai restaurá-lo no fim: aceitar a
  // troca agora a desfaria sem explicação.
  const res = await client.setHunt({ gate_id: 'outro-portal', tier_min: 1, difficulty: 'normal' });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'hunt.bossBusy');

  await serveBoss(ws);
  await serveReturn(ws);
  client.disconnect();
});

// ------------------------------------------------------------ uma vez ao dia

test('a rodada acontece uma vez por dia, mesmo com o relógio tocando', async () => {
  const client = makeClient({ bossConfig: bossOn({ intervalMs: 60000 }) });
  const ws = await boot(client);

  await serveInfo(ws, stateWith([entry('a')]));
  await serveBoss(ws);
  await serveReturn(ws);

  const entradasAntes = bossSends(ws).filter(d => d.start).length;

  // Segundo tique no mesmo dia: o launcher relê o estado — é a conferência de
  // segurança — mas não entra em boss nenhum, porque o `reset_at_ms` é o mesmo.
  client.bossAt = 0;
  client.maybeBoss();
  await serveInfo(ws, stateWith([entry('a', { done_today: true })]), 2);
  await sleep(20);

  assert.equal(bossSends(ws).filter(d => d.start).length, entradasAntes,
    'o dia do servidor é o que decide, não o relógio do launcher');
  client.disconnect();
});

test('reset novo do servidor libera a rodada do dia seguinte', async () => {
  const client = makeClient({ bossConfig: bossOn() });
  const ws = await boot(client);

  await serveInfo(ws, stateWith([entry('a')]));
  await serveBoss(ws);
  await serveReturn(ws);

  // O dia virou: mesmo boss, `done_today` falso e um reset diferente.
  client.bossAt = 0;
  client.maybeBoss();
  await serveInfo(ws, stateWith([entry('a')], { reset_at_ms: RESET + 86400000 }), 2);
  const segundo = await serveBoss(ws);
  assert.equal(segundo, 'a', 'o boss do novo dia é tentado de novo');
  await serveReturn(ws);
  client.disconnect();
});

test('o despertador da virada é agendado e sobrevive ao disparo', async () => {
  const client = makeClient({ bossConfig: bossOn() });
  await boot(client);

  assert.ok(client.bossResetTimer, 'sem despertador a rodada esperaria o intervalo');
  // Desligar limpa os dois relógios: um despertador sobrevivente dispararia
  // numa conta que o usuário tirou de fora.
  client.setBossConfig({ enabled: false });
  assert.equal(client.bossResetTimer, null);
  assert.equal(client.bossTimer, null);
  client.disconnect();
});

test('a queda da conexão limpa os relógios do boss', async () => {
  const client = makeClient({ bossConfig: bossOn() });
  const ws = await boot(client);
  assert.ok(client.bossTimer);

  ws.close(1006);
  await sleep(5);
  assert.equal(client.bossTimer, null);
  assert.equal(client.bossResetTimer, null);
  client.disconnect();
});

// ------------------------------------------------------------------ painel

test('o push de estado atualiza o painel sem o launcher perguntar', async () => {
  const client = makeClient();
  const ws = await boot(client);

  // O servidor reemite o estado quando algo muda nele — inclusive um boss que
  // o usuário fez à mão na WebView.
  ws.push('daily_boss_state', stateWith([
    entry('a', { done_today: true }),
    entry('b'),
    entry('c', { min_level: 90, boss_level: 90 })
  ]));
  await sleep(5);

  assert.equal(client.state.boss.total, 3);
  assert.equal(client.state.boss.done, 1);
  assert.equal(client.state.boss.pending, 1);
  assert.equal(client.state.boss.blocked, 1, 'a conta é nível 40 e o terceiro exige 90');
  assert.equal(client.state.boss.resetAtMs, RESET);
  client.disconnect();
});

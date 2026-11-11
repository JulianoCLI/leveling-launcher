const { test } = require('node:test');
const assert = require('node:assert/strict');
const limiter = require('../src/domain/leveling-rate-limiter');

const sleep = ms => new Promise(r => setTimeout(r, ms));

test('rajada maior que o orçamento drena todos os resolvers, sem órfãos', async () => {
  // O bug: `processQueue` parava por falta de token sem reagendar nada, e todo
  // `wait` enfileirado ficava pendurado para sempre — o monitor travava inteiro.
  const rl = limiter.create({ tokensPerSecond: 20 });

  const total = 60;
  const resolvidos = [];
  const esperas = [];
  for (let i = 0; i < total; i++) {
    esperas.push(rl.wait('normal').then(() => resolvidos.push(i)));
  }

  await Promise.all(esperas);
  assert.equal(resolvidos.length, total, 'nenhum resolver pode ficar órfão');
  assert.equal(rl.status().waitingCount, 0, 'a fila esvazia');
});

test('a fila é FIFO: quem chegou primeiro sai primeiro', async () => {
  const rl = limiter.create({ tokensPerSecond: 10 });

  const ordem = [];
  const esperas = [];
  for (let i = 0; i < 30; i++) {
    esperas.push(rl.wait('normal').then(() => ordem.push(i)));
  }

  await Promise.all(esperas);
  assert.deepEqual(ordem, Array.from({ length: 30 }, (_, i) => i),
    'ninguém com token na mão pode furar a fila de quem já esperava');
});

test('quem chega com a fila cheia não se auto-serve', async () => {
  // Starvation: com a fila não vazia, resolver na frente dela deixava os
  // primeiros esperando indefinidamente enquanto os novos passavam.
  const rl = limiter.create({ tokensPerSecond: 10 });

  const ordem = [];
  // Esgota o orçamento inicial e enfileira dois.
  for (let i = 0; i < 10; i++) await rl.wait('normal');
  const primeiro = rl.wait('normal').then(() => ordem.push('primeiro'));
  const segundo = rl.wait('normal').then(() => ordem.push('segundo'));

  // Tempo para um token nascer, e só então um recém-chegado pede vez.
  await sleep(150);
  const tardio = rl.wait('normal').then(() => ordem.push('tardio'));

  await Promise.all([primeiro, segundo, tardio]);
  assert.deepEqual(ordem, ['primeiro', 'segundo', 'tardio']);
});

test('só existe um timer de drenagem, não um por chamada', async () => {
  // Um timer por chamada multiplicava o trabalho sem adiantar nada: o relógio
  // do bucket é global.
  const rl = limiter.create({ tokensPerSecond: 50 });
  let pendentes = 0;
  let maximo = 0;
  const original = global.setTimeout;
  global.setTimeout = (fn, ms) => {
    pendentes += 1;
    if (pendentes > maximo) maximo = pendentes;
    return original(() => { pendentes -= 1; fn(); }, ms);
  };
  try {
    const esperas = [];
    for (let i = 0; i < 200; i++) esperas.push(rl.wait('normal'));
    await Promise.all(esperas);
  } finally {
    global.setTimeout = original;
  }

  // Duzentas chamadas de uma vez; um timer por chamada daria 150 pendentes
  // ao mesmo tempo. A drenagem é sequencial, então nunca passa de um.
  assert.equal(maximo, 1, `timers simultâneos demais: ${maximo}`);
  assert.equal(pendentes, 0, 'nada fica pendurado no fim');
});

test('o sniper é isento e não entra na fila', async () => {
  const rl = limiter.create({ tokensPerSecond: 1 });
  await rl.wait('normal'); // consome o único token

  const antes = Date.now();
  for (let i = 0; i < 50; i++) await rl.wait('sniper');
  assert.ok(Date.now() - antes < 200, 'o sniper não paga o orçamento global');
  assert.equal(rl.status().waitingCount, 0);
});

test('a isenção do sniper pode ser desligada', async () => {
  const rl = limiter.create({ tokensPerSecond: 5, sniperExempt: false });
  assert.equal(rl.status().sniperExempt, false);

  const esperas = [];
  for (let i = 0; i < 12; i++) esperas.push(rl.wait('sniper'));
  await Promise.all(esperas);
  assert.equal(rl.status().waitingCount, 0, 'sem isenção, o sniper também drena pela fila');
});

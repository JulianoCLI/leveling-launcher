const test = require('node:test');
const assert = require('node:assert/strict');
const pace = require('../src/domain/leveling-pace');

test('jitter: aplicar desvio ±pct', () => {
  const vals = [];
  for (let i = 0; i < 100; i++) {
    vals.push(pace.jitter(1000, 0.3, Math.random));
  }
  const avg = vals.reduce((a, b) => a + b) / vals.length;
  assert(avg > 800 && avg < 1200, `média ${avg} fora da faixa ~1000±300`);
  assert(Math.min(...vals) > 600, 'mínimo abaixo de 600');
  assert(Math.max(...vals) < 1400, 'máximo acima de 1400');
});

test('jitter: pct=0 retorna valor exato', () => {
  assert.equal(pace.jitter(1000, 0), 1000);
  assert.equal(pace.jitter(500, 0.01), 500); // arredondamento pode deixar pequeno desvio
});

test('jitter: com random determinístico', () => {
  const r1 = pace.jitter(1000, 0.5, () => 0);   // mínimo
  const r2 = pace.jitter(1000, 0.5, () => 0.5); // centro
  const r3 = pace.jitter(1000, 0.5, () => 1);   // máximo
  assert.equal(r1, 500);  // 1000 * (1 - 0.5 * 1) = 500
  assert.equal(r2, 1000); // 1000 * (1 + 0) = 1000
  assert.equal(r3, 1500); // 1000 * (1 + 0.5 * 1) = 1500
});

test('phase: sorteio dentro da janela', () => {
  const vals = [];
  for (let i = 0; i < 100; i++) {
    vals.push(pace.phase(1000, Math.random));
  }
  assert(Math.min(...vals) >= 0, 'mínimo não é 0 ou acima');
  assert(Math.max(...vals) < 1000, 'máximo >= janela');
  assert(vals.some(v => v > 400 && v < 600), 'não há valores no meio');
});

test('phase: com random determinístico', () => {
  assert.equal(pace.phase(1000, () => 0), 0);
  assert.equal(pace.phase(1000, () => 0.5), 500);
  assert.equal(pace.phase(1000, () => 1), 999); // Math.floor(1 * 1000) = 999
});

test('gap: retorna Promise', async () => {
  const start = Date.now();
  await pace.gap(100, 200, () => 0.5);
  const elapsed = Date.now() - start;
  assert(elapsed >= 140 && elapsed < 250, `elapsed ${elapsed} fora de ~150±10`);
});

test('gap: minMs=0 retorna imediatamente', async () => {
  const start = Date.now();
  await pace.gap(0, 0);
  const elapsed = Date.now() - start;
  assert(elapsed < 50, `gap(0,0) levou ${elapsed}ms`);
});

test('every: chama função periodicamente com jitter', async () => {
  const calls = [];
  let counter = 0;
  const ticker = pace.every(() => { calls.push(++counter); }, 50, {
    pct: 0.2,
    unref: true
  });
  await new Promise(resolve => setTimeout(resolve, 350));
  ticker.off();
  assert(calls.length >= 4 && calls.length <= 8, `${calls.length} chamadas fora da faixa`);
  assert.deepEqual(calls, [1, 2, 3, 4, 5, 6].slice(0, calls.length));
});

test('every: off() para o laço', async () => {
  const calls = [];
  const ticker = pace.every(() => { calls.push(1); }, 50);
  await new Promise(resolve => setTimeout(resolve, 100));
  ticker.off();
  const countBefore = calls.length;
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(calls.length, countBefore, 'continuou chamando após off()');
});

test('every: aguarda função async', async () => {
  const calls = [];
  const ticker = pace.every(async () => {
    calls.push(1);
    await new Promise(resolve => setTimeout(resolve, 30));
  }, 50);
  await new Promise(resolve => setTimeout(resolve, 200));
  ticker.off();
  assert(calls.length >= 1, 'nunca foi chamada');
});

test('every: ignora erros na função', async () => {
  const calls = [];
  const ticker = pace.every(() => {
    calls.push(1);
    if (calls.length === 2) throw new Error('erro intencional');
  }, 30);
  await new Promise(resolve => setTimeout(resolve, 150));
  ticker.off();
  assert(calls.length >= 3, `parou após erro: ${calls.length}`);
});

test('stagger: espalha paralelamente', async () => {
  const times = [];
  const start = Date.now();
  await pace.stagger([1, 2, 3], async (n) => {
    times.push(Date.now() - start);
  }, 100);
  times.sort();
  assert(times[0] < 30, `primeiro disparou após ${times[0]}ms`);
  assert(times[times.length - 1] > 70, `último disparou após ${times[times.length - 1]}ms`);
});

test('stagger: retorna resultados em ordem', async () => {
  const results = await pace.stagger(
    [10, 20, 30],
    async (n) => n * 2,
    50
  );
  assert.deepEqual(results, [20, 40, 60]);
});

test('stagger: windowMs=0 dispara tudo junto', async () => {
  const times = [];
  const start = Date.now();
  await pace.stagger([1, 2, 3], async () => {
    times.push(Date.now() - start);
  }, 0);
  const spread = Math.max(...times) - Math.min(...times);
  assert(spread < 20, `spread ${spread}ms com windowMs=0`);
});

test('sleep: aguarda o tempo', async () => {
  const start = Date.now();
  await pace.sleep(100);
  const elapsed = Date.now() - start;
  assert(elapsed >= 90 && elapsed < 150, `sleep(100) levou ${elapsed}ms`);
});

test('sleep: 0ms retorna imediatamente', async () => {
  const start = Date.now();
  await pace.sleep(0);
  const elapsed = Date.now() - start;
  assert(elapsed < 20, `sleep(0) levou ${elapsed}ms`);
});

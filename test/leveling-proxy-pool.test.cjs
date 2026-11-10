/**
 * @file leveling-proxy-pool.test.cjs
 * Testes para o pool de proxies.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { LevelingProxyPool, CAPACITY_PER_PROXY } = require('../src/domain/leveling-proxy-pool.js');

test('proxy-pool: import adiciona proxies', async () => {
  const pool = new LevelingProxyPool();
  const result = pool.importText('127.0.0.1:8080\nlocalhost:3128\n');
  assert.equal(result.added.length, 2);
  assert.equal(result.invalid.length, 0);
  assert.equal(pool.proxies.length, 2);
});

test('proxy-pool: import ignora linhas vazias e comentários', async () => {
  const pool = new LevelingProxyPool();
  const result = pool.importText(`
    127.0.0.1:8080
    # comentário
    
    localhost:3128
  `);
  assert.equal(result.added.length, 2);
  assert.equal(pool.proxies.length, 2);
});

test('proxy-pool: import deduplica por URL normalizada', async () => {
  const pool = new LevelingProxyPool();
  const result = pool.importText('127.0.0.1:8080\nhttp://127.0.0.1:8080\n127.0.0.1:8080');
  assert.equal(result.added.length, 1, 'deve adicionar apenas uma vez');
  assert.equal(result.duplicates.length, 2, 'deve reportar 2 duplicatas');
  assert.equal(pool.proxies.length, 1);
});

test('proxy-pool: import com credenciais', async () => {
  const pool = new LevelingProxyPool();
  const result = pool.importText('127.0.0.1:8080:user:pass\nsocks5://other:9999');
  assert.equal(result.added.length, 2);
  assert.equal(pool.proxies.length, 2);
  assert.ok(pool.proxies[0].url.includes('user'));
  assert.ok(pool.proxies[1].url.startsWith('socks5://'));
});

test('proxy-pool: assign atribui conta ao proxy com vaga', async () => {
  const pool = new LevelingProxyPool();
  pool.importText('127.0.0.1:8080\nlocalhost:3128');
  pool.proxies[0].status = 'ok';
  pool.proxies[1].status = 'ok';

  const res1 = pool.assign(0);
  assert.ok(res1);
  assert.equal(res1.proxyId, pool.proxies[0].id);

  const res2 = pool.assign(1);
  assert.ok(res2);
  assert.equal(res2.proxyId, pool.proxies[0].id, 'segunda conta usa mesmo proxy (vaga)');

  const res3 = pool.assign(2);
  assert.ok(res3);
  assert.equal(res3.proxyId, pool.proxies[1].id, 'terceira conta vai para o segundo proxy');

  const res4 = pool.assign(3);
  assert.ok(res3);
  assert.equal(res4.proxyId, pool.proxies[1].id);

  const res5 = pool.assign(4);
  assert.equal(res5, null, 'pool esgotado, retorna null');
});

test('proxy-pool: assign ignora proxies com status não-ok', async () => {
  const pool = new LevelingProxyPool();
  pool.importText('127.0.0.1:8080\nlocalhost:3128');
  pool.proxies[0].status = 'fail';
  pool.proxies[1].status = 'ok';

  const res = pool.assign(0);
  assert.ok(res);
  assert.equal(res.proxyId, pool.proxies[1].id, 'deve pular o proxy com status fail');
});

test('proxy-pool: proxy nunca testado não é atribuído', async () => {
  // `pending` significa "ninguém verificou". Tratá-lo como bom era o furo que
  // fazia a conta sair pelo IP da máquina achando que tinha rota.
  const pool = new LevelingProxyPool();
  pool.importText('127.0.0.1:8080\nlocalhost:3128');
  assert.equal(pool.proxies[0].status, 'pending', 'importar não testa nada');

  assert.equal(pool.assign(0), null, 'sem teste, sem atribuição');

  pool.proxies[1].status = 'ok';
  const res = pool.assign(0);
  assert.ok(res);
  assert.equal(res.proxyId, pool.proxies[1].id, 'só o aprovado serve');
});

test('proxy-pool: as duas primeiras contas podem sair pelo IP da máquina', async () => {
  // O IP local comporta o mesmo que um proxy: o servidor recusa a terceira
  // conta no mesmo endereço, não a segunda.
  const pool = new LevelingProxyPool();

  assert.equal(pool.canOpen(0).ok, true);
  assert.equal(pool.canOpen(1).ok, true);

  const terceira = pool.canOpen(2);
  assert.equal(terceira.ok, false, 'a terceira conta exige proxy');
  assert.match(terceira.motivo, /sem proxy funcional/);
});

test('proxy-pool: com proxy aprovado qualquer conta abre', async () => {
  const pool = new LevelingProxyPool();
  pool.importText('127.0.0.1:8080');
  pool.proxies[0].status = 'ok';
  pool.assign(9);

  assert.equal(pool.canOpen(9).ok, true, 'a rota é o que libera, não o índice');
});

test('proxy-pool: proxy reprovado fecha a conta que o usava', async () => {
  // Um proxy que passou a falhar não pode continuar liberando a conta: ela
  // sairia por uma rota morta, ou pior, pelo IP local.
  const pool = new LevelingProxyPool();
  pool.importText('127.0.0.1:8080');
  pool.proxies[0].status = 'ok';
  pool.assign(5);

  pool.setProxyStatus(pool.proxies[0].id, 'fail', '', 'timeout');

  const porta = pool.canOpen(5);
  assert.equal(porta.ok, false);
  assert.match(porta.motivo, /não passou no teste/);
});

test('proxy-pool: describeRoute diz por onde a conta sai', async () => {
  const pool = new LevelingProxyPool();
  pool.importText('127.0.0.1:8080');
  pool.proxies[0].status = 'ok';
  pool.proxies[0].ip = '203.0.113.7';
  pool.assign(3);

  const comProxy = pool.describeRoute(3);
  assert.equal(comProxy.kind, 'proxy');
  assert.equal(comProxy.ip, '203.0.113.7', 'o IP é o que o servidor vê');
  assert.equal(comProxy.ok, true);

  // Conta 0 sem proxy: sai pelo IP da máquina, e isso é legítimo.
  const local = pool.describeRoute(0);
  assert.equal(local.kind, 'local');
  assert.equal(local.ok, true);

  // Conta 7 sem proxy: não tem rota nenhuma.
  const nenhuma = pool.describeRoute(7);
  assert.equal(nenhuma.kind, 'none');
  assert.equal(nenhuma.ok, false);
});

test('proxy-pool: reconcile dá rota a quem existia antes do pool', async () => {
  /*
   * O caso real: vinte proxies aprovados, quarenta vagas livres, e as contas 3
   * e 4 bloqueadas porque `assign` só era chamado no cadastro assistido.
   */
  const pool = new LevelingProxyPool();
  pool.importText('10.0.0.1:8080\n10.0.0.2:8080');
  pool.proxies.forEach(p => { p.status = 'ok'; });

  const r = pool.reconcile([0, 1, 2, 3]);

  // As duas primeiras saem pelo IP da máquina: gastar proxy nelas seria
  // desperdiçar vaga.
  assert.deepEqual(r.assigned, [2, 3]);
  assert.deepEqual(r.unassigned, []);
  assert.equal(pool.canOpen(2).ok, true);
  assert.equal(pool.canOpen(3).ok, true);
  assert.equal(pool.assignments.has(0), false, 'a conta 1 não consome proxy');
});

test('proxy-pool: reconcile é idempotente e não rouba rota atribuída', async () => {
  const pool = new LevelingProxyPool();
  pool.importText('10.0.0.1:8080');
  pool.proxies[0].status = 'ok';

  const primeira = pool.reconcile([2, 3]);
  assert.deepEqual(primeira.assigned, [2, 3]);
  const antes = JSON.stringify([...pool.assignments]);

  // Rodar de novo (boot, import, teste de proxy) não pode remexer em nada.
  const segunda = pool.reconcile([2, 3]);
  assert.deepEqual(segunda.assigned, [], 'conta com rota é ignorada');
  assert.equal(JSON.stringify([...pool.assignments]), antes);
});

test('proxy-pool: reconcile relata quem ficou sem proxy', async () => {
  // Capacidade esgotada tem de aparecer, não virar conta calada que não abre.
  const pool = new LevelingProxyPool();
  pool.importText('10.0.0.1:8080');
  pool.proxies[0].status = 'ok';

  const r = pool.reconcile([2, 3, 4]);
  assert.deepEqual(r.assigned, [2, 3], 'duas contas por proxy');
  assert.deepEqual(r.unassigned, [4]);
  assert.equal(pool.canOpen(4).ok, false);
});

test('proxy-pool: reconcile não atribui proxy nunca testado', async () => {
  const pool = new LevelingProxyPool();
  pool.importText('10.0.0.1:8080');

  const r = pool.reconcile([2]);
  assert.deepEqual(r.assigned, []);
  assert.deepEqual(r.unassigned, [2], 'pending não é rota');
});

test('proxy-pool: release desatribui uma conta', async () => {
  const pool = new LevelingProxyPool();
  pool.importText('127.0.0.1:8080');
  pool.proxies[0].status = 'ok';

  const res1 = pool.assign(0);
  assert.ok(res1);
  pool.release(0);

  const res2 = pool.assign(1);
  assert.ok(res2);
  assert.equal(res2.proxyId, res1.proxyId, 'vaga foi liberada');
});

test('proxy-pool: remove deleta proxy e desatribui contas', async () => {
  const pool = new LevelingProxyPool();
  pool.importText('127.0.0.1:8080\nlocalhost:3128\n192.168.1.1:9090');
  pool.proxies[0].status = 'ok';
  pool.proxies[1].status = 'ok';
  pool.proxies[2].status = 'ok';

  pool.assign(0);  // vai para proxy 0
  pool.assign(1);  // vai para proxy 0 (ainda há vaga)
  pool.assign(2);  // vai para proxy 1
  assert.equal(pool.assignments.size, 3);

  const proxyId = pool.proxies[0].id;
  pool.remove(proxyId);

  assert.equal(pool.proxies.length, 2);
  assert.equal(pool.assignments.size, 1, 'duas contas foram desatribuídas, uma continua');
  assert.equal(pool.assignments.get(2), pool.proxies[0].id, 'conta 2 segue no proxy antigo 1, agora primeiro');
});

test('proxy-pool: setProxyStatus atualiza status', async () => {
  const pool = new LevelingProxyPool();
  pool.importText('127.0.0.1:8080');
  const proxyId = pool.proxies[0].id;

  pool.setProxyStatus(proxyId, 'ok', '203.0.113.1', '');
  assert.equal(pool.proxies[0].status, 'ok');
  assert.equal(pool.proxies[0].ip, '203.0.113.1');
  assert.equal(pool.proxies[0].error, '');
  assert.ok(pool.proxies[0].checkedAt > 0);
});

test('proxy-pool: setProxyStatus detecta IPs duplicados', async () => {
  const pool = new LevelingProxyPool();
  pool.importText('127.0.0.1:8080\nlocalhost:3128');
  pool.proxies[0].status = 'ok';
  pool.proxies[1].status = 'ok';

  // Primeiro retorna IP ok
  pool.setProxyStatus(pool.proxies[0].id, 'ok', '203.0.113.1', '');
  assert.equal(pool.proxies[0].status, 'ok');

  // Segundo retorna o mesmo IP
  pool.setProxyStatus(pool.proxies[1].id, 'ok', '203.0.113.1', '');
  assert.equal(pool.proxies[0].status, 'duplicate');
  assert.equal(pool.proxies[1].status, 'duplicate');
});

test('proxy-pool: freeSlots calcula vagas', async () => {
  const pool = new LevelingProxyPool();
  pool.importText('127.0.0.1:8080\nlocalhost:3128');
  pool.proxies[0].status = 'ok';
  pool.proxies[1].status = 'ok';

  assert.equal(pool.freeSlots(), 4, '2 proxies = 4 vagas');

  pool.assign(0);
  assert.equal(pool.freeSlots(), 3);

  pool.assign(1);
  pool.assign(2);
  assert.equal(pool.freeSlots(), 1);
});

test('proxy-pool: capacity retorna totais', async () => {
  const pool = new LevelingProxyPool();
  pool.importText('127.0.0.1:8080\nlocalhost:3128');
  pool.proxies[0].status = 'ok';
  pool.proxies[1].status = 'ok';

  const cap = pool.capacity();
  assert.equal(cap.total, 4);
  assert.equal(cap.used, 0);
  assert.equal(cap.free, 4);

  pool.assign(0);
  pool.assign(1);
  const cap2 = pool.capacity();
  assert.equal(cap2.used, 2);
  assert.equal(cap2.free, 2);
});

test('proxy-pool: needed calcula proxies para N contas', async () => {
  const pool = new LevelingProxyPool();
  assert.equal(pool.needed(1), 1);
  assert.equal(pool.needed(2), 1);
  assert.equal(pool.needed(3), 2);
  assert.equal(pool.needed(4), 2);
  assert.equal(pool.needed(5), 3);
});

test('proxy-pool: toJSON e fromJSON preservam estado', async () => {
  const pool = new LevelingProxyPool();
  pool.importText('127.0.0.1:8080\nlocalhost:3128');
  pool.proxies[0].status = 'ok';
  pool.proxies[1].status = 'ok';
  pool.proxies[0].ip = '203.0.113.1';

  pool.assign(0);
  pool.assign(1);

  const json = pool.toJSON();
  const pool2 = LevelingProxyPool.fromJSON(json);

  assert.equal(pool2.proxies.length, 2);
  assert.equal(pool2.proxies[0].ip, '203.0.113.1');
  assert.equal(pool2.assignments.size, 2);
});

'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { SignupQueue } = require('../src/domain/leveling-signup-queue.js');

/**
 * Harness: `abrir` registra a ordem das aberturas e deixa o teste decidir o
 * resultado de cada conta, que é como o `canOpen` do pool se comporta.
 */
function montar(resultados = {}) {
  const abertas = [];
  const progresso = [];
  const fila = new SignupQueue({
    abrir: index => {
      abertas.push(index);
      return resultados[index] || { ok: true };
    },
    progresso: estado => progresso.push(estado)
  });
  return { fila, abertas, progresso };
}

test('fila: com três contas só abre uma janela por vez', () => {
  const { fila, abertas } = montar();

  fila.enfileirar([{ index: 0 }, { index: 1 }, { index: 2 }]);

  assert.deepStrictEqual(abertas, [0], 'só a cabeça da fila abre');
  assert.strictEqual(fila.atual, 0);
});

test('fila: post-done abre a seguinte', () => {
  const { fila, abertas } = montar();
  fila.enfileirar([{ index: 0 }, { index: 1 }, { index: 2 }]);

  fila.avancar(0);
  assert.deepStrictEqual(abertas, [0, 1]);

  fila.avancar(1);
  assert.deepStrictEqual(abertas, [0, 1, 2]);

  fila.avancar(2);
  assert.strictEqual(fila.ativo, false, 'a fila termina parada');
});

test('fila: o closed logo após o post-done não consome duas contas', () => {
  const { fila, abertas } = montar();
  fila.enfileirar([{ index: 0 }, { index: 1 }, { index: 2 }]);

  // `post-done` fecha a janela, e o `closed` chega atrás com o mesmo índice.
  fila.avancar(0);
  fila.avancar(0);

  assert.deepStrictEqual(abertas, [0, 1], 'a conta 2 não é pulada');
  assert.strictEqual(fila.atual, 1);
});

test('fila: fechar a janela na mão também avança', () => {
  const { fila, abertas } = montar();
  fila.enfileirar([{ index: 0 }, { index: 1 }]);

  // Sem este caminho, abortar o cadastro (ou estourar o teto de 180 s)
  // deixaria a fila parada para sempre.
  fila.avancar(0);

  assert.deepStrictEqual(abertas, [0, 1]);
});

test('fila: conta recusada pelo pool não trava as demais', () => {
  const { fila, abertas, progresso } = montar({
    1: { ok: false, error: 'sem proxy funcional no pool' }
  });

  fila.enfileirar([{ index: 0 }, { index: 1 }, { index: 2 }]);
  fila.avancar(0);

  assert.deepStrictEqual(abertas, [0, 1, 2], 'pula a recusada e segue');
  assert.strictEqual(fila.atual, 2);

  const erro = progresso.find(p => p.estado === 'erro');
  assert.strictEqual(erro.index, 1);
  assert.match(erro.error, /sem proxy/);
});

test('fila: todas recusadas termina sem ficar presa', () => {
  const { fila, progresso } = montar({
    0: { ok: false, error: 'x' },
    1: { ok: false, error: 'y' }
  });

  fila.enfileirar([{ index: 0 }, { index: 1 }]);

  assert.strictEqual(fila.ativo, false);
  const fim = progresso.find(p => p.estado === 'fim');
  assert.strictEqual(fim.erros.length, 2);
});

test('fila: o progresso narra posição e total', () => {
  const { fila, progresso } = montar();
  fila.enfileirar([{ index: 3 }, { index: 4 }]);

  const primeiro = progresso[0];
  assert.deepStrictEqual(
    { index: primeiro.index, posicao: primeiro.posicao, total: primeiro.total },
    { index: 3, posicao: 1, total: 2 }
  );

  fila.avancar(3);
  const segundo = progresso.find(p => p.index === 4 && p.estado === 'abrindo');
  assert.strictEqual(segundo.posicao, 2);
});

test('fila: um cadastro em andamento não é interrompido por um plano novo', () => {
  const { fila, abertas } = montar();
  fila.enfileirar([{ index: 0 }]);

  fila.enfileirar([{ index: 5 }]);

  assert.deepStrictEqual(abertas, [0], 'a conta nova espera a vez');
  fila.avancar(0);
  assert.deepStrictEqual(abertas, [0, 5]);
});

test('fila: avancar com índice alheio é ignorado', () => {
  const { fila, abertas } = montar();
  fila.enfileirar([{ index: 0 }, { index: 1 }]);

  assert.strictEqual(fila.avancar(7), false);
  assert.deepStrictEqual(abertas, [0], 'ninguém avança fora da vez');
});

test('fila: lista vazia não abre nada', () => {
  const { fila, abertas } = montar();

  assert.strictEqual(fila.enfileirar([]), false);
  assert.strictEqual(fila.ativo, false);
  assert.deepStrictEqual(abertas, []);
});

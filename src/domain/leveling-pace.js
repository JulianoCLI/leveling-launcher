'use strict';

/**
 * Ferramentas para distribuir requisições de forma menos detectável como bot.
 *
 * O padrão é o mesmo que `leveling-cambio.js` usa para o hop: jitter injetável,
 * testável, reproduzível com `random` determinístico.
 *
 * Sem dependências externas. Tudo é combinável com Promises.
 */

/**
 * Desvio de ±pct aplicado a ms. Ex: jitter(1000, 0.3) → ~700-1300.
 *
 * @param {number} ms - base em milissegundos
 * @param {number} pct - desvio percentual (0.2 = ±20%)
 * @param {function} rand - Math.random() ou injeção de teste
 * @returns {number} ms com desvio aplicado
 */
function jitter(ms, pct = 0, rand = Math.random) {
  if (!Number.isFinite(ms)) return 0;
  if (pct <= 0) return Math.round(ms);
  const fator = 1 + (rand() * 2 - 1) * pct;
  return Math.round(ms * fator);
}

/**
 * Deslocamento inicial aleatório para quebrar a sincronização entre laços.
 *
 * Retorna um número sorteado entre 0 e baseMs, para usar como atraso inicial
 * antes do primeiro disparo de um laço. Cada laço que chamar `phase()` dentro
 * do mesmo `ms` sorteia um valor independente, espalhando os inícios.
 *
 * @param {number} baseMs - janela de dispersão
 * @param {function} rand - Math.random() ou injeção de teste
 * @returns {number} atraso inicial em ms
 */
function phase(baseMs, rand = Math.random) {
  if (!Number.isFinite(baseMs) || baseMs <= 0) return 0;
  return Math.floor(rand() * baseMs);
}

/**
 * Pausa curta sorteada, para espaçar operações em série.
 *
 * @param {number} minMs - limite inferior
 * @param {number} maxMs - limite superior
 * @param {function} rand - Math.random() ou injeção de teste
 * @returns {Promise} resolida após o atraso
 */
function gap(minMs = 0, maxMs = 0, rand = Math.random) {
  if (minMs <= 0 && maxMs <= 0) return Promise.resolve();
  const min = Math.max(0, Math.round(minMs));
  const max = Math.round(maxMs);
  if (max < min) return Promise.resolve();
  const ms = min + Math.floor(rand() * (max - min + 1));
  return sleep(ms);
}

/**
 * Timer recursivo com reagendamento sorteado: substitui setInterval.
 *
 * `setInterval` é periódico por construção — nenhum jitter conserta de dentro.
 * Só o reagendamento a cada volta quebra a periodicidade.
 *
 * Função chamada num instante sorteado baseado em `baseMs ±pct` a cada vez.
 * O primeiro disparo sai após um atraso sorteado; os seguintes após cada
 * execução da função.
 *
 * Nunca lança, nunca para: qualquer erro na função é silenciosamente ignorado,
 * porque o laço é de automação em background. Chamador pode fazer `off()` ou
 * deixar o processo morrer.
 *
 * @param {function} fn - função a chamar (async é ok)
 * @param {number} baseMs - intervalo base em ms
 * @param {object} opts - { pct: 0-1, rand, unref }
 * @returns {object} { off: () => void } para parar o laço
 *
 * Exemplo:
 *   const ticker = pace.every(() => console.log('tick'), 10000, { pct: 0.3 })
 *   // depois de um tempo
 *   ticker.off()
 */
function every(fn, baseMs = 0, opts = {}) {
  if (typeof fn !== 'function' || !Number.isFinite(baseMs) || baseMs <= 0) {
    return { off: () => {} };
  }

  const pct = typeof opts.pct === 'number' ? opts.pct : 0;
  const rand = typeof opts.rand === 'function' ? opts.rand : Math.random;
  const shouldUnref = opts.unref !== false;

  let timer = null;
  let stopped = false;

  const schedule = (delayMs) => {
    if (stopped) return;
    const actualMs = jitter(delayMs, pct, rand);
    timer = setTimeout(run, actualMs);
    if (shouldUnref && timer.unref) timer.unref();
  };

  const run = async () => {
    if (stopped) return;
    try {
      await fn();
    } catch {
      // silenciosamente ignorado: laço de automação em background
    }
    if (!stopped) schedule(baseMs);
  };

  // Primeiro disparo sorteado
  const initialDelay = phase(baseMs, rand);
  schedule(initialDelay);

  return {
    off: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    }
  };
}

/**
 * Fan-out com espaçamento: mantém paralelismo mas não dispara tudo junto.
 *
 * Para cada item da lista, chama `fn(item)` com um atraso sorteado dentro da
 * janela. As chamadas são paralelas (não esperam umas pelas outras), mas os
 * inícios são espalhados.
 *
 * @param {array} items - lista de itens para processar
 * @param {function} fn - async (item) => resultado. Chamada para cada um.
 * @param {number} windowMs - janela de dispersão em ms
 * @param {function} rand - Math.random() ou injeção de teste
 * @returns {Promise} Promise.all dos resultados
 *
 * Exemplo:
 *   await pace.stagger([1,2,3], async (n) => await api.fetch(n), 5000)
 *   // os três disparam entre 0 e 5 s, em paralelo
 */
async function stagger(items, fn, windowMs = 0, rand = Math.random) {
  if (!Array.isArray(items) || typeof fn !== 'function') return [];
  if (items.length === 0) return [];
  if (windowMs <= 0) {
    // Sem janela: dispara tudo de uma vez
    return Promise.all(items.map(fn));
  }

  const results = [];
  const promises = items.map((item, i) => {
    const delayMs = Math.floor(rand() * (windowMs + 1));
    return sleep(delayMs)
      .then(() => fn(item))
      .then(result => {
        results[i] = result;
        return result;
      })
      .catch(() => {
        // Erro silencioso: a fila continua
        return undefined;
      });
  });

  await Promise.all(promises);
  return results;
}

/**
 * Pausa por tempo determinado, sem prender o processo.
 *
 * Uso interno de `gap`, `stagger` e `every`. Mantém `unref()` para que um
 * `setTimeout` aqui não impeça o processo de sair.
 */
function sleep(ms) {
  return new Promise(resolve => {
    if (ms <= 0) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, Math.round(ms));
    if (timer.unref) timer.unref();
  });
}

module.exports = {
  jitter,
  phase,
  gap,
  every,
  stagger,
  sleep
};

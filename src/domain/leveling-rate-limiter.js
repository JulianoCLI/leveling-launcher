'use strict';

/**
 * Limitador de tráfego com token bucket, para evitar rajadas.
 *
 * Mantém um orçamento de requisições por segundo. Quem estoura o orçamento
 * espera; nunca falha. Isso protege contra rajadas de qualquer origem.
 *
 * Suporta duas classes:
 * - `normal`: sujeita ao orçamento global.
 * - `sniper`: isenta do orçamento, para preservar o comportamento atual do sniper.
 */

/**
 * Cria um limitador com orçamento por segundo.
 *
 * @param {object} opts - { tokensPerSecond, sniperExempt }
 * @returns {object} { wait: async (class) => void, status: () => object }
 *
 * Exemplo:
 *   const limiter = rateLimiter({ tokensPerSecond: 10 });
 *   await limiter.wait('normal'); // aguarda se necessário
 */
function create(opts = {}) {
  const tokensPerSecond = Math.max(1, Number(opts.tokensPerSecond) || 20);
  const sniperExempt = opts.sniperExempt !== false;

  let tokensAvailable = tokensPerSecond;
  let lastRefillMs = Date.now();
  let waitingQueue = [];

  const refill = () => {
    const now = Date.now();
    const elapsedMs = Math.max(0, now - lastRefillMs);
    const elapsedSec = elapsedMs / 1000;
    const tokensGenerated = elapsedSec * tokensPerSecond;
    tokensAvailable = Math.min(tokensPerSecond, tokensAvailable + tokensGenerated);
    lastRefillMs = now;
  };

  const processQueue = () => {
    while (waitingQueue.length > 0) {
      refill();
      if (tokensAvailable >= 1) {
        const resolve = waitingQueue.shift();
        tokensAvailable -= 1;
        resolve();
      } else {
        break;
      }
    }
  };

  const wait = (classname = 'normal') => {
    // Sniper é isento se a opção estiver ligada
    if (sniperExempt && classname === 'sniper') {
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      refill();
      if (tokensAvailable >= 1) {
        tokensAvailable -= 1;
        resolve();
      } else {
        waitingQueue.push(resolve);
        // Agendar processamento quando o próximo token estiver pronto
        const timeUntilNextToken = (1 / tokensPerSecond) * 1000;
        const timer = setTimeout(() => {
          processQueue();
        }, timeUntilNextToken);
        if (timer.unref) timer.unref();
      }
    });
  };

  const status = () => ({
    tokensPerSecond,
    tokensAvailable: Math.round(tokensAvailable * 100) / 100,
    waitingCount: waitingQueue.length,
    sniperExempt
  });

  return { wait, status };
}

module.exports = { create };

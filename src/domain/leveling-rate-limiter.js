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

  // Um único timer de drenagem por vez. Um timer por chamada multiplicaria o
  // trabalho sem adiantar nada: o relógio do bucket é global.
  let drainTimer = null;

  /**
   * Garante que exista um timer pendente para a próxima drenagem. Sem isto a
   * fila ficava órfã para sempre: `processQueue` parava por falta de token e
   * ninguém a acordava de novo, e todo `wait` enfileirado nunca resolvia.
   */
  const scheduleDrain = () => {
    if (drainTimer || waitingQueue.length === 0) return;
    // Quanto falta para o próximo token inteiro, nunca menos de 1 ms: um
    // timeout de 0 viraria laço quente sem o relógio ter avançado.
    const faltam = Math.max(1, Math.ceil(((1 - tokensAvailable) / tokensPerSecond) * 1000));
    drainTimer = setTimeout(() => {
      drainTimer = null;
      processQueue();
    }, faltam);
    if (drainTimer.unref) drainTimer.unref();
  };

  const processQueue = () => {
    while (waitingQueue.length > 0) {
      refill();
      if (tokensAvailable >= 1) {
        const resolve = waitingQueue.shift();
        tokensAvailable -= 1;
        resolve();
      } else {
        // Ainda tem gente na fila e não tem token: reagendar, senão estes
        // resolvers ficam pendurados até o processo morrer.
        scheduleDrain();
        return;
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
      // Só se auto-serve com a fila vazia. Com alguém esperando, furar a fila
      // seria starvation: quem chegou primeiro nunca sairia da frente.
      if (waitingQueue.length === 0 && tokensAvailable >= 1) {
        tokensAvailable -= 1;
        resolve();
        return;
      }
      waitingQueue.push(resolve);
      scheduleDrain();
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

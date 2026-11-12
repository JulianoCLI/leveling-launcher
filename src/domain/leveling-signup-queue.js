/**
 * @file leveling-signup-queue.js
 * Fila do cadastro assistido: uma janela de cadastro por vez.
 *
 * Abrir as N janelas de uma vez só era o comportamento antigo, e ele não
 * funciona na prática: cada cadastro pede um captcha resolvido à mão, e com
 * várias janelas em cascata o usuário resolve o desafio de uma enquanto as
 * outras expiram o Turnstile e queimam o nome. Sequencial, o desafio que está
 * na frente é sempre o único que importa.
 *
 * A lógica vive aqui, fora do Electron, porque o `main` só sabe *quando*
 * avançar (`post-done` e `closed`) — *como* avançar é decisão de domínio, e
 * assim ela é testável sem abrir janela nenhuma.
 */

'use strict';

/**
 * `abrir(index)` deve devolver `{ ok }` como `openSignupTab`, e `progresso`
 * recebe o estado para o renderer narrar ("cadastrando conta X de N").
 */
class SignupQueue {
  constructor({ abrir, progresso } = {}) {
    this.abrir = typeof abrir === 'function' ? abrir : () => ({ ok: false, error: 'sem abridor' });
    this.progresso = typeof progresso === 'function' ? progresso : () => {};
    this.pendentes = [];
    this.total = 0;
    this.feitos = 0;
    /** Índice da conta com janela aberta, ou `null` quando a fila está parada. */
    this.atual = null;
    this.erros = [];
  }

  get ativo() {
    return this.atual !== null;
  }

  /**
   * Enfileira o plano salvo e abre só a cabeça.
   *
   * Se já houver um cadastro em andamento, as contas novas entram no fim: o
   * captcha que o usuário está resolvendo não pode ser interrompido.
   */
  enfileirar(lista) {
    const indices = (Array.isArray(lista) ? lista : [])
      .map(s => (s && typeof s === 'object' ? s.index : s))
      .map(i => Number(i))
      .filter(i => Number.isInteger(i) && i >= 0);

    if (!indices.length) return false;

    this.pendentes.push(...indices);
    this.total += indices.length;
    if (!this.ativo) this.#proxima();
    return true;
  }

  /**
   * Um cadastro terminou (ou a janela dele fechou): segue para o próximo.
   *
   * O `index` é conferido porque `post-done` fecha a janela e o `closed` vem
   * logo atrás — sem o guard, um cadastro só consumiria duas contas da fila.
   */
  avancar(index) {
    if (this.atual === null || this.atual !== Number(index)) return false;
    this.atual = null;
    this.#proxima();
    return true;
  }

  /** Desiste do resto. Usado quando o plano é cancelado. */
  limpar() {
    this.pendentes = [];
    this.atual = null;
    this.total = 0;
    this.feitos = 0;
    this.erros = [];
  }

  /*
   * Laço, não recursão: uma conta recusada pelo pool (`canOpen`) não deve
   * parar a fila, e com `{ok:false}` em sequência a recursão empilharia um
   * quadro por conta reprovada.
   */
  #proxima() {
    while (this.pendentes.length) {
      const index = this.pendentes.shift();
      this.feitos++;
      this.atual = index;
      this.progresso({
        index,
        posicao: this.feitos,
        total: this.total,
        estado: 'abrindo'
      });

      let r;
      try {
        r = this.abrir(index);
      } catch (e) {
        r = { ok: false, error: e.message };
      }

      if (r && r.ok === false) {
        // Registra e segue: travar aqui deixaria as contas boas sem cadastro
        // por causa de uma que nem janela conseguiu abrir.
        const erro = { index, error: (r && r.error) || 'erro' };
        this.erros.push(erro);
        this.atual = null;
        this.progresso({ ...erro, posicao: this.feitos, total: this.total, estado: 'erro' });
        continue;
      }

      return;
    }

    this.atual = null;
    this.progresso({
      index: -1,
      posicao: this.total,
      total: this.total,
      estado: 'fim',
      erros: this.erros.slice()
    });
    this.total = 0;
    this.feitos = 0;
    this.erros = [];
  }
}

module.exports = { SignupQueue };

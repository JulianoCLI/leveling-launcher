/**
 * @file leveling-boss-ui.js
 * Tela do auto-boss diário: uma linha por conta, e o relatório do que saiu.
 *
 * A pergunta que esta tela responde é "quais bosses foram feitos com sucesso
 * hoje e quais não", e por isso o relatório é tão importante quanto a contagem:
 * um "3 de 5" sem dizer *quais* três obriga o usuário a abrir o jogo.
 *
 * A contagem até a virada do dia é feita aqui, de segundo em segundo, em vez de
 * esperar o próximo evento do processo principal: o laço lá roda de dez em dez
 * minutos, e um relógio que anda de dez em dez minutos parece travado.
 *
 * Como na expedição, a contagem usa o desvio entre o relógio do servidor e o do
 * PC — aqui medido pelo `reset_at_ms`, que é o horário que o servidor vai
 * cobrar. Sem isso um PC com a hora adiantada mostraria "o dia já virou"
 * enquanto o servidor ainda recusa os bosses de hoje.
 *
 * Nada aqui valida de verdade: `leveling-boss.js` normaliza o que receber.
 */

(() => {
  'use strict';

  const escape = s => String(s === undefined || s === null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

  /**
   * Duração em palavras curtas, para a espera até a virada. "7h 20min" responde
   * a pergunta; abaixo de um minuto os segundos aparecem, porque aí eles são a
   * informação: a rodada está a caminho.
   */
  const duracao = ms => {
    const total = Math.max(0, Math.floor(Number(ms) || 0) / 1000);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = Math.floor(total % 60);
    if (h) return `${h}h ${String(m).padStart(2, '0')}min`;
    if (m) return `${m}min ${String(s).padStart(2, '0')}s`;
    return `${s}s`;
  };

  /** Hora do dia, para o prazo absoluto ao lado da contagem. */
  const relogio = ms => {
    const n = Number(ms);
    if (!n) return '';
    const d = new Date(n);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  };

  /**
   * Tempo de luta, que o servidor manda em milissegundos.
   *
   * Aqui o segundo importa: o ranking do boss é por tempo, e a diferença entre
   * duas tentativas da mesma conta costuma ser de segundos.
   */
  const tempoLuta = ms => {
    const n = Math.max(0, Math.floor(Number(ms) || 0));
    if (!n) return '';
    const s = Math.floor(n / 1000);
    return s >= 60 ? `${Math.floor(s / 60)}min ${String(s % 60).padStart(2, '0')}s` : `${s}s`;
  };

  /** Recusas do servidor e do launcher, em português. O código fica no `title`. */
  const ERROS = {
    'boss.off': 'o auto-boss está desligado',
    'boss.accountOff': 'esta conta está de fora',
    'boss.noneListed': 'o servidor não listou nenhum boss diário',
    'boss.level': 'nível insuficiente para este boss',
    'boss.defeat': 'a conta não venceu',
    'boss.noResult': 'o servidor não respondeu dentro do limite de tempo',
    'boss.failed': 'o servidor recusou sem dizer o motivo',
    'boss.restoreOffline': 'a conexão caiu antes de voltar para a caçada',
    'boss.doneToday': 'já tinha sido feito hoje',
    'boss.notFound': 'este boss não existe mais',
    'boss.inCombat': 'a conta estava em combate',
    'hunt.failed': 'não foi possível voltar para a caçada'
  };

  const PioBoss = {
    api: null,
    config: { enabled: false, intervalMs: 600000, disabled: [] },
    accounts: [],
    limits: { minIntervalMs: 60000, maxIntervalMs: 3600000 },
    /**
     * Desvio entre o relógio do servidor e o do PC, em milissegundos.
     *
     * Medido pelo `reset_at_ms` contra a virada local calculada na mesma
     * leitura. É o que faz a contagem desta tela bater com o horário que o
     * servidor vai cobrar, e não com o que o PC acha que é meia-noite.
     */
    skewMs: 0,
    /** Bosses feitos e falhados nesta sessão, por conta. */
    log: [],
    tickTimer: null,
    busy: false,

    async init(api) {
      this.api = api || window.pokeAPI;
      if (!this.api || !this.api.bossGet) return;

      if (this.api.onBoss) {
        // O laço roda no processo principal, inclusive com esta janela em
        // segundo plano: a tela acompanha sem perguntar.
        this.api.onBoss(data => this.report(data));
      }

      await this.load();
      this.wire();
      this.startTick();
    },

    async load(force) {
      const res = await this.api.bossGet(force ? { force: true } : undefined)
        .catch(() => null);
      if (!res) {
        this.say('Não foi possível ler o estado dos bosses.', true);
        return;
      }
      this.apply(res);
      this.render();
    },

    apply(res) {
      if (res.config) this.config = res.config;
      if (res.accounts) this.accounts = res.accounts;
      if (res.limits) this.limits = res.limits;
      this.measureSkew();
    },

    /**
     * Mede o desvio de relógio pela conta mais recente que trouxe `resetAtMs`.
     *
     * Uma conta basta: o servidor é o mesmo para todas, e a diferença entre
     * elas é só a latência da leitura.
     *
     * O desvio sai da comparação entre o reset do servidor e a virada local da
     * mesma data. Os dois deveriam ser o mesmo instante; a diferença é o fuso
     * ou a hora errada do PC, e é exatamente o que a contagem precisa somar.
     */
    measureSkew() {
      for (const conta of this.accounts) {
        const reset = conta.summary && Number(conta.summary.resetAtMs);
        const local = conta.stats && Number(conta.stats.nextLocalResetMs);
        if (reset && local) {
          this.skewMs = reset - local;
          return;
        }
      }
    },

    /** "Agora" segundo o servidor. É contra isto que a virada é medida. */
    agora() {
      return Date.now() + this.skewMs;
    },

    // ------------------------------------------------------------ desenho

    render() {
      this.renderControls();
      this.renderAccounts();
      this.renderLog();
    },

    renderControls() {
      const host = document.getElementById('bossControls');
      if (!host) return;

      const minutos = Math.round((this.config.intervalMs || 600000) / 60000);
      const min = Math.round((this.limits.minIntervalMs || 60000) / 60000);
      const max = Math.round((this.limits.maxIntervalMs || 3600000) / 60000);

      host.innerHTML = `
        <label class="xp-master">
          <input type="checkbox" id="bossEnabled" ${this.config.enabled ? 'checked' : ''}>
          <span>Ligar o auto-boss diário</span>
        </label>
        <label class="xp-interval"
          title="A rodada acontece na virada do dia. Este intervalo é só a conferência de segurança, para o caso de o PC estar suspenso na hora do reset.">
          <span>Conferir a cada</span>
          <input type="number" id="bossInterval" min="${min}" max="${max}" step="1"
            value="${minutos}">
          <span>min</span>
        </label>`;
    },

    renderAccounts() {
      const host = document.getElementById('bossAccounts');
      if (!host) return;

      if (!this.accounts.length) {
        host.innerHTML = '<p class="hint">Nenhuma conta configurada.</p>';
        return;
      }

      const linhas = this.accounts.map(conta => this.accountHtml(conta)).join('');
      host.innerHTML = `
        <table class="xp-table">
          <thead>
            <tr>
              <th class="xp-th-on">Ligada</th>
              <th>Conta</th>
              <th>Feitos hoje</th>
              <th>Faltam</th>
              <th>Fora do nível</th>
              <th>Bosses</th>
              <th>Vira em</th>
            </tr>
          </thead>
          <tbody>${linhas}</tbody>
        </table>`;
    },

    accountHtml(conta) {
      const nome = conta.name || conta.username || `Conta ${conta.index + 1}`;
      const s = conta.summary;

      // Conta sem monitor não é conta sem bosses: dizer "0 feitos" seria
      // afirmar algo que o launcher não sabe.
      const detalhe = !conta.connected
        ? '<td colspan="5" class="xp-off">monitor desligado</td>'
        : conta.errorCode
          ? `<td colspan="5" class="xp-err" title="${escape(conta.errorCode)}">${escape(ERROS[conta.errorCode] || conta.errorCode)}</td>`
          : !s
            ? '<td colspan="5" class="xp-off">lendo…</td>'
            : !s.total
              ? '<td colspan="5" class="xp-off">nenhum boss diário nesta conta</td>'
              : `
                <td class="xp-num ${s.done === s.total ? 'is-ready' : ''}">${s.done} / ${s.total}</td>
                <td class="xp-num">${s.pending || '—'}</td>
                <td class="xp-num" ${s.blocked ? `title="exigem nível acima do ${conta.level || '?'} desta conta"` : ''}>${s.blocked || '—'}</td>
                <td class="xp-bosses">${this.bossesHtml(s)}</td>
                <td class="xp-next" data-ends="${s.resetAtMs || 0}">${this.resetText(s)}</td>`;

      return `
        <tr data-index="${conta.index}">
          <td class="xp-th-on">
            <input type="checkbox" data-account="${conta.index}"
              ${conta.enabled ? 'checked' : ''}
              title="Desmarcar deixa esta conta de fora do auto-boss">
          </td>
          <td class="xp-name">
            <span class="xp-dot ${conta.connected ? 'is-on' : ''}"></span>
            ${escape(nome)}${conta.level ? ` <span class="xp-at">nv ${conta.level}</span>` : ''}
          </td>
          ${detalhe}
        </tr>`;
    },

    /**
     * Uma marca por boss: feito, pendente ou fora do nível.
     *
     * Marcas em vez de uma lista de nomes porque a pergunta na linha da conta é
     * "quantos e quais sobraram", e cinco nomes de boss por linha em oito
     * contas não cabem. O nome fica no `title` de cada marca, e o relatório
     * abaixo diz o resto.
     */
    bossesHtml(summary) {
      if (!summary || !summary.bosses || !summary.bosses.length) return '—';
      return summary.bosses.map(b => {
        const classe = b.doneToday ? 'is-done' : (b.eligible ? 'is-pending' : 'is-blocked');
        const estado = b.doneToday
          ? `feito${b.myBestMs ? ` em ${tempoLuta(b.myBestMs)}` : ''}`
          : (b.eligible ? 'ainda falta' : `exige nível ${b.minLevel}`);
        const nome = b.bossId || b.id;
        return `<span class="xp-boss ${classe}" title="${escape(`${nome} · ${estado}`)}">${escape(nome.slice(0, 2).toUpperCase())}</span>`;
      }).join('');
    },

    /** Texto da coluna da virada. Recalculado a cada segundo pelo tique. */
    resetText(summary) {
      const reset = summary && Number(summary.resetAtMs);
      if (!reset) return '—';
      const falta = reset - this.agora();
      if (falta <= 0) return '<b class="is-ready">virando…</b>';
      return `${duracao(falta)} <span class="xp-at">(${relogio(reset)})</span>`;
    },

    /**
     * Só a coluna da virada, de segundo em segundo.
     *
     * Repintar a tabela inteira a 1 Hz desmarcaria a caixinha que o usuário
     * acabou de clicar e perderia o foco do campo de intervalo.
     */
    tick() {
      for (const celula of document.querySelectorAll('.xp-next')) {
        const fim = Number(celula.dataset.ends) || 0;
        if (!fim) continue;
        const falta = fim - this.agora();
        celula.innerHTML = falta <= 0
          ? '<b class="is-ready">virando…</b>'
          : `${duracao(falta)} <span class="xp-at">(${relogio(fim)})</span>`;
      }
    },

    startTick() {
      clearInterval(this.tickTimer);
      this.tickTimer = setInterval(() => this.tick(), 1000);
    },

    renderLog() {
      const host = document.getElementById('bossLog');
      if (!host) return;
      if (!this.log.length) {
        host.innerHTML = '<p class="hint">Nenhuma rodada de boss nesta sessão ainda.</p>';
        return;
      }
      host.innerHTML = this.log.map(linha => `
        <div class="xp-line ${linha.error ? 'is-err' : ''}">
          <span class="xp-time">${relogio(linha.atMs)}</span>
          <span class="xp-line-acc">Conta ${linha.index + 1}</span>
          <span class="xp-line-text">${linha.html}</span>
        </div>`).join('');
    },

    // ------------------------------------------------------------ eventos

    wire() {
      const host = document.getElementById('bossControls');
      if (host) {
        host.onchange = e => {
          if (e.target.id === 'bossEnabled' || e.target.id === 'bossInterval') this.save();
        };
      }

      const accounts = document.getElementById('bossAccounts');
      if (accounts) {
        // Delegado: a tabela é redesenhada a cada leitura, e um ouvinte por
        // caixinha morreria junto com ela.
        accounts.onchange = e => {
          if (e.target.dataset && e.target.dataset.account !== undefined) this.save();
        };
      }

      const poll = document.getElementById('bossPoll');
      if (poll) poll.onclick = () => this.poll(false);

      const force = document.getElementById('bossForce');
      if (force) force.onclick = () => this.poll(true);
    },

    /**
     * Lê a tela. Números crus de propósito: o domínio normaliza, e a lista de
     * contas desligadas é derivada das caixinhas desmarcadas — nunca de uma
     * lista de permissões, para que uma conta nova participe por padrão.
     */
    collect() {
      const enabled = document.getElementById('bossEnabled');
      const interval = document.getElementById('bossInterval');
      const disabled = [];
      for (const caixa of document.querySelectorAll('[data-account]')) {
        if (!caixa.checked) disabled.push(Number(caixa.dataset.account));
      }
      return {
        enabled: !!(enabled && enabled.checked),
        intervalMs: (Number(interval && interval.value) || 10) * 60000,
        disabled
      };
    },

    async save() {
      if (this.busy) return;
      this.busy = true;
      const res = await this.api.bossSet(this.collect())
        .catch(e => ({ error: e.message }));
      this.busy = false;

      if (!res || res.error) {
        this.say('Falha ao salvar: ' + ((res && res.error) || 'desconhecida'), true);
        return;
      }

      this.apply(res);
      this.render();

      const fora = this.config.disabled.length;
      this.say(this.config.enabled
        ? `Salvo. Ligado${fora ? `, ${fora} conta${fora === 1 ? '' : 's'} de fora` : ' em todas as contas'}.`
        : 'Salvo. O auto-boss está desligado.');
    },

    async poll(force) {
      const botoes = [document.getElementById('bossPoll'), document.getElementById('bossForce')];
      for (const b of botoes) if (b) b.disabled = true;
      this.say(force ? 'Tentando o que falta…' : 'Verificando as contas…');

      const res = await this.api.bossPoll(force ? { force: true } : undefined)
        .catch(e => ({ error: e.message }));
      for (const b of botoes) if (b) b.disabled = false;

      if (!res || res.error) {
        this.say('Falha ao verificar: ' + ((res && res.error) || 'desconhecida'), true);
        return;
      }
      this.apply(res);
      this.render();
      this.say('Verificado.');
    },

    /**
     * Uma rodada de boss terminou numa conta.
     *
     * O resumo vem no evento, então a linha daquela conta é atualizada sem
     * outra travessia de IPC.
     */
    report(data) {
      if (!data) return;

      const conta = this.accounts.find(a => a.index === data.index);
      if (conta && data.summary) {
        conta.summary = data.summary;
        conta.errorCode = data.error || '';
      }
      if (conta && data.stats) conta.stats = data.stats;
      this.measureSkew();

      const linha = this.runHtml(data);
      if (linha) {
        this.log.unshift({
          index: data.index,
          atMs: Date.now(),
          error: !!data.error || linha.failed > 0,
          html: linha.html
        });
        // Teto: o log é de memória, e a automação roda por dias.
        if (this.log.length > 200) this.log.length = 200;
      }

      this.renderAccounts();
      this.renderLog();
    },

    /**
     * O relatório de uma rodada, em uma linha.
     *
     * É o coração do pedido: cada boss aparece com o nome e com o veredito, e a
     * cor separa o que saiu do que não saiu. Uma contagem "3 de 5" sozinha
     * obrigaria a abrir o jogo para descobrir *quais* três.
     */
    runHtml(data) {
      if (data.error && !data.run) {
        return {
          failed: 1,
          html: `<span class="xp-boss-fail">${escape(ERROS[data.error] || data.error)}</span>`
        };
      }

      const run = data.run;
      if (!run) return null;

      const partes = [];
      let failed = 0;

      for (const r of (run.results || [])) {
        const nome = escape(r.bossId || r.id);
        if (r.ok) {
          const extra = [
            tempoLuta(r.timeMs),
            r.newRecord ? 'recorde' : '',
            r.position ? `#${r.position}` : ''
          ].filter(Boolean).join(' · ');
          partes.push(`<span class="xp-boss-ok">✔ ${nome}${extra ? ` <span class="xp-at">(${escape(extra)})</span>` : ''}</span>`);
        } else {
          failed++;
          const motivo = ERROS[r.error] || r.error || 'não saiu';
          partes.push(`<span class="xp-boss-fail" title="${escape(r.error || '')}">✖ ${nome} <span class="xp-at">(${escape(motivo)})</span></span>`);
        }
      }

      // Bosses que já estavam feitos e os barrados por nível entram como um
      // resumo, não boss por boss: eles não são resultado da rodada, e listar
      // cinco nomes repetidos todo dia esconderia o que de fato aconteceu.
      const jaFeitos = (run.done || []).length;
      if (jaFeitos) partes.push(`<span class="xp-at">${jaFeitos} já estava${jaFeitos === 1 ? '' : 'm'} feito${jaFeitos === 1 ? '' : 's'}</span>`);

      const porNivel = (run.skipped || []).filter(s => s.reason === 'boss.level');
      if (porNivel.length) {
        const niveis = porNivel.map(s => s.minLevel).filter(Boolean).sort((a, b) => a - b);
        partes.push(`<span class="xp-at" title="${escape(`exigem nível ${niveis.join(', ')}`)}">${porNivel.length} fora do nível</span>`);
      }

      if (!partes.length) return null;
      return { failed, html: partes.join(' ') };
    },

    say(text, isError) {
      const bar = document.getElementById('bossStatusBar');
      if (!bar) return;
      bar.textContent = text;
      bar.classList.toggle('is-error', !!isError);
    }
  };

  if (typeof window !== 'undefined') window.PioBoss = PioBoss;
  if (typeof module !== 'undefined' && module.exports) module.exports = PioBoss;
})();

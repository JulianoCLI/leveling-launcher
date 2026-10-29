/**
 * @file leveling-expedition-ui.js
 * Tela da auto-expedição: uma linha por conta, com o relógio de volta.
 *
 * A pergunta que esta tela responde é "quando alguma conta volta a ter sombra
 * livre", e por isso o prazo é contado aqui, de segundo em segundo, em vez de
 * esperar o próximo evento do processo principal: o laço lá roda de minuto em
 * minuto, e um relógio que anda de minuto em minuto parece travado.
 *
 * A contagem usa o desvio entre o relógio do servidor e o do PC, medido quando
 * o painel chega (`nowMs` contra `Date.now()`). Sem isso, um PC com a hora
 * adiantada mostraria "pronta" numa expedição que ainda corre — e o usuário
 * acharia que a automação parou de coletar.
 *
 * Nada aqui valida de verdade: `leveling-expedition.js` normaliza o que
 * receber.
 */

(() => {
  'use strict';

  const escape = s => String(s === undefined || s === null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

  /**
   * Duração em palavras curtas. "11h 58min" responde a pergunta; "11:58:03"
   * obriga a fazer a conta, e o segundo não muda nenhuma decisão num prazo de
   * horas. Abaixo de um minuto os segundos aparecem, porque aí eles são a
   * informação: a coleta está a caminho.
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

  const horas = minutos => {
    const m = Math.floor(Number(minutos) || 0);
    if (!m) return '—';
    return m % 60 ? `${Math.floor(m / 60)}h${m % 60}` : `${m / 60}h`;
  };

  /** Recusas do servidor e do launcher, em português. O código fica no `title`. */
  const ERROS = {
    'exp.locked': 'a conta ainda não liberou expedições',
    'exp.full': 'todas as vagas estão ocupadas',
    'exp.noShadows': 'nenhuma sombra livre no armazém',
    'exp.noDestination': 'nenhum destino liberado',
    'exp.fewShadows': 'faltam sombras para encher as vagas',
    'exp.badUid': 'o identificador da sombra veio ilegível',
    'exp.failed': 'o servidor recusou sem dizer o motivo',
    'exp.accountOff': 'esta conta está de fora',
    'expedition.cooldown': 'o servidor pediu para esperar',
    'expedition.locked': 'expedição não liberada nesta conta',
    'expedition.slots': 'sem vaga livre no servidor',
    'expedition.busy': 'a sombra já estava em expedição'
  };

  /** O que cada resultado de expedição significa. */
  const RESULTADOS = {
    OUTCOME_SUCCESS: 'sucesso',
    OUTCOME_FOUND: 'achou algo',
    OUTCOME_FAILED: 'falhou'
  };

  const PioExpedition = {
    api: null,
    config: { enabled: false, intervalMs: 60000, disabled: [] },
    accounts: [],
    limits: { minIntervalMs: 15000, maxIntervalMs: 600000 },
    /**
     * Desvio entre o relógio do servidor e o do PC, em milissegundos.
     *
     * `nowMs` do painel menos `Date.now()` na hora em que ele chegou. É o que
     * faz a contagem desta tela bater com o prazo que o servidor vai cobrar.
     */
    skewMs: 0,
    /** Últimas coletas e envios, para a tela mostrar que funcionou. */
    log: [],
    tickTimer: null,
    busy: false,

    async init(api) {
      this.api = api || window.pokeAPI;
      if (!this.api || !this.api.expeditionGet) return;

      if (this.api.onExpedition) {
        // O laço roda no processo principal, inclusive com esta janela em
        // segundo plano: a tela acompanha sem perguntar.
        this.api.onExpedition(data => this.report(data));
      }

      await this.load();
      this.wire();
      this.startTick();
    },

    async load(force) {
      const res = await this.api.expeditionGet(force ? { force: true } : undefined)
        .catch(() => null);
      if (!res) {
        this.say('Não foi possível ler o estado das expedições.', true);
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
     * Mede o desvio de relógio pela conta mais recente que trouxe `nowMs`.
     *
     * Uma conta basta: o servidor é o mesmo para todas, e a diferença entre
     * elas é só a latência da leitura — dezenas de milissegundos num prazo de
     * horas.
     */
    measureSkew() {
      for (const conta of this.accounts) {
        const now = conta.summary && Number(conta.summary.nowMs);
        if (now) {
          this.skewMs = now - Date.now();
          return;
        }
      }
    },

    /** "Agora" segundo o servidor. É contra isto que os prazos são medidos. */
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
      const host = document.getElementById('expControls');
      if (!host) return;

      const segundos = Math.round((this.config.intervalMs || 60000) / 1000);
      const min = Math.round((this.limits.minIntervalMs || 15000) / 1000);
      const max = Math.round((this.limits.maxIntervalMs || 600000) / 1000);

      host.innerHTML = `
        <label class="xp-master">
          <input type="checkbox" id="expEnabled" ${this.config.enabled ? 'checked' : ''}>
          <span>Ligar a auto-expedição</span>
        </label>
        <label class="xp-interval">
          <span>Verificar a cada</span>
          <input type="number" id="expInterval" min="${min}" max="${max}" step="5"
            value="${segundos}">
          <span>s</span>
        </label>`;
    },

    renderAccounts() {
      const host = document.getElementById('expAccounts');
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
              <th>Em expedição</th>
              <th>Prontas</th>
              <th>Livres no armazém</th>
              <th>Tempo</th>
              <th>Próxima volta</th>
            </tr>
          </thead>
          <tbody>${linhas}</tbody>
        </table>`;
    },

    accountHtml(conta) {
      const nome = conta.name || conta.username || `Conta ${conta.index + 1}`;
      const s = conta.summary;

      // Conta sem monitor não é conta sem expedição: dizer "0 em expedição"
      // seria afirmar algo que o launcher não sabe.
      const detalhe = !conta.connected
        ? '<td colspan="5" class="xp-off">monitor desligado</td>'
        : conta.errorCode
          ? `<td colspan="5" class="xp-err" title="${escape(conta.errorCode)}">${escape(ERROS[conta.errorCode] || conta.errorCode)}</td>`
          : !s
            ? '<td colspan="5" class="xp-off">lendo…</td>'
            : !s.enabled
              ? '<td colspan="5" class="xp-off">expedição não liberada nesta conta</td>'
              : `
                <td class="xp-num">${s.active} / ${s.capacity}</td>
                <td class="xp-num ${s.ready ? 'is-ready' : ''}">${s.ready || '—'}</td>
                <td class="xp-num">${s.available}</td>
                <td class="xp-num">${horas(s.maxMinutes)}${s.vip ? ' <span class="xp-vip">VIP</span>' : ''}</td>
                <td class="xp-next" data-ends="${s.nextEndsAtMs || 0}">${this.nextText(s)}</td>`;

      return `
        <tr data-index="${conta.index}">
          <td class="xp-th-on">
            <input type="checkbox" data-account="${conta.index}"
              ${conta.enabled ? 'checked' : ''}
              title="Desmarcar deixa esta conta de fora da auto-expedição">
          </td>
          <td class="xp-name">
            <span class="xp-dot ${conta.connected ? 'is-on' : ''}"></span>
            ${escape(nome)}
          </td>
          ${detalhe}
        </tr>`;
    },

    /** Texto da coluna de prazo. Recalculado a cada segundo pelo tique. */
    nextText(summary) {
      if (!summary || !summary.active) return '—';
      if (summary.ready) return '<b class="is-ready">pronta para coletar</b>';
      const fim = Number(summary.nextEndsAtMs) || 0;
      if (!fim) return '—';
      const falta = fim - this.agora();
      if (falta <= 0) return '<b class="is-ready">pronta para coletar</b>';
      return `${duracao(falta)} <span class="xp-at">(${relogio(fim)})</span>`;
    },

    /**
     * Só a coluna de prazo, de segundo em segundo.
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
          ? '<b class="is-ready">pronta para coletar</b>'
          : `${duracao(falta)} <span class="xp-at">(${relogio(fim)})</span>`;
      }
    },

    startTick() {
      clearInterval(this.tickTimer);
      this.tickTimer = setInterval(() => this.tick(), 1000);
    },

    renderLog() {
      const host = document.getElementById('expLog');
      if (!host) return;
      if (!this.log.length) {
        host.innerHTML = '<p class="hint">Nada coletado ou enviado nesta sessão ainda.</p>';
        return;
      }
      host.innerHTML = this.log.map(linha => `
        <div class="xp-line ${linha.error ? 'is-err' : ''}">
          <span class="xp-time">${relogio(linha.atMs)}</span>
          <span class="xp-line-acc">Conta ${linha.index + 1}</span>
          <span class="xp-line-text">${escape(linha.text)}</span>
        </div>`).join('');
    },

    // ------------------------------------------------------------ eventos

    wire() {
      const host = document.getElementById('expControls');
      if (host) {
        host.onchange = e => {
          if (e.target.id === 'expEnabled' || e.target.id === 'expInterval') this.save();
        };
      }

      const accounts = document.getElementById('expAccounts');
      if (accounts) {
        // Delegado: a tabela é redesenhada a cada leitura, e um ouvinte por
        // caixinha morreria junto com ela.
        accounts.onchange = e => {
          if (e.target.dataset && e.target.dataset.account !== undefined) this.save();
        };
      }

      const poll = document.getElementById('expPoll');
      if (poll) poll.onclick = () => this.poll();
    },

    /**
     * Lê a tela. Números crus de propósito: o domínio normaliza, e a lista de
     * contas desligadas é derivada das caixinhas desmarcadas — nunca de uma
     * lista de permissões, para que uma conta nova participe por padrão.
     */
    collect() {
      const enabled = document.getElementById('expEnabled');
      const interval = document.getElementById('expInterval');
      const disabled = [];
      for (const caixa of document.querySelectorAll('[data-account]')) {
        if (!caixa.checked) disabled.push(Number(caixa.dataset.account));
      }
      return {
        enabled: !!(enabled && enabled.checked),
        intervalMs: (Number(interval && interval.value) || 60) * 1000,
        disabled
      };
    },

    async save() {
      if (this.busy) return;
      this.busy = true;
      const res = await this.api.expeditionSet(this.collect())
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
        ? `Salvo. Ligada${fora ? `, ${fora} conta${fora === 1 ? '' : 's'} de fora` : ' em todas as contas'}.`
        : 'Salvo. A auto-expedição está desligada.');
    },

    async poll() {
      const botao = document.getElementById('expPoll');
      if (botao) botao.disabled = true;
      this.say('Verificando as contas…');

      const res = await this.api.expeditionPoll().catch(e => ({ error: e.message }));
      if (botao) botao.disabled = false;

      if (!res || res.error) {
        this.say('Falha ao verificar: ' + ((res && res.error) || 'desconhecida'), true);
        return;
      }
      this.apply(res);
      this.render();
      this.say('Verificado.');
    },

    /**
     * Uma coleta ou um envio aconteceu numa conta.
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
        this.measureSkew();
      }
      if (conta && data.stats) conta.stats = data.stats;

      const partes = [];
      if (data.collected) {
        const ganhos = (data.reports || [])
          .map(r => RESULTADOS[r.outcome] || r.outcome)
          .filter(Boolean);
        partes.push(`coletou ${data.collected}${ganhos.length ? ` (${ganhos.join(', ')})` : ''}`);
      }
      if (data.sent) {
        const nomes = (data.sends || []).map(s => s.shadow && s.shadow.name).filter(Boolean);
        partes.push(`enviou ${data.sent}${nomes.length ? `: ${nomes.join(', ')}` : ''}`);
      }
      if (data.error) partes.push(ERROS[data.error] || data.error);

      if (partes.length) {
        this.log.unshift({
          index: data.index,
          atMs: Date.now(),
          error: !!data.error,
          text: partes.join(' · ')
        });
        // Teto: o log é de memória, e a automação roda por dias.
        if (this.log.length > 200) this.log.length = 200;
      }

      this.renderAccounts();
      this.renderLog();
    },

    say(text, isError) {
      const bar = document.getElementById('expStatusBar');
      if (!bar) return;
      bar.textContent = text;
      bar.classList.toggle('is-error', !!isError);
    }
  };

  if (typeof window !== 'undefined') window.PioExpedition = PioExpedition;
  if (typeof module !== 'undefined' && module.exports) module.exports = PioExpedition;
})();

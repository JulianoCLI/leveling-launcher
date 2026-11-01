/**
 * @file leveling-cambio-ui.js
 * Tela do câmbio: a conta de destino, a reserva, o ritmo, a cadeia e o
 * relatório.
 *
 * A pergunta que esta tela responde é "quanto saiu de qual conta, e quando".
 * Ela não tem substituto no jogo: a janela de troca não guarda histórico, e
 * depois de um hop não há onde conferir o que aconteceu além do saldo. Por isso
 * cada linha do relatório traz o par, o valor e **os dois saldos** — é o que
 * permite auditar a transferência sem o servidor.
 *
 * A seção da cadeia existe por um motivo diferente: ela mostra o caminho que o
 * ouro vai fazer *antes* de a primeira troca acontecer. Um destino errado é o
 * único erro aqui que não tem desfazer, e ver "9 → 8 → … → 1" escrito é mais
 * fácil de conferir que um número num campo.
 *
 * Nada aqui valida de verdade: `leveling-cambio.js` normaliza o que receber, e
 * a reserva sobe para o piso mesmo se a tela mandar zero.
 */

(() => {
  'use strict';

  const escape = s => String(s === undefined || s === null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

  /**
   * Ouro em forma curta. Os saldos chegam a dezenas de milhões, e
   * `7.726.267` repetido em três colunas empurra a tabela para fora.
   *
   * O número exato fica no `title`: a conferência contra o jogo precisa do
   * valor cheio, porque é exatamente isso que o painel do jogo mostra.
   */
  const ouro = valor => {
    const n = Math.floor(Number(valor) || 0);
    if (n >= 1e9) return `${(n / 1e9).toFixed(2)} B`;
    if (n >= 1e6) return `${(n / 1e6).toFixed(2)} M`;
    if (n >= 1e3) return `${(n / 1e3).toFixed(1)} k`;
    return String(n);
  };

  const cheio = valor => Math.floor(Number(valor) || 0).toLocaleString('pt-BR');

  /** Hora do dia, para a coluna do relatório. */
  const relogio = ms => {
    const n = Number(ms);
    if (!n) return '';
    const d = new Date(n);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  };

  /** Contagem regressiva do próximo hop, em texto curto. */
  const emBreve = ms => {
    const n = Math.max(0, Math.floor(Number(ms) || 0) / 1000);
    if (n < 60) return `${Math.round(n)} s`;
    const min = Math.floor(n / 60);
    if (min < 60) return `${min} min`;
    return `${Math.floor(min / 60)} h ${min % 60} min`;
  };

  /**
   * Etapas do hop, em português. É o que a tela mostra enquanto a troca corre,
   * e cada nome diz onde a transferência está — útil justamente quando ela
   * empaca: "aproximar" parado significa que as contas não se acharam na
   * cidade, que é um problema diferente de "travar" parado.
   */
  const ETAPAS = {
    amizade: 'conferindo a amizade entre as contas',
    reuniao: 'levando as contas para a cidade',
    aproximar: 'aproximando os personagens',
    oferta: 'abrindo a troca e pondo o ouro',
    travar: 'travando a oferta nos dois lados',
    confirmar: 'confirmando a troca',
    conferir: 'conferindo os saldos'
  };

  /**
   * Falhas, em português. O código fica no `title`.
   *
   * As de conferência são as mais importantes da lista: elas significam que a
   * cadeia **parou de propósito**, e não que algo quebrou. Um usuário que lê
   * "ouro divergente" como defeito desligaria justamente a proteção que impediu
   * uma troca errada.
   */
  const MOTIVOS = {
    'cambio.semCadeia': 'não há cadeia: faltam duas contas conectadas, ou a conta de destino está fora do monitor',
    'cambio.nadaASobrar': 'nenhuma conta passou da reserva ainda',
    'cambio.aguardandoIntervalo': 'esperando o intervalo entre trocas',
    'cambio.jaEmTroca': 'já há uma troca em andamento',
    'cambio.desligado': 'o câmbio está desligado',
    'cambio.abaixoDaReserva': 'o saldo está na reserva ou abaixo dela',
    'cambio.poucoParaValer': 'a sobra é menor que o mínimo por troca',
    'cambio.semTrocaAberta': 'o servidor não abriu a troca',
    'cambio.ouroDivergente': 'o ouro na oferta não era o planejado: a troca foi abortada antes de travar',
    'cambio.parceiroOfertou': 'a outra conta pôs algo na oferta: abortado (a troca é de mão única)',
    'cambio.itemNaOferta': 'havia um item na oferta: abortado (o câmbio só move ouro)',
    'cambio.sombraNaOferta': 'havia uma sombra na oferta: abortado (o câmbio só move ouro)',
    'cambio.contaErrada': 'a troca não era com a conta esperada',
    'cambio.parceiroErrado': 'a troca não era com a conta esperada',
    'cambio.semFecho': 'o servidor não confirmou a troca',
    'cambio.deuDiferente': 'saiu um valor diferente do planejado: a cadeia parou',
    'cambio.recebeuDiferente': 'chegou menos do que saiu: a cadeia parou',
    'cambio.saldoOrigemBaixo': 'o saldo de quem deu não fecha: a cadeia parou',
    'cambio.saldoDestinoBaixo': 'o saldo de quem recebeu não fecha: a cadeia parou',
    'cambio.amizadeNaoFormou': 'a amizade não se formou entre as contas',
    'cambio.arrastado': 'algo tirou a conta da cidade no meio da troca (um grupo, provavelmente): abortado',
    'cambio.travelFailed': 'não foi possível levar a conta até a cidade',
    'cambio.canalCheio': 'o canal da outra conta está cheio',
    'cambio.canalNaoAlinhou': 'as contas não ficaram no mesmo canal',
    'cambio.semPosicao': 'o servidor não disse onde os personagens estão',
    'cambio.walkFailed': 'os personagens não chegaram perto um do outro',
    'cambio.timeout': 'a troca passou do tempo e foi abortada',
    'trade.friends_only': 'as contas precisam ser amigas no jogo',
    'trade.locked': 'a oferta já estava travada',
    'trade.busy': 'uma das contas já estava numa troca',
    'channel.switchFailed': 'não foi possível trocar de canal',
    'social.kindNotAllowed': 'ação social não permitida',
    'hunt.cambioBusy': 'a conta está no meio de uma troca'
  };

  const PioCambio = {
    api: null,
    config: {
      enabled: false, destino: 1, origem: 0,
      reserva: 100000, minimo: 1000, intervaloMs: 600000, disabled: []
    },
    accounts: [],
    ativos: [],
    hops: [],
    log: [],
    stats: {},
    busy: false,
    etapa: '',
    proximoEmMs: 0,
    limits: { minReserva: 100000, minIntervalMs: 60000, maxIntervalMs: 21600000, minAmount: 1000 },
    saving: false,
    timer: null,

    async init(api) {
      this.api = api || window.pokeAPI;
      if (!this.api || !this.api.cambioGet) return;

      if (this.api.onCambio) {
        // O laço roda no processo principal, inclusive com esta janela em
        // segundo plano: cada hop aparece sem a tela perguntar.
        this.api.onCambio(() => this.load());
      }

      await this.load();
      this.wire();

      // Releitura periódica, que as outras telas não têm e esta precisa: o
      // saldo das contas sobe sozinho enquanto elas caçam, e é o saldo que diz
      // qual hop está perto de sair. Sem isto a cadeia ficaria congelada no
      // valor do momento em que a janela abriu.
      this.timer = setInterval(() => {
        if (!this.saving) this.load();
      }, 10000);
    },

    async load() {
      const res = await this.api.cambioGet().catch(() => null);
      if (!res) {
        this.say('Não foi possível ler a configuração do câmbio.', true);
        return;
      }
      this.apply(res);
      this.render();
    },

    apply(res) {
      if (res.config) this.config = res.config;
      if (res.accounts) this.accounts = res.accounts;
      if (res.ativos) this.ativos = res.ativos;
      if (res.hops) this.hops = res.hops;
      if (res.log) this.log = res.log;
      if (res.stats) this.stats = res.stats;
      if (res.limits) this.limits = res.limits;
      this.busy = !!res.busy;
      this.etapa = res.etapa || '';
      this.proximoEmMs = Number(res.proximoEmMs) || 0;
    },

    // ------------------------------------------------------------- desenho

    render() {
      this.renderControls();
      this.renderChain();
      this.renderAccounts();
      this.renderLog();
    },

    renderControls() {
      const host = document.getElementById('cambioControls');
      if (!host) return;

      const minutos = Math.round((this.config.intervaloMs || 600000) / 60000);
      const min = Math.round((this.limits.minIntervalMs || 60000) / 60000);
      const max = Math.round((this.limits.maxIntervalMs || 21600000) / 60000);

      // As contas por número, não por nome: o campo é o índice do painel, e é
      // assim que o usuário conta as contas no launcher. O nome do personagem
      // vai na opção para a conferência não depender de memória.
      const opcoes = this.accounts.map(conta => {
        const nome = conta.name || conta.username || `Conta ${conta.index + 1}`;
        const n = conta.index + 1;
        return `<option value="${n}" ${this.config.destino === n ? 'selected' : ''}>
          ${n} · ${escape(nome)}</option>`;
      }).join('');

      host.innerHTML = `
        <label class="xp-master">
          <input type="checkbox" id="cambioEnabled" ${this.config.enabled ? 'checked' : ''}>
          <span>Ligar o câmbio</span>
        </label>
        <label class="xp-interval"
          title="A conta que concentra todo o ouro. É o fim da cadeia e a única que não tem reserva: ela só recebe.">
          <span>Juntar tudo na</span>
          <select id="cambioDestino">${opcoes || '<option value="1">1</option>'}</select>
        </label>
        <label class="xp-interval"
          title="Ouro que fica intocado em cada conta de origem. Abaixo disso a conta para de repor poção e deixa de caçar, então o mínimo não pode ser reduzido.">
          <span>Deixar sempre</span>
          <input type="number" id="cambioReserva" min="${this.limits.minReserva || 100000}" step="10000"
            value="${Math.floor(this.config.reserva) || 100000}">
          <span>de ouro em cada conta</span>
        </label>
        <label class="xp-interval"
          title="Tempo entre uma troca e a seguinte. Conta do fecho da anterior, não do início, e leva uma variação aleatória de até 20%.">
          <span>Uma troca a cada</span>
          <input type="number" id="cambioIntervalo" min="${min}" max="${max}" step="1" value="${minutos}">
          <span>min</span>
        </label>
        <label class="xp-interval"
          title="Sobra menor que isto não paga uma troca: o hop e o intervalo que vem depois dele custam mais que mover ruído.">
          <span>Não trocar menos de</span>
          <input type="number" id="cambioMinimo" min="${this.limits.minAmount || 1000}" step="1000"
            value="${Math.floor(this.config.minimo) || 1000}">
          <span>de ouro</span>
        </label>
        ${this.statusLinha()}`;
    },

    /**
     * A linha de estado acima da cadeia.
     *
     * Três perguntas, nesta ordem de urgência: está trocando agora (e em que
     * etapa), quando sai a próxima, e o que deu errado na última. A etapa é o
     * que mais importa durante os três segundos do hop, e é o único momento em
     * que esta tela mostra algo que muda sozinho.
     */
    statusLinha() {
      if (this.busy) {
        const etapa = ETAPAS[this.etapa] || this.etapa || 'em andamento';
        return `<p class="hint"><b>Trocando agora:</b> ${escape(etapa)}…</p>`;
      }

      const erro = this.stats && this.stats.lastError;
      const partes = [];
      if (this.config.enabled && this.proximoEmMs) {
        partes.push(`Próxima troca em <b>${emBreve(this.proximoEmMs)}</b>.`);
      }
      if (this.stats && this.stats.hops) {
        partes.push(`${this.stats.hops} ${this.stats.hops === 1 ? 'troca feita' : 'trocas feitas'},
          <b title="${cheio(this.stats.goldMoved)} de ouro">${ouro(this.stats.goldMoved)}</b> movidos.`);
      }
      if (erro) {
        partes.push(`<span title="${escape(erro)}">Última tentativa: ${escape(MOTIVOS[erro] || erro)}.</span>`);
      }
      if (!partes.length) return '';
      return `<p class="hint ${erro ? 'is-warn' : ''}">${partes.join(' ')}</p>`;
    },

    /**
     * A cadeia, hop a hop.
     *
     * Mostra o caminho **antes** de a primeira troca acontecer: é a conferência
     * do destino, que é o único erro aqui sem desfazer. A coluna da sobra
     * explica por que um hop ainda não saiu — quase sempre porque a conta não
     * passou da reserva, que é o caso normal e não um defeito.
     */
    renderChain() {
      const host = document.getElementById('cambioChain');
      if (!host) return;

      if (!this.config.enabled) {
        host.innerHTML = '<p class="hint">O câmbio está desligado. Nada é transferido.</p>';
        return;
      }
      if (!this.hops.length) {
        host.innerHTML = `<p class="hint is-warn">Não há cadeia agora. Um hop precisa de <b>duas</b> contas
          conectadas no monitor, e a conta de destino tem de ser uma delas.</p>`;
        return;
      }

      const nome = index => {
        const conta = this.accounts.find(c => c.index === index);
        return (conta && (conta.name || conta.username)) || `Conta ${index + 1}`;
      };

      const linhas = this.hops.map(hop => {
        const plano = hop.plano || {};
        const sobra = plano.skip
          ? `<span class="xp-at" title="${escape(plano.reason || '')}">${escape(MOTIVOS[plano.reason] || 'aguardando acumular')}</span>`
          : `<b title="${cheio(plano.gold)} de ouro">${ouro(plano.gold)}</b>`;
        return `
          <tr>
            <td class="xp-name">${hop.de + 1} · ${escape(nome(hop.de))}</td>
            <td class="xp-at">→</td>
            <td class="xp-name">${hop.para + 1} · ${escape(nome(hop.para))}</td>
            <td class="xp-num" title="${cheio(hop.saldo)} de ouro">${ouro(hop.saldo)}</td>
            <td class="xp-num">${sobra}</td>
          </tr>`;
      }).join('');

      host.innerHTML = `
        <table class="xp-table">
          <thead>
            <tr>
              <th>De</th>
              <th></th>
              <th>Para</th>
              <th title="Saldo atual da conta de origem">Saldo</th>
              <th title="Quanto sairia agora: o saldo menos a reserva">Sai</th>
            </tr>
          </thead>
          <tbody>${linhas}</tbody>
        </table>`;
    },

    renderAccounts() {
      const host = document.getElementById('cambioAccounts');
      if (!host) return;

      if (!this.accounts.length) {
        host.innerHTML = '<p class="hint">Nenhuma conta configurada.</p>';
        return;
      }

      const fora = new Set((this.config.disabled || []).map(Number));
      const destinoIdx = this.config.destino - 1;

      const linhas = this.accounts.map(conta => {
        const nome = conta.name || conta.username || `Conta ${conta.index + 1}`;
        // As linhas de correio ficam de fora das duas somas: elas têm `de` e
        // `para` iguais, e contá-las diria que a conta enviou para si mesma.
        const enviado = this.log
          .filter(l => l.de === conta.index && l.ok && !l.correio)
          .reduce((soma, l) => soma + (Number(l.gold) || 0), 0);
        const recebido = this.log
          .filter(l => l.para === conta.index && l.ok && !l.correio)
          .reduce((soma, l) => soma + (Number(l.gold) || 0), 0);
        const ehDestino = conta.index === destinoIdx;
        return `
          <tr data-index="${conta.index}">
            <td class="xp-th-on">
              <input type="checkbox" data-account="${conta.index}"
                ${fora.has(conta.index) ? '' : 'checked'}
                ${ehDestino ? 'disabled' : ''}
                title="${ehDestino
                  ? 'A conta de destino participa sempre: sem ela não há cadeia'
                  : 'Desmarcar deixa esta conta de fora do câmbio'}">
            </td>
            <td class="xp-name">
              <span class="xp-dot ${conta.connected ? 'is-on' : ''}"></span>
              ${escape(nome)}${ehDestino ? ' <span class="xp-at">(destino)</span>' : ''}
            </td>
            ${conta.connected
              ? `<td class="xp-num" title="${cheio(conta.gold)} de ouro">${ouro(conta.gold)}</td>
                 <td class="xp-num" title="${cheio(enviado)} de ouro">${enviado ? ouro(enviado) : '—'}</td>
                 <td class="xp-num" title="${cheio(recebido)} de ouro">${recebido ? ouro(recebido) : '—'}</td>`
              : '<td colspan="3" class="xp-off">monitor desligado</td>'}
          </tr>`;
      }).join('');

      host.innerHTML = `
        <table class="xp-table">
          <thead>
            <tr>
              <th class="xp-th-on">Entra</th>
              <th>Conta</th>
              <th>Saldo</th>
              <th>Enviou</th>
              <th>Recebeu</th>
            </tr>
          </thead>
          <tbody>${linhas}</tbody>
        </table>`;
    },

    renderLog() {
      const host = document.getElementById('cambioLog');
      if (!host) return;
      if (!this.log.length) {
        host.innerHTML = `<p class="hint">Nenhuma troca ainda. O relatório sobrevive ao fechamento do launcher,
          e é o único lugar onde o histórico existe — a janela de troca do jogo não guarda nada.</p>`;
        return;
      }
      host.innerHTML = this.log.map(linha => this.lineHtml(linha)).join('');
    },

    /**
     * Uma linha do relatório.
     *
     * Os dois saldos vão à vista, não no `title`: eles são a razão de ser do
     * relatório. Sem o jogo guardar histórico de troca, conferir "a conta 8
     * tinha 7,7 M e ficou com 100 k" é a única auditoria possível, e escondê-la
     * num tooltip faria isso depender de passar o mouse em cada linha.
     */
    lineHtml(linha) {
      const hora = relogio(linha.atMs);
      const rotulo = linha.rotulo || `${(Number(linha.de) || 0) + 1}→${(Number(linha.para) || 0) + 1}`;
      const envelope = (classe, html) => `
        <div class="xp-line ${classe}">
          <span class="xp-time">${hora}</span>
          <span class="xp-line-acc">${escape(rotulo)}</span>
          <span class="xp-line-text">${html}</span>
        </div>`;

      if (linha.correio) {
        // Não é um hop: é ouro que estava parado no correio daquela conta e
        // entrou no saldo antes de ela doar. Aparece porque sem isso o valor
        // do hop seguinte pareceria sair do nada.
        return envelope('', `
          <span class="xp-boss-ok">📬 recolhido do correio</span>
          <b title="${cheio(linha.gold)} de ouro">${ouro(linha.gold)}</b>`);
      }

      if (linha.ok) {
        const correio = linha.mailed
          ? ' <span class="xp-at" title="O ouro caiu no correio, não no saldo: resgate no jogo">📬 foi para o correio</span>'
          : '';
        return envelope('', `
          <span class="xp-boss-ok">✔ transferido</span>
          <b title="${cheio(linha.gold)} de ouro">${ouro(linha.gold)}</b>
          <span class="xp-at" title="saldo de quem deu: ${cheio(linha.saldoDe)}">origem ficou com ${ouro(linha.saldoDe)}</span>
          <span class="xp-at" title="saldo de quem recebeu: ${cheio(linha.saldoPara)}">destino ficou com ${ouro(linha.saldoPara)}</span>
          ${correio}`);
      }

      const motivo = MOTIVOS[linha.error] || linha.error || 'falhou';
      return envelope('is-err', `
        <span class="xp-boss-fail" title="${escape(linha.error || '')}">✖ não transferido</span>
        <span class="xp-at">${escape(motivo)}</span>`);
    },

    // ------------------------------------------------------------- eventos

    wire() {
      const host = document.getElementById('cambioControls');
      if (host) {
        // `change`, não `input`: salvar a cada tecla do campo de reserva
        // mandaria uma reserva de "1" no caminho para "100000", e esse valor
        // intermediário vale um hop se o laço rodar no instante errado — ou
        // seja, uma conta esvaziada por um dígito.
        host.onchange = () => this.save();
      }

      const accounts = document.getElementById('cambioAccounts');
      if (accounts) {
        // Delegado: a tabela é redesenhada a cada leitura — e esta tela relê de
        // dez em dez segundos — então um ouvinte por caixinha morreria junto
        // com ela.
        accounts.onchange = e => {
          if (e.target.dataset && e.target.dataset.account !== undefined) this.save();
        };
      }

      const poll = document.getElementById('cambioPoll');
      if (poll) poll.onclick = () => this.poll();

      const mail = document.getElementById('cambioMail');
      if (mail) mail.onclick = () => this.mail();

      const clear = document.getElementById('cambioClear');
      if (clear) clear.onclick = () => this.clear();
    },

    /**
     * Lê a tela. Números crus de propósito: o domínio normaliza, e a reserva
     * sobe para o piso mesmo se vier zero daqui.
     *
     * A lista de contas de fora é derivada das caixinhas **desmarcadas**, nunca
     * uma lista de permissões — assim uma conta nova participa por padrão, como
     * na expedição, no boss e no auto-anunciar.
     */
    collect() {
      const valor = (id, fallback) => {
        const el = document.getElementById(id);
        const n = Number(el && el.value);
        return Number.isFinite(n) ? n : fallback;
      };

      const disabled = [];
      for (const caixa of document.querySelectorAll('[data-account]')) {
        if (!caixa.disabled && !caixa.checked) disabled.push(Number(caixa.dataset.account));
      }

      return {
        enabled: !!(document.getElementById('cambioEnabled') || {}).checked,
        destino: valor('cambioDestino', 1),
        // Vem do estado, não da tela: não há campo para ele. O padrão (zero)
        // significa "a maior conta ativa", que é o que o pedido descreve.
        origem: this.config.origem || 0,
        reserva: valor('cambioReserva', 100000),
        minimo: valor('cambioMinimo', 1000),
        intervaloMs: valor('cambioIntervalo', 10) * 60000,
        disabled
      };
    },

    async save() {
      if (this.saving) return;
      this.saving = true;
      const res = await this.api.cambioSet(this.collect()).catch(e => ({ error: e.message }));
      this.saving = false;

      if (!res || res.error || !res.ok) {
        this.say('Falha ao salvar: ' + ((res && res.error) || 'desconhecida'), true);
        return;
      }

      this.apply(res);
      this.render();

      if (!this.config.enabled) {
        this.say('Salvo. O câmbio está desligado.');
        return;
      }
      const destino = this.accounts.find(c => c.index === this.config.destino - 1);
      const nome = (destino && (destino.name || destino.username)) || `conta ${this.config.destino}`;
      const minutos = Math.round(this.config.intervaloMs / 60000);
      const fora = (this.config.disabled || []).length;
      this.say(`Salvo. O ouro desce para ${nome}, uma troca a cada ${minutos} min, deixando
        ${cheio(this.config.reserva)} em cada conta${fora ? `, ${fora} conta${fora === 1 ? '' : 's'} de fora` : ''}.`);
    },

    async poll() {
      const botao = document.getElementById('cambioPoll');
      if (botao) botao.disabled = true;
      this.say('Procurando o próximo hop e transferindo…');

      const res = await this.api.cambioPoll().catch(e => ({ error: e.message }));
      if (botao) botao.disabled = false;

      if (!res || res.error) {
        this.say('Falha ao transferir: ' + ((res && res.error) || 'desconhecida'), true);
        return;
      }
      this.apply(res);
      this.render();

      const r = res.resultado;
      if (!r) {
        // O caso mais comum, e não é erro: nenhuma conta passou da reserva, ou
        // o intervalo da troca anterior ainda não venceu.
        const erro = this.stats && this.stats.lastError;
        this.say(`Nada a transferir agora${erro ? `: ${MOTIVOS[erro] || erro}` : '.'}`);
        return;
      }
      if (r.ok) {
        this.say(`Transferido: ${cheio(r.gold)} de ouro.`);
        return;
      }
      this.say('A troca não foi concluída: ' + (MOTIVOS[r.error] || r.error || 'erro'), true);
    },

    /**
     * Recolhe o correio de todas as contas em monitor.
     *
     * Separado de "Transferir agora" porque responde outra pergunta: o hop
     * recolhe só da conta que vai doar, e uma conta no fim da fila pode ficar
     * com o ouro de venda parado por horas. Aqui a varredura é a cadeia
     * inteira, e nada sai de conta nenhuma.
     */
    async mail() {
      const botao = document.getElementById('cambioMail');
      if (botao) botao.disabled = true;
      this.say('Lendo o correio de todas as contas em monitor…');

      const res = await this.api.cambioMail().catch(e => ({ error: e.message }));
      if (botao) botao.disabled = false;

      if (!res || res.error) {
        this.say('Falha ao resgatar: ' + ((res && res.error) || 'desconhecida'), true);
        return;
      }
      this.apply(res);
      this.render();

      const r = res.resultado || {};
      if (!r.gold) {
        this.say('Nenhum ouro parado no correio. Entradas com item, diamante ou em análise não são tocadas.');
        return;
      }
      this.say(`Resgatado: ${cheio(r.gold)} de ouro de ${r.contas} ${r.contas === 1 ? 'conta' : 'contas'}.`);
    },

    async clear() {
      const res = await this.api.cambioLogClear().catch(e => ({ error: e.message }));
      if (!res || res.error) {
        this.say('Falha ao limpar: ' + ((res && res.error) || 'desconhecida'), true);
        return;
      }
      this.log = [];
      this.renderAccounts();
      this.renderLog();
      this.say('Relatório limpo. O ouro já transferido continua onde está.');
    },

    say(text, isError) {
      const bar = document.getElementById('cambioStatusBar');
      if (!bar) return;
      bar.textContent = text;
      bar.classList.toggle('is-error', !!isError);
    }
  };

  if (typeof window !== 'undefined') window.PioCambio = PioCambio;
  if (typeof module !== 'undefined' && module.exports) module.exports = PioCambio;
})();

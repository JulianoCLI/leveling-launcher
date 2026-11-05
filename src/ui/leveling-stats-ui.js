/**
 * @file leveling-stats-ui.js
 * Tela do auto-status: a build de cada conta, o que já foi investido e a prévia
 * da divisão que o launcher vai enviar.
 *
 * A pergunta que esta tela responde é "onde vão cair os pontos do próximo
 * nível, nesta conta". Ela não tem substituto no jogo para quem roda oito
 * contas: abrir cada personagem e somar os pesos da build à mão é o trabalho que
 * o launcher existe para tirar.
 *
 * A coluna **Vai sair** é a razão de ser da tela. Alocar ponto é a única ação do
 * launcher que gasta recurso do personagem sem desfazer barato — respec custa
 * token ou cristal — então ver a divisão exata antes de ligar não é conforto, é
 * a conferência que evita queimar pontos numa build errada. Ela é calculada pelo
 * mesmo código que faz o envio, em `leveling-stats.js`, e não por uma conta
 * paralela daqui: uma prévia que divergisse do envio seria pior que nenhuma.
 *
 * Esta é também a única tela de automação com configuração **por conta**. As
 * outras têm uma política global e uma lista de contas de fora; aqui classe e
 * build são do personagem, e não existe valor global que sirva. A lista de
 * contas de fora continua sendo derivada das caixinhas desmarcadas, como nas
 * outras, para que uma conta nova participe por padrão.
 *
 * Nada aqui valida de verdade: `leveling-stats.js` normaliza o que receber, e
 * pesos todos em zero viram "sem configuração" em vez de uma conta ligada que
 * não distribui nada.
 */

(() => {
  'use strict';

  const escape = s => String(s === undefined || s === null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

  /**
   * Os cinco atributos na ordem da tela de status do jogo, com o nome que o
   * jogo usa. A sigla é a chave que trafega; o nome cheio vai no `title`,
   * porque "PER" sozinho não diz nada a quem joga em português.
   */
  const ATRIBUTOS = [
    { sigla: 'STR', nome: 'Força' },
    { sigla: 'AGI', nome: 'Agilidade' },
    { sigla: 'PER', nome: 'Percepção' },
    { sigla: 'VIT', nome: 'Vitalidade' },
    { sigla: 'INT', nome: 'Inteligência' }
  ];

  /** Hora do dia, para a coluna do relatório. */
  const relogio = ms => {
    const n = Number(ms);
    if (!n) return '';
    const d = new Date(n);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  };

  /**
   * Motivos, em português. O código fica no `title`.
   *
   * Quase todos significam que o launcher **não gastou** ponto — e isso é bom,
   * não defeito. `buildGone` é o mais importante da lista: a build salva sumiu
   * num deploy do jogo, e o launcher recusa em vez de cair calado noutra
   * divisão. Um usuário que lesse isso como falha ligaria o padrão por cima de
   * uma escolha deliberada.
   */
  const MOTIVOS = {
    'stats.off': 'o auto-status está desligado',
    'stats.accountOff': 'esta conta está de fora',
    'stats.noPoints': 'não há pontos livres',
    'stats.noClass': 'a classe da conta ainda não foi lida',
    'stats.noCatalog': 'as builds do jogo ainda não foram lidas: conecte o monitor',
    'stats.noBuild': 'esta classe não tem build no catálogo do jogo',
    'stats.buildGone': 'a build escolhida não existe mais: escolha outra',
    'stats.emptyPlan': 'a divisão saiu vazia',
    'stats.failed': 'o servidor recusou a distribuição',
    'stats.locked': 'o servidor não permitiu alocar agora'
  };

  /** De onde vieram os pesos, em português. */
  const ORIGENS = {
    custom: 'pesos seus',
    build: 'build escolhida',
    padrao: 'build padrão da classe'
  };

  const PioStats = {
    api: null,
    config: { enabled: false, disabled: [], porConta: {} },
    accounts: [],
    log: [],
    pointsPerLevel: 5,
    saving: false,
    timer: null,

    async init(api) {
      this.api = api || window.pokeAPI;
      if (!this.api || !this.api.statsGet) return;

      if (this.api.onStats) {
        // A distribuição é disparada pelo monitor, não por esta janela: cada
        // alocação aparece sem a tela perguntar.
        this.api.onStats(() => this.load());
      }

      await this.load();
      this.wire();

      // Releitura periódica, pelo mesmo motivo do câmbio: as contas sobem de
      // nível sozinhas enquanto caçam, e são os pontos livres que dizem se há
      // algo a distribuir. Sem isto a tela ficaria congelada no instante em que
      // a janela abriu.
      this.timer = setInterval(() => {
        if (!this.saving) this.load();
      }, 15000);
    },

    async load() {
      const res = await this.api.statsGet().catch(() => null);
      if (!res) {
        this.say('Não foi possível ler a configuração do status.', true);
        return;
      }
      this.apply(res);
      this.render();
    },

    apply(res) {
      if (res.config) this.config = res.config;
      if (res.accounts) this.accounts = res.accounts;
      if (res.log) this.log = res.log;
      if (res.pointsPerLevel) this.pointsPerLevel = res.pointsPerLevel;
    },

    // ------------------------------------------------------------- desenho

    render() {
      this.renderControls();
      this.renderAccounts();
      this.renderLog();
    },

    renderControls() {
      const host = document.getElementById('statsControls');
      if (!host) return;

      const comPontos = this.accounts.filter(c => c.connected && c.livres > 0).length;
      const partes = [];
      partes.push(`Cada nível dá <b>${this.pointsPerLevel}</b> pontos.`);
      if (comPontos) {
        partes.push(`<b>${comPontos}</b> ${comPontos === 1 ? 'conta tem' : 'contas têm'} pontos parados agora.`);
      }

      host.innerHTML = `
        <label class="xp-master">
          <input type="checkbox" id="statsEnabled" ${this.config.enabled ? 'checked' : ''}>
          <span>Distribuir os pontos automaticamente</span>
        </label>
        <p class="hint">${partes.join(' ')}</p>`;
    },

    /**
     * Uma linha por conta, e uma segunda linha de pesos quando a conta está em
     * modo personalizado.
     *
     * Conta desconectada continua na lista, com a escolha editável: é
     * exatamente nela que o usuário quer acertar a build **antes** de conectar,
     * porque o primeiro `character_state` do login já distribui os pontos
     * acumulados.
     */
    renderAccounts() {
      const host = document.getElementById('statsAccounts');
      if (!host) return;

      if (!this.accounts.length) {
        host.innerHTML = '<p class="hint">Nenhuma conta configurada.</p>';
        return;
      }

      const fora = new Set((this.config.disabled || []).map(Number));

      const linhas = this.accounts.map(conta => {
        const nome = conta.name || conta.username || `Conta ${conta.index + 1}`;
        const escolha = conta.escolha || null;
        const custom = !!escolha && escolha.modo === 'custom';

        const principal = `
          <tr data-index="${conta.index}">
            <td class="xp-th-on">
              <input type="checkbox" data-account="${conta.index}"
                ${fora.has(conta.index) ? '' : 'checked'}
                title="Desmarcar deixa esta conta de fora do auto-status">
            </td>
            <td class="xp-name">
              <span class="xp-dot ${conta.connected ? 'is-on' : ''}"></span>
              ${escape(nome)}
              ${conta.className ? `<span class="xp-at">${escape(conta.className)}</span>` : ''}
            </td>
            <td class="xp-num">${conta.level ? escape(conta.level) : '—'}</td>
            <td class="xp-num" title="Pontos de atributo ainda não gastos">${conta.livres || '—'}</td>
            <td>${this.buildSelect(conta, custom)}</td>
            <td class="xp-at">${this.investidoHtml(conta)}</td>
            <td class="xp-at">${this.previaHtml(conta)}</td>
          </tr>`;

        if (!custom) return principal;
        return principal + this.pesosRow(conta, escolha);
      }).join('');

      host.innerHTML = `
        <table class="xp-table">
          <thead>
            <tr>
              <th class="xp-th-on">Entra</th>
              <th>Conta</th>
              <th title="Nível atual">Nv.</th>
              <th title="Pontos livres">Livres</th>
              <th>Distribuir como</th>
              <th title="Pontos que você já investiu. A base da classe e o bônus de equipamento não entram.">Investido</th>
              <th title="A divisão exata que será enviada agora. É calculada pelo mesmo código do envio.">Vai sair</th>
            </tr>
          </thead>
          <tbody>${linhas}</tbody>
        </table>`;
    },

    /**
     * O seletor de build da conta.
     *
     * A primeira opção é "build padrão da classe", que é o que vale para uma
     * conta sem escolha — a mesma primeira build que o serviço usa. Deixá-la
     * explícita no seletor evita que o usuário ache que "nada selecionado"
     * significa "nada será distribuído".
     */
    buildSelect(conta, custom) {
      const builds = conta.builds || [];
      const escolhido = custom ? 'custom' : ((conta.escolha && conta.escolha.buildId) || '');

      if (!builds.length) {
        // Sem builds não há o que escolher, mas o modo personalizado continua
        // disponível: ele dispensa classe e catálogo.
        const motivo = conta.reason ? (MOTIVOS[conta.reason] || conta.reason) : 'sem builds conhecidas';
        return `
          <select data-build="${conta.index}">
            <option value="" ${escolhido !== 'custom' ? 'selected' : ''}>— ${escape(motivo)} —</option>
            <option value="custom" ${escolhido === 'custom' ? 'selected' : ''}>Pesos meus…</option>
          </select>`;
      }

      const opcoes = builds.map(b => `
        <option value="${escape(b.id)}" ${escolhido === b.id ? 'selected' : ''}
          title="${escape(b.description || '')}">${escape(b.name)}</option>`).join('');

      return `
        <select data-build="${conta.index}">
          <option value="" ${!escolhido ? 'selected' : ''}>Padrão da classe (${escape(builds[0].name)})</option>
          ${opcoes}
          <option value="custom" ${escolhido === 'custom' ? 'selected' : ''}>Pesos meus…</option>
        </select>`;
    },

    /**
     * A linha de pesos do modo personalizado: um campo por atributo, a % que
     * cada um representa, e um atalho para jogar tudo num só.
     *
     * Os números são **proporção**, não porcentagem: o domínio divide cada peso
     * pela soma, então `20/40` e `50/100` dão a mesma divisão. Não há soma a
     * fechar em 100, e exigir isso criaria um erro de validação que não existe
     * — digitar `50` em INT com `50` em VIT já é meio a meio.
     *
     * Mas a % calculada aparece embaixo de cada campo, porque é nela que o
     * usuário pensa ("quero 60% em INT") e deixá-la implícita obrigaria a fazer
     * a divisão de cabeça. Ela é derivada dos campos, não um segundo campo
     * editável: dois campos para o mesmo número brigariam no arredondamento.
     *
     * O atalho "só este" existe para o caso mais comum de todos — tudo num
     * atributo — que à mão exige zerar quatro campos, e cada `change` salva e
     * distribui.
     */
    pesosRow(conta, escolha) {
      const pesos = (escolha && escolha.pesos) || {};
      const valores = ATRIBUTOS.map(a => Math.max(0, Math.floor(Number(pesos[a.sigla]) || 0)));
      const soma = valores.reduce((x, y) => x + y, 0);

      const campos = ATRIBUTOS.map((a, i) => {
        const pct = soma > 0 ? Math.round(valores[i] / soma * 100) : 0;
        return `
          <div class="xp-peso">
            <label title="${escape(a.nome)}">
              <span>${a.sigla}</span>
              <input type="number" data-peso="${conta.index}" data-stat="${a.sigla}"
                min="0" max="1000" step="5" value="${valores[i]}">
            </label>
            <button type="button" data-so="${conta.index}" data-stat="${a.sigla}"
              title="Põe 100% em ${escape(a.nome)} e zera os outros">só este</button>
            <span class="xp-peso-pct ${pct ? '' : 'is-zero'}">${pct}%</span>
          </div>`;
      }).join('');

      const aviso = soma > 0
        ? ''
        : `<span class="xp-peso-warn">Todos em zero: nada seria distribuído, e a conta volta para a build da
           classe. Ponha pelo menos um acima de zero.</span>`;

      return `
        <tr class="xp-sub" data-pesos-de="${conta.index}">
          <td></td>
          <td colspan="6">
            <div class="xp-pesos">${campos}</div>
            <span class="xp-at">A % é calculada: o que vale é a relação entre os números, não a soma.
              ${aviso}</span>
          </td>
        </tr>`;
    },

    investidoHtml(conta) {
      const alloc = conta.allocated || {};
      const partes = ATRIBUTOS
        .filter(a => Number(alloc[a.sigla]) > 0)
        .map(a => `<span title="${escape(a.nome)}">${a.sigla} ${alloc[a.sigla]}</span>`);
      if (!partes.length) return '<span class="xp-off">nada ainda</span>';
      return partes.join(' · ');
    },

    /**
     * A prévia. Vem pronta do domínio: é o mesmo cálculo do envio.
     *
     * Quando não há prévia, o motivo aparece no lugar — "não há pontos livres"
     * é o caso normal e precisa ler como normal, não como falha.
     */
    previaHtml(conta) {
      if (conta.reason) {
        return `<span class="xp-off" title="${escape(conta.reason)}">${escape(MOTIVOS[conta.reason] || conta.reason)}</span>`;
      }
      const previa = conta.previa || [];
      if (!previa.length) {
        return `<span class="xp-off">${conta.livres ? 'nada a distribuir' : 'sem pontos livres'}</span>`;
      }
      const origem = ORIGENS[conta.origem] || conta.origem;
      const titulo = conta.buildName ? `${conta.buildName} · ${origem}` : origem;
      return `<span title="${escape(titulo)}">${previa
        .map(e => `<b>${e.stat} +${e.points}</b>`).join(' · ')}</span>`;
    },

    renderLog() {
      const host = document.getElementById('statsLog');
      if (!host) return;
      if (!this.log.length) {
        host.innerHTML = `<p class="hint">Nenhuma distribuição ainda. O relatório sobrevive ao fechamento do
          launcher, e é o único lugar onde o histórico existe — o jogo não guarda registro de alocação.</p>`;
        return;
      }
      host.innerHTML = this.log.map(linha => this.lineHtml(linha)).join('');
    },

    /**
     * Uma linha do relatório.
     *
     * A divisão vai à vista, não no `title`: ela é a razão de ser do relatório.
     * Sem o jogo guardar histórico de alocação, "a conta 3 pôs +2 INT e +3 PER
     * no nível 41" é a única auditoria possível, e esconder isso num tooltip
     * faria a conferência depender de passar o mouse em cada linha.
     */
    lineHtml(linha) {
      const hora = relogio(linha.atMs);
      const rotulo = `Conta ${(Number(linha.index) || 0) + 1}`;
      const envelope = (classe, html) => `
        <div class="xp-line ${classe}">
          <span class="xp-time">${hora}</span>
          <span class="xp-line-acc">${escape(rotulo)}</span>
          <span class="xp-line-text">${html}</span>
        </div>`;

      if (linha.ok) {
        const divisao = (linha.plano || []).map(e => `<b>${escape(e.stat)} +${escape(e.points)}</b>`).join(' · ');
        const build = linha.buildName
          ? `<span class="xp-at" title="${escape(ORIGENS[linha.origem] || linha.origem || '')}">${escape(linha.buildName)}</span>`
          : '';
        const resto = linha.remaining
          ? ` <span class="xp-at">sobraram ${escape(linha.remaining)}</span>`
          : '';
        return envelope('', `
          <span class="xp-boss-ok">✔ distribuído</span>
          ${linha.level ? `<span class="xp-at">nível ${escape(linha.level)}</span>` : ''}
          ${divisao}
          ${build}${resto}`);
      }

      const motivo = MOTIVOS[linha.reason] || linha.reason || 'falhou';
      return envelope('is-err', `
        <span class="xp-boss-fail" title="${escape(linha.reason || '')}">✖ não distribuído</span>
        <span class="xp-at">${escape(motivo)}</span>`);
    },

    // ------------------------------------------------------------- eventos

    wire() {
      const controls = document.getElementById('statsControls');
      if (controls) controls.onchange = () => this.save();

      const accounts = document.getElementById('statsAccounts');
      if (accounts) {
        // Delegado: a tabela é redesenhada a cada leitura — e esta tela relê de
        // quinze em quinze segundos — então um ouvinte por campo morreria junto
        // com ele.
        //
        // `change`, não `input`: salvar a cada tecla de um peso mandaria o
        // valor intermediário de "4" no caminho para "40", e salvar já
        // distribui os pontos parados.
        accounts.onchange = e => {
          const d = e.target.dataset || {};
          if (d.account !== undefined || d.build !== undefined || d.peso !== undefined) this.save();
        };

        // A % acompanha a digitação, sem salvar. É o retorno que torna o campo
        // de proporção legível: digitar `60` em INT só quer dizer algo ao lado
        // do que os outros têm, e esperar o `change` para ver isso deixaria o
        // número sem sentido enquanto está sendo escolhido.
        accounts.oninput = e => {
          if (e.target.dataset && e.target.dataset.peso !== undefined) {
            this.repaintPct(Number(e.target.dataset.peso));
          }
        };

        // "só este": zera os outros quatro e salva uma vez. Delegado, como o
        // resto — a tabela é redesenhada a cada leitura.
        accounts.onclick = e => {
          const botao = e.target.closest && e.target.closest('[data-so]');
          if (!botao) return;
          const index = Number(botao.dataset.so);
          for (const campo of document.querySelectorAll(`[data-peso="${index}"]`)) {
            campo.value = campo.dataset.stat === botao.dataset.stat ? 100 : 0;
          }
          this.repaintPct(index);
          this.save();
        };
      }

      const run = document.getElementById('statsRun');
      if (run) run.onclick = () => this.run();

      const clear = document.getElementById('statsClear');
      if (clear) clear.onclick = () => this.clear();
    },

    /**
     * Lê a tela inteira: a chave geral, as contas de fora e a escolha de cada
     * conta.
     *
     * Tudo numa ida só, como nas outras automações. Aqui isso importa mais: a
     * configuração é por conta, e salvar uma por vez abriria a janela em que
     * metade das contas já roda com a build nova e a outra metade não.
     *
     * A lista de contas de fora é derivada das caixinhas **desmarcadas**, nunca
     * uma lista de permissões — assim uma conta nova participa por padrão, como
     * na expedição, no boss e no câmbio.
     */
    collect() {
      const disabled = [];
      for (const caixa of document.querySelectorAll('[data-account]')) {
        if (!caixa.checked) disabled.push(Number(caixa.dataset.account));
      }

      const porConta = {};
      for (const select of document.querySelectorAll('[data-build]')) {
        const index = Number(select.dataset.build);
        const valor = select.value;

        if (valor === 'custom') {
          const pesos = {};
          for (const campo of document.querySelectorAll(`[data-peso="${index}"]`)) {
            pesos[campo.dataset.stat] = Number(campo.value) || 0;
          }
          // A linha de pesos só existe depois do redesenho, então o primeiro
          // `change` do seletor não tem campo nenhum para ler. Sem semente, os
          // pesos iriam todos em zero, o domínio descartaria a entrada por
          // "não distribui nada" e a conta voltaria para a build — o seletor
          // pareceria não fazer efeito.
          //
          // A semente são os pesos **em uso** na conta: a build que já estava
          // valendo. É o ponto de partida que o usuário quer para ajustar, e
          // não uma divisão inventada.
          porConta[String(index)] = {
            modo: 'custom',
            pesos: Object.keys(pesos).length ? pesos : this.semente(index)
          };
          continue;
        }

        // Vazio é "padrão da classe", que no domínio é a ausência de `buildId`.
        if (valor) porConta[String(index)] = { modo: 'build', buildId: valor };
      }

      return {
        enabled: !!(document.getElementById('statsEnabled') || {}).checked,
        disabled,
        porConta
      };
    },

    /**
     * Recalcula as % de uma conta no lugar, sem redesenhar a tabela.
     *
     * Redesenhar aqui mataria o campo que está sendo digitado junto com o foco
     * e o cursor — e isto roda a cada tecla.
     */
    repaintPct(index) {
      const campos = [...document.querySelectorAll(`[data-peso="${index}"]`)];
      const soma = campos.reduce((acc, c) => acc + Math.max(0, Number(c.value) || 0), 0);
      for (const campo of campos) {
        const alvo = campo.closest('.xp-peso');
        const rotulo = alvo && alvo.querySelector('.xp-peso-pct');
        if (!rotulo) continue;
        const pct = soma > 0 ? Math.round(Math.max(0, Number(campo.value) || 0) / soma * 100) : 0;
        rotulo.textContent = `${pct}%`;
        rotulo.classList.toggle('is-zero', !pct);
      }
    },

    /**
     * Pesos de partida para uma conta que acabou de entrar no modo
     * personalizado: os pesos que já estavam valendo nela.
     *
     * Ordem de preferência: a escolha personalizada anterior (voltar ao modo
     * não pode perder o que foi digitado), depois a build em uso, e por último
     * uma divisão igual entre os cinco — que é melhor que zeros, porque zeros
     * fariam a conta ficar ligada sem distribuir nada.
     */
    semente(index) {
      const atual = (this.config.porConta || {})[String(index)];
      if (atual && atual.modo === 'custom' && atual.pesos) return atual.pesos;

      const conta = this.accounts.find(c => c.index === index);
      if (conta && conta.pesos && ATRIBUTOS.some(a => Number(conta.pesos[a.sigla]) > 0)) {
        return { ...conta.pesos };
      }

      const iguais = {};
      for (const a of ATRIBUTOS) iguais[a.sigla] = 20;
      return iguais;
    },

    async save() {
      if (this.saving) return;
      this.saving = true;
      const res = await this.api.statsSet(this.collect()).catch(e => ({ error: e.message }));
      this.saving = false;

      if (!res || res.error || !res.ok) {
        this.say('Falha ao salvar: ' + ((res && res.error) || 'desconhecida'), true);
        return;
      }

      this.apply(res);
      this.render();

      if (!this.config.enabled) {
        this.say('Salvo. O auto-status está desligado: nenhum ponto é gasto.');
        return;
      }
      const fora = (this.config.disabled || []).length;
      const proprias = Object.keys(this.config.porConta || {}).length;
      this.say(`Salvo. ${proprias} ${proprias === 1 ? 'conta tem escolha própria' : 'contas têm escolha própria'};
        as outras usam a build padrão da classe${fora ? `, ${fora} conta${fora === 1 ? '' : 's'} de fora` : ''}.`);
    },

    async run() {
      const botao = document.getElementById('statsRun');
      if (botao) botao.disabled = true;
      this.say('Distribuindo os pontos parados…');

      const res = await this.api.statsRun().catch(e => ({ error: e.message }));
      if (botao) botao.disabled = false;

      if (!res || res.error) {
        this.say('Falha ao distribuir: ' + ((res && res.error) || 'desconhecida'), true);
        return;
      }
      this.apply(res);
      this.render();

      const parados = this.accounts.filter(c => c.connected && c.livres > 0).length;
      if (parados) {
        // Não é erro: a conta pode ter recusado por motivo do servidor, ou os
        // pontos podem ser de uma conta que está de fora.
        this.say(`Pronto. Ainda há ${parados} ${parados === 1 ? 'conta' : 'contas'} com pontos parados —
          veja a coluna "Vai sair" para o motivo.`);
        return;
      }
      this.say('Pronto. Nenhuma conta em monitor tem pontos parados.');
    },

    async clear() {
      const res = await this.api.statsLogClear().catch(e => ({ error: e.message }));
      if (!res || res.error) {
        this.say('Falha ao limpar: ' + ((res && res.error) || 'desconhecida'), true);
        return;
      }
      this.log = [];
      this.renderLog();
      this.say('Relatório limpo. Os pontos já distribuídos continuam onde estão.');
    },

    say(text, isError) {
      const bar = document.getElementById('statsStatusBar');
      if (!bar) return;
      bar.textContent = text;
      bar.classList.toggle('is-error', !!isError);
    }
  };

  if (typeof window !== 'undefined') window.PioStats = PioStats;
  if (typeof module !== 'undefined' && module.exports) module.exports = PioStats;
})();

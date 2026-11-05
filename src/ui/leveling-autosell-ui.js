/**
 * @file leveling-autosell-ui.js
 * Tela do auto-anunciar: os ajustes de preço, as contas, e o relatório.
 *
 * A pergunta que esta tela responde é "o que o launcher vendeu, e por quanto".
 * Por isso o relatório não mostra só o item e o valor: cada linha traz a
 * **conta do preço** — mediana do nível, anúncio rival mais barato e piso. Uma
 * automação que vende sozinha e não dá para auditar depois é uma automação em
 * que não se pode confiar, e "anunciou 4 itens" sem os números não permite
 * descobrir se o preço estava bom.
 *
 * As linhas recusadas são tão importantes quanto as anunciadas, e por um motivo
 * concreto: o motivo mais comum de uma rodada vazia é falta de mediana do nível
 * exato, que parece "quebrado" e é a decisão certa. Dizer isso aqui é o que
 * impede o usuário de baixar o piso achando que o problema é ele.
 *
 * Nada aqui valida de verdade: `leveling-autosell.js` normaliza o que receber.
 */

(() => {
  'use strict';

  const escape = s => String(s === undefined || s === null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

  /**
   * Ouro em forma curta. Os preços do mercado chegam a centenas de milhões, e
   * `187.450.000` numa célula de tabela empurra as colunas vizinhas para fora.
   *
   * O número exato fica no `title` de quem usa isto: a conferência contra o
   * jogo precisa do valor cheio.
   */
  const ouro = valor => {
    const n = Math.floor(Number(valor) || 0);
    if (n >= 1e9) return `${(n / 1e9).toFixed(2)} B`;
    if (n >= 1e6) return `${(n / 1e6).toFixed(2)} M`;
    if (n >= 1e3) return `${(n / 1e3).toFixed(1)} k`;
    return String(n);
  };

  const cheio = valor => Math.floor(Number(valor) || 0).toLocaleString('pt-BR');

  /**
   * Quantidade em forma curta. Separado de `ouro` porque as escalas não são as
   * mesmas: 1.200 de ouro é pouco e merece "1,2 k"; 1.200 unidades de um
   * material é muito, e abreviar cedo demais esconderia a diferença entre ter
   * 90 e ter 900 — que é justamente o que decide se o item é estoque.
   */
  const curtoQtd = valor => {
    const n = Math.floor(Number(valor) || 0);
    return n >= 10000 ? `${(n / 1000).toFixed(1)} k` : n.toLocaleString('pt-BR');
  };

  /** Hora do dia, para a coluna do relatório. */
  const relogio = ms => {
    const n = Number(ms);
    if (!n) return '';
    const d = new Date(n);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  };

  /**
   * Recusas, em português. O código fica no `title`.
   *
   * As de preço são as que mais aparecem, e cada uma significa uma coisa
   * diferente que o usuário pode querer mudar — ou deliberadamente não mudar.
   */
  const MOTIVOS = {
    blocked: 'na sua lista de bloqueio',
    gear: 'equipamento (sempre fora)',
    notTreasure: 'não é tesouro',
    noCategory: 'o catálogo ainda não classificou este item',
    equipped: 'está equipado',
    no_uid: 'o servidor não deu o identificador da peça',
    cheap: 'o lote vale menos que o mínimo configurado',
    noSlot: 'não havia vaga nesta rodada',
    bagFull: 'bolsa cheia: a rodada parou',
    'price.noLevelData': 'sem vendas registradas deste nível',
    'price.marketDumped': 'alguém está despejando abaixo do piso',
    'price.belowNpc': 'o NPC paga mais que o mercado',
    'price.noRate': 'sem cotação do câmbio para converter em diamante',
    'price.tooCheapForDiamond': 'vale menos que 3 diamantes: o arredondamento distorceria o preço',
    'autosell.noCatalog': 'o catálogo do jogo ainda não foi lido',
    'autosell.bagFull': 'bolsa cheia',
    'autosell.mineFailed': 'não foi possível ler os anúncios da conta',
    'autosell.invFailed': 'não foi possível ler a bolsa',
    'autosell.searchFailed': 'a busca no mercado falhou',
    'autosell.dbFailed': 'o banco de preços não respondeu',
    'inv.lockFailed': 'não foi possível tirar o cadeado da peça',
    'inv.offline': 'a conta está fora do monitor',
    'market.limit': 'a conta já está no teto de anúncios',
    'market.locked': 'a peça está trancada',
    'inventory.item_not_in_bag': 'a peça não está na bolsa'
  };

  const PioAutosell = {
    api: null,
    config: {
      enabled: false, intervalMs: 600000, maxPerRound: 2,
      priceMode: 'rival', currency: 'gold',
      floorPct: 70, undercut: 1, minGold: 0, claimMail: true,
      excluded: [], blocked: []
    },
    /**
     * O picker da lista de bloqueio. `null` enquanto fechado: a varredura de
     * bolsa de todas as contas é cara demais para acontecer sem o usuário ter
     * pedido.
     */
    picker: null,
    accounts: [],
    log: [],
    stats: {},
    catalogReady: false,
    /** A cotação do câmbio, do processo principal. Só usada no modo diamante. */
    rate: { rate: 0, samples: 0, days: 0 },
    limits: { minIntervalMs: 60000, maxIntervalMs: 21600000, maxPerRoundCap: 10 },
    busy: false,

    async init(api) {
      this.api = api || window.pokeAPI;
      if (!this.api || !this.api.autosellGet) return;

      if (this.api.onAutosell) {
        // O laço roda no processo principal, inclusive com esta janela em
        // segundo plano: cada anúncio aparece sem a tela perguntar.
        this.api.onAutosell(data => this.report(data));
      }

      await this.load();
      this.wire();
    },

    async load() {
      const res = await this.api.autosellGet().catch(() => null);
      if (!res) {
        this.say('Não foi possível ler a configuração do auto-anunciar.', true);
        return;
      }
      this.apply(res);
      this.render();
    },

    apply(res) {
      if (res.config) this.config = res.config;
      if (res.accounts) this.accounts = res.accounts;
      if (res.log) this.log = res.log;
      if (res.stats) this.stats = res.stats;
      if (res.limits) this.limits = res.limits;
      if (res.rate) this.rate = res.rate;
      if (res.catalogReady !== undefined) this.catalogReady = !!res.catalogReady;
    },

    // ------------------------------------------------------------ desenho

    render() {
      this.renderControls();
      this.renderBlocked();
      this.renderAccounts();
      this.renderLog();
    },

    /**
     * A lista de bloqueio, e o picker quando aberto.
     *
     * Fechado, mostra só o que está barrado — é a informação que o usuário
     * precisa conferir de relance, e a lista costuma ter poucas linhas. O
     * catálogo inteiro atrás de um botão, porque abri-lo custa uma varredura
     * de bolsa em todas as contas.
     */
    renderBlocked() {
      const host = document.getElementById('autosellBlocked');
      if (!host) return;

      const barrados = this.config.blocked || [];
      const nomes = new Map((this.picker && this.picker.items || []).map(i => [i.defId, i.name]));

      const atuais = barrados.length
        ? `<div class="lv-auto-chips">${barrados.map(defId => `
            <span class="lv-auto-chip">
              ${escape(nomes.get(defId) || defId)}
              <button type="button" data-role="unblock" data-id="${escape(defId)}"
                title="Voltar a permitir a venda deste item">✖</button>
            </span>`).join('')}</div>`
        : `<p class="hint">Nada bloqueado. Todo tesouro da bolsa pode ser anunciado.</p>`;

      host.innerHTML = `
        <p class="hint">Itens que o launcher <b>nunca</b> anuncia, em <b>todas</b> as contas. É aqui que entra o
          que você está guardando para forjar: pelas regras de preço, material de imbuição caro é justamente o
          melhor candidato a ser vendido.</p>
        ${atuais}
        <div class="lv-auto-pick-acoes">
          <button type="button" data-role="pick-open" ${this.picker && this.picker.busy ? 'disabled' : ''}>${
        this.picker ? 'Fechar a lista' : 'Escolher da bolsa…'}</button>
        </div>
        ${this.picker ? this.pickerHtml() : ''}`;
    },

    /** O picker aberto: o que as contas têm e que o auto-anunciar venderia. */
    pickerHtml() {
      const p = this.picker;
      if (p.busy) return `<p class="hint">Lendo a bolsa das contas…</p>`;
      if (p.errorCode) {
        return `<p class="hint is-warn">Não foi possível ler: ${escape(MOTIVOS[p.errorCode] || p.errorCode)}</p>`;
      }
      if (!p.items.length) {
        return `<p class="hint">Nenhuma conta em modo monitor tem tesouro na bolsa agora.</p>`;
      }

      const barrados = new Set(this.config.blocked || []);
      const busca = (p.search || '').trim().toLowerCase();
      const visiveis = busca
        ? p.items.filter(i => i.name.toLowerCase().includes(busca) || i.defId.toLowerCase().includes(busca))
        : p.items;

      return `
        <label class="xp-interval">
          <span>Procurar</span>
          <input type="search" data-role="pick-search" value="${escape(p.search || '')}" placeholder="nome do item">
        </label>
        <table class="xp-table lv-auto-pick">
          <thead>
            <tr>
              <th class="xp-th-on" title="Marcado = nunca vender">Bloquear</th>
              <th>Item</th>
              <th title="Somando todas as contas em modo monitor">Na bolsa</th>
              <th title="Em quantas contas">Contas</th>
            </tr>
          </thead>
          <tbody>
            ${visiveis.map(i => `
              <tr>
                <td class="xp-th-on">
                  <input type="checkbox" data-block="${escape(i.defId)}" ${barrados.has(i.defId) ? 'checked' : ''}>
                </td>
                <td class="xp-name">${escape(i.name)}${
        i.levels && i.levels.length ? ` <span class="xp-at">nv ${i.levels.join(', ')}</span>` : ''}</td>
                <td class="xp-num" title="${cheio(i.qty)}">${curtoQtd(i.qty)}</td>
                <td class="xp-num">${i.accounts}</td>
              </tr>`).join('')}
          </tbody>
        </table>
        ${visiveis.length === p.items.length ? '' :
        `<p class="hint">${visiveis.length} de ${p.items.length} itens.</p>`}`;
    },

    /** Abre ou fecha o picker. Abrir lê a bolsa; fechar não relê nada. */
    async togglePicker() {
      if (this.picker) { this.picker = null; this.renderBlocked(); return; }

      this.picker = { busy: true, items: [], search: '' };
      this.renderBlocked();

      const res = await this.api.autosellCandidates().catch(e => ({ errorCode: e && e.message }));
      this.picker = {
        busy: false,
        items: (res && res.items) || [],
        errorCode: (res && res.errorCode) || '',
        search: ''
      };
      this.renderBlocked();
    },

    /**
     * Marca ou desmarca um item.
     *
     * Só a seção do bloqueio é redesenhada, não a tela inteira: repintar os
     * controles tiraria o cursor do campo de busca do picker no meio de uma
     * sequência de cliques.
     */
    async setBlocked(defId, blocked) {
      const res = await this.api.autosellBlock({ defId, blocked })
        .catch(e => ({ ok: false, error: e && e.message }));
      if (!res || !res.ok) {
        this.say('Não foi possível salvar: ' + ((res && res.error) || 'erro'), true);
        return;
      }
      this.config = res.config;
      this.renderBlocked();
      const n = (this.config.blocked || []).length;
      this.say(blocked
        ? `Bloqueado. ${n} ${n === 1 ? 'item nunca será anunciado' : 'itens nunca serão anunciados'}.`
        : 'Desbloqueado: este item volta a poder ser anunciado.');
    },

    renderControls() {
      const host = document.getElementById('autosellControls');
      if (!host) return;

      const minutos = Math.round((this.config.intervalMs || 600000) / 60000);
      const min = Math.round((this.limits.minIntervalMs || 60000) / 60000);
      const max = Math.round((this.limits.maxIntervalMs || 21600000) / 60000);

      const modo = this.config.priceMode === 'average' ? 'average' : 'rival';
      const media = modo === 'average';
      const diamante = this.config.currency === 'diamond';

      host.innerHTML = `
        <label class="xp-master">
          <input type="checkbox" id="autosellEnabled" ${this.config.enabled ? 'checked' : ''}>
          <span>Ligar o auto-anunciar</span>
        </label>
        <label class="xp-interval" title="Com que frequência o launcher confere as vagas de anúncio de cada conta.">
          <span>Rodar a cada</span>
          <input type="number" id="autosellInterval" min="${min}" max="${max}" step="1" value="${minutos}">
          <span>min</span>
        </label>
        <label class="xp-interval"
          title="Quantos itens cada rodada pode anunciar, no máximo. Teto baixo limita o estrago de um erro de preço ao que caiba no relatório.">
          <span>No máximo</span>
          <input type="number" id="autosellMaxPerRound" min="1" max="${this.limits.maxPerRoundCap || 10}" step="1"
            value="${Math.floor(this.config.maxPerRound) || 2}">
          <span>itens por rodada</span>
        </label>
        <label class="xp-interval"
          title="Como o preço é decidido. Pelo rival persegue a venda rápida e acompanha o mercado; pela média afirma o preço que o item vem fazendo e espera o comprador.">
          <span>Preço</span>
          <select id="autosellPriceMode">
            <option value="rival" ${modo === 'rival' ? 'selected' : ''}>abaixo do rival mais barato</option>
            <option value="average" ${modo === 'average' ? 'selected' : ''}>pela média do item</option>
          </select>
        </label>
        <label class="xp-interval"
          title="Em que moeda anunciar. Em diamante o preço sai das vendas em diamante do nível exato; quando não houver nenhuma, é convertido pela cotação do câmbio.">
          <span>Moeda</span>
          <select id="autosellCurrency">
            <option value="gold" ${diamante ? '' : 'selected'}>ouro 🪙</option>
            <option value="diamond" ${diamante ? 'selected' : ''}>diamante 💎</option>
          </select>
        </label>
        <label class="xp-interval${media ? ' is-off' : ''}"
          title="${media
            ? 'Só vale no modo “abaixo do rival”: pela média não há rival na conta, e um piso proporcional à própria média não decidiria nada.'
            : 'Piso de preço, em por cento da mediana. Se o anúncio rival mais barato estiver abaixo disso, o item NÃO é anunciado: alguém despejando estoque não pode definir o seu preço.'}">
          <span>Nunca abaixo de</span>
          <input type="number" id="autosellFloorPct" min="10" max="200" step="1"
            value="${Math.floor(this.config.floorPct) || 70}" ${media ? 'disabled' : ''}>
          <span>% da mediana</span>
        </label>
        <label class="xp-interval${media ? ' is-off' : ''}"
          title="${media
            ? 'Só vale no modo “abaixo do rival”: pela média o preço não é descontado de ninguém.'
            : 'Quanto abaixo do rival mais barato anunciar. Um ouro basta para ficar na frente na ordenação por preço; zero empata com ele.'}">
          <span>Anunciar</span>
          <input type="number" id="autosellUndercut" min="0" max="1000000" step="1"
            value="${Math.floor(this.config.undercut) || 0}" ${media ? 'disabled' : ''}>
          <span>${diamante ? 'de diamante' : 'de ouro'} abaixo do rival</span>
        </label>
        <label class="xp-interval"
          title="Lote que valha menos que isto não ocupa uma vaga de anúncio. Sempre em ouro, mesmo anunciando em diamante: é um valor de referência, e em diamante nenhum lote chegaria perto deste número na própria moeda. Zero aceita qualquer valor.">
          <span>Ignorar lote abaixo de</span>
          <input type="number" id="autosellMinGold" min="0" step="1000"
            value="${Math.floor(this.config.minGold) || 0}">
          <span>de ouro</span>
        </label>
        <label class="xp-master"
          title="Recolhe do correio o ouro das vendas e os itens de anúncio expirado. Só entradas de mercado: recompensa de evento e de boss ficam onde estão.">
          <input type="checkbox" id="autosellClaimMail" ${this.config.claimMail ? 'checked' : ''}>
          <span>Recolher as vendas do correio</span>
        </label>
        ${diamante ? this.rateHintHtml() : ''}
        ${this.catalogReady ? '' : `
          <p class="hint is-warn">O catálogo do jogo ainda não foi lido nesta execução. Sem ele o launcher não
            distingue tesouro de equipamento, e <b>nada é anunciado</b> — ligue o monitor em uma conta e aguarde o
            primeiro login.</p>`}`;
    },

    /**
     * A cotação que converte ouro em diamante, à vista.
     *
     * Existe porque o preço em diamante de um item sem histórico em diamante é
     * uma divisão por este número, e um anúncio é irreversível. Esconder a
     * taxa deixaria o usuário aprovando uma conversão que ele não pode
     * conferir — e ela vem de um mercado volátil, não de uma tabela.
     */
    rateHintHtml() {
      const r = this.rate || {};
      const taxa = Math.floor(Number(r.rate) || 0);
      if (!taxa) {
        return `<p class="hint is-warn">💎 O banco não tem vendas de câmbio suficientes para calcular uma
          cotação. Itens <b>com</b> histórico de venda em diamante continuam sendo anunciados pelo preço
          daquelas vendas; os outros são recusados com
          <code>price.noRate</code> em vez de converter por um palpite.</p>`;
      }
      return `<p class="hint">💎 Convertendo a <b>${cheio(taxa)}</b> de ouro por diamante${
        r.samples ? `, mediana de ${r.samples} venda${r.samples === 1 ? '' : 's'} de câmbio` : ''}${
        r.days ? ` nos últimos ${r.days} dias` : ''}. Item que saia abaixo de
        <b>3 diamantes</b> não é anunciado: o arredondamento distorceria o preço mais que a margem.
        Quando o item já tem venda em diamante no nível exato, o preço vem dela e esta taxa não entra.</p>`;
    },

    renderAccounts() {
      const host = document.getElementById('autosellAccounts');
      if (!host) return;

      if (!this.accounts.length) {
        host.innerHTML = '<p class="hint">Nenhuma conta configurada.</p>';
        return;
      }

      const excluidas = new Set((this.config.excluded || []).map(Number));
      const linhas = this.accounts.map(conta => {
        const nome = conta.name || conta.username || `Conta ${conta.index + 1}`;
        const anunciados = this.log.filter(l => l.account === conta.index && l.action === 'list').length;
        const recolhido = this.log
          .filter(l => l.account === conta.index && l.action === 'claim')
          .reduce((soma, l) => soma + (Number(l.gold) || 0), 0);
        return `
          <tr data-index="${conta.index}">
            <td class="xp-th-on">
              <input type="checkbox" data-account="${conta.index}"
                ${excluidas.has(conta.index) ? '' : 'checked'}
                title="Desmarcar deixa esta conta de fora do auto-anunciar">
            </td>
            <td class="xp-name">
              <span class="xp-dot ${conta.connected ? 'is-on' : ''}"></span>
              ${escape(nome)}
            </td>
            ${conta.connected
              ? `<td class="xp-num">${anunciados || '—'}</td>
                 <td class="xp-num" title="${cheio(recolhido)} de ouro">${recolhido ? ouro(recolhido) : '—'}</td>`
              : '<td colspan="2" class="xp-off">monitor desligado</td>'}
          </tr>`;
      }).join('');

      host.innerHTML = `
        <table class="xp-table">
          <thead>
            <tr>
              <th class="xp-th-on">Ligada</th>
              <th>Conta</th>
              <th>Anunciados</th>
              <th>Ouro recolhido</th>
            </tr>
          </thead>
          <tbody>${linhas}</tbody>
        </table>`;
    },

    renderLog() {
      const host = document.getElementById('autosellLog');
      if (!host) return;
      if (!this.log.length) {
        host.innerHTML = '<p class="hint">Nenhuma rodada ainda. O relatório sobrevive ao fechamento do launcher.</p>';
        return;
      }
      host.innerHTML = this.log.map(linha => this.lineHtml(linha)).join('');
    },

    /**
     * Uma linha do relatório.
     *
     * As quatro ações dizem coisas diferentes e por isso não compartilham
     * formato: `list` precisa dos números do preço, `claim` do ouro que entrou,
     * `fail` do código que o servidor devolveu, e `none` do resumo das recusas
     * — que é o que explica uma rodada que parece não ter feito nada.
     */
    lineHtml(linha) {
      const conta = `Conta ${(Number(linha.account) || 0) + 1}`;
      const hora = relogio(linha.atMs);
      const envelope = (classe, html) => `
        <div class="xp-line ${classe}">
          <span class="xp-time">${hora}</span>
          <span class="xp-line-acc">${conta}</span>
          <span class="xp-line-text">${html}</span>
        </div>`;

      if (linha.action === 'list') {
        const from = linha.from || {};
        const nome = escape(linha.name || linha.defId || 'item');
        const lote = Number(linha.quantity) > 1 ? ` ×${linha.quantity}` : '';
        const nivel = linha.level ? ` <span class="xp-at">nv ${linha.level}</span>` : '';
        const dia = (linha.currency || from.currency) === 'diamond';
        const simbolo = dia ? '💎' : '🪙';
        // A conta do preço vai à vista, não no `title`: é a razão de ser do
        // relatório, e escondê-la num tooltip faria a auditoria depender de
        // passar o mouse em cada linha.
        const base = [
          // No modo média a mediana e o rival não decidiram nada; mostrá-los do
          // mesmo jeito sugeriria que o preço saiu deles.
          from.mode === 'average'
            ? (from.average ? `média ${ouro(from.average)}` : '')
            : [
              from.median ? `mediana ${ouro(from.median)}` : '',
              from.rival ? `rival ${ouro(from.rival)}` : 'sem rival',
              from.floor ? `piso ${ouro(from.floor)}` : ''
            ].filter(Boolean).join(' · '),
          from.samples ? `${from.samples} venda${from.samples === 1 ? '' : 's'}` : '',
          // A conversão, quando houve. Sem a taxa e o valor em ouro não há
          // como julgar depois se o preço em diamante foi justo.
          from.rate ? `convertido a ${ouro(from.rate)}/💎 de ${ouro(from.goldPrice)} 🪙` : '',
          // A aproximação de encanto é dita em voz alta: o preço é do nível
          // certo, mas de encantos misturados.
          from.enchantApprox ? 'encanto aproximado' : ''
        ].filter(Boolean).join(' · ');
        return envelope('', `
          <span class="xp-boss-ok">✔ ${nome}${lote}${nivel}</span>
          <b title="${cheio(linha.total)} ${dia ? 'de diamante' : 'de ouro'} no lote">${ouro(linha.total)} ${simbolo}</b>
          <span class="xp-at" title="unitário ${cheio(linha.unitPrice)}">(${ouro(linha.unitPrice)} cada)</span>
          <span class="xp-at">${escape(base)}</span>`);
      }

      if (linha.action === 'claim') {
        const itens = Number(linha.count) || 0;
        return envelope('', `
          <span class="xp-at">📬 ${itens} entrada${itens === 1 ? '' : 's'} do correio</span>
          ${linha.gold ? `<b title="${cheio(linha.gold)} de ouro">+${ouro(linha.gold)}</b>` : ''}`);
      }

      if (linha.action === 'fail') {
        const nome = escape(linha.name || linha.defId || 'item');
        const motivo = MOTIVOS[linha.error] || linha.error || 'recusado';
        return envelope('is-err', `
          <span class="xp-boss-fail" title="${escape(linha.error || '')}">✖ ${nome}</span>
          <span class="xp-at">${escape(motivo)}</span>`);
      }

      if (linha.action === 'skip') {
        const motivo = MOTIVOS[linha.reason] || linha.reason || 'pulada';
        return envelope('is-err', `<span class="xp-boss-fail">${escape(motivo)}</span>`);
      }

      // `none`: nada foi anunciado, com o resumo do porquê. É a linha mais
      // útil do relatório num inventário em que o auto-anunciar não acha nada.
      const motivos = Object.entries(linha.skipped || {})
        .sort((a, b) => b[1] - a[1])
        .map(([chave, n]) => `<span class="xp-at" title="${escape(chave)}">${n} ${escape(MOTIVOS[chave] || chave)}</span>`)
        .join(' · ');
      return envelope('', `<span class="xp-at">nada anunciado</span> ${motivos}`);
    },

    // ------------------------------------------------------------ eventos

    wire() {
      const host = document.getElementById('autosellControls');
      if (host) {
        // `change`, não `input`: salvar a cada tecla do campo de piso mandaria
        // um piso de "7" no caminho para "70", e esse valor intermediário vale
        // uma rodada se o laço rodar no instante errado.
        host.onchange = () => this.save();
      }

      const accounts = document.getElementById('autosellAccounts');
      if (accounts) {
        // Delegado: a tabela é redesenhada a cada leitura, e um ouvinte por
        // caixinha morreria junto com ela.
        accounts.onchange = e => {
          if (e.target.dataset && e.target.dataset.account !== undefined) this.save();
        };
      }

      // A seção do bloqueio é redesenhada inteira a cada clique, então tudo
      // aqui é delegado: um ouvinte por caixinha morreria junto com a tabela.
      const bloqueio = document.getElementById('autosellBlocked');
      if (bloqueio) {
        bloqueio.onclick = e => {
          const botao = e.target.closest && e.target.closest('[data-role]');
          const role = botao && botao.dataset.role;
          if (role === 'pick-open') { this.togglePicker(); return; }
          if (role === 'unblock') this.setBlocked(botao.dataset.id, false);
        };
        bloqueio.onchange = e => {
          const alvo = e.target;
          if (!alvo || !alvo.dataset) return;
          if (alvo.dataset.block !== undefined) {
            this.setBlocked(alvo.dataset.block, !!alvo.checked);
            return;
          }
          if (alvo.dataset.role === 'pick-search' && this.picker) {
            this.picker.search = alvo.value;
            this.renderBlocked();
          }
        };
        // `input` no campo de busca: filtrar só ao sair do campo faria a lista
        // parecer travada. O foco é devolvido depois da repintura.
        bloqueio.oninput = e => {
          const alvo = e.target;
          if (!alvo || !alvo.dataset || alvo.dataset.role !== 'pick-search' || !this.picker) return;
          this.picker.search = alvo.value;
          const pos = alvo.selectionStart;
          this.renderBlocked();
          const novo = bloqueio.querySelector('[data-role="pick-search"]');
          if (novo) { novo.focus(); novo.setSelectionRange(pos, pos); }
        };
      }

      const poll = document.getElementById('autosellPoll');
      if (poll) poll.onclick = () => this.poll();

      const clear = document.getElementById('autosellClear');
      if (clear) clear.onclick = () => this.clear();
    },

    /**
     * Lê a tela. Números crus de propósito: o domínio normaliza.
     *
     * A lista de contas excluídas é derivada das caixinhas **desmarcadas**,
     * nunca uma lista de permissões — assim uma conta nova participa por
     * padrão, como na expedição e no boss.
     */
    collect() {
      const valor = (id, fallback) => {
        const el = document.getElementById(id);
        const n = Number(el && el.value);
        return Number.isFinite(n) ? n : fallback;
      };
      const marcado = id => {
        const el = document.getElementById(id);
        return !!(el && el.checked);
      };
      const escolha = (id, fallback) => {
        const el = document.getElementById(id);
        return (el && el.value) || fallback;
      };

      const excluded = [];
      for (const caixa of document.querySelectorAll('[data-account]')) {
        if (!caixa.checked) excluded.push(Number(caixa.dataset.account));
      }

      return {
        enabled: marcado('autosellEnabled'),
        intervalMs: valor('autosellInterval', 10) * 60000,
        maxPerRound: valor('autosellMaxPerRound', 2),
        priceMode: escolha('autosellPriceMode', 'rival'),
        currency: escolha('autosellCurrency', 'gold'),
        // Lidos mesmo quando desabilitados: um `<input disabled>` conserva o
        // `value`, e `valor()` o devolve. Se viessem do fallback, trocar para
        // o modo média e voltar apagaria o piso que o usuário tinha ajustado.
        floorPct: valor('autosellFloorPct', 70),
        undercut: valor('autosellUndercut', 1),
        minGold: valor('autosellMinGold', 0),
        claimMail: marcado('autosellClaimMail'),
        excluded,
        // Vem do estado, não da tela: o picker pode estar fechado, e omitir a
        // lista aqui a apagaria a cada ajuste de piso de preço — desbloqueando
        // em silêncio tudo o que o usuário tinha protegido.
        blocked: this.config.blocked || []
      };
    },

    async save() {
      if (this.busy) return;
      this.busy = true;
      const res = await this.api.autosellSet(this.collect()).catch(e => ({ error: e.message }));
      this.busy = false;

      if (!res || res.error || !res.ok) {
        this.say('Falha ao salvar: ' + ((res && res.error) || 'desconhecida'), true);
        return;
      }

      this.apply(res);
      this.render();

      const fora = (this.config.excluded || []).length;
      const moeda = this.config.currency === 'diamond' ? 'em diamante' : 'em ouro';
      // O critério de preço entra na confirmação porque é o que muda o
      // resultado: "até 2 itens por rodada" é igual nos dois modos, e saber
      // qual está no ar é a única forma de perceber uma troca sem intenção.
      const criterio = this.config.priceMode === 'average'
        ? 'pela média do item'
        : `nunca abaixo de ${this.config.floorPct}% da mediana`;
      this.say(this.config.enabled
        ? `Salvo. Anunciando até ${this.config.maxPerRound} ${this.config.maxPerRound === 1 ? 'item' : 'itens'} por rodada ${moeda}, ${criterio}${fora ? `, ${fora} conta${fora === 1 ? '' : 's'} de fora` : ''}.`
        : 'Salvo. O auto-anunciar está desligado.');
    },

    async poll() {
      const botao = document.getElementById('autosellPoll');
      if (botao) botao.disabled = true;
      this.say('Rodando em todas as contas…');

      const res = await this.api.autosellPoll().catch(e => ({ error: e.message }));
      if (botao) botao.disabled = false;

      if (!res || res.error) {
        this.say('Falha ao rodar: ' + ((res && res.error) || 'desconhecida'), true);
        return;
      }
      this.apply(res);
      this.render();

      const n = Number(res.listed) || 0;
      const erro = this.stats && this.stats.lastError;
      this.say(n
        ? `${n} ${n === 1 ? 'item anunciado' : 'itens anunciados'}.`
        : `Nada anunciado${erro ? `: ${MOTIVOS[erro] || erro}` : '. Veja os motivos no relatório.'}`,
      !n && !!erro);
    },

    async clear() {
      const res = await this.api.autosellLogClear().catch(e => ({ error: e.message }));
      if (!res || res.error) {
        this.say('Falha ao limpar: ' + ((res && res.error) || 'desconhecida'), true);
        return;
      }
      this.log = [];
      this.renderAccounts();
      this.renderLog();
      this.say('Relatório limpo. Os anúncios já criados continuam no mercado.');
    },

    /**
     * Uma linha nova chegou do processo principal.
     *
     * A linha vem pronta no evento, então não há outra travessia de IPC: o
     * relatório cresce no topo e as contagens por conta acompanham.
     */
    report(data) {
      if (!data || !data.entry) return;
      this.log.unshift(data.entry);
      if (this.log.length > 300) this.log.length = 300;
      if (data.stats) this.stats = data.stats;
      this.renderAccounts();
      this.renderLog();
    },

    say(text, isError) {
      const bar = document.getElementById('autosellStatusBar');
      if (!bar) return;
      bar.textContent = text;
      bar.classList.toggle('is-error', !!isError);
    }
  };

  if (typeof window !== 'undefined') window.PioAutosell = PioAutosell;
  if (typeof module !== 'undefined' && module.exports) module.exports = PioAutosell;
})();

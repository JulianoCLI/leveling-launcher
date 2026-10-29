/**
 * @file leveling-market-ui.js
 * Tela de preços do mercado: quanto cada item está vendendo de verdade.
 *
 * Existe porque o servidor não guarda isso para o jogador. O feed de vendas
 * (`market_request{history}`) devolve 100 linhas cobrindo cerca de meia hora,
 * sem paginação e sem filtro — passou disso, acabou. O launcher lê esse feed
 * de minuto em minuto e acumula num banco local, e é esse banco que esta tela
 * mostra. O histórico aqui vale tanto quanto o tempo que o launcher ficou
 * ligado: no primeiro dia é curto, depois de um mês é algo que nenhum jogador
 * consegue ver no jogo.
 *
 * Três visões, porque são três perguntas diferentes:
 *
 *   Itens    uma linha por item, com média, mediana, mínimo, máximo e o
 *            último preço. É a visão de "quanto vale", e é a que abre.
 *   Ao vivo  as vendas em ordem de chegada. É a visão de "o que está
 *            acontecendo agora", e serve para ver se um preço é tendência ou
 *            foi um caso isolado.
 *   Detalhe  um item só, com a série de preço por dia e as vendas que a
 *            formaram, mais o que o servidor diz sobre ele.
 *
 * Média **e** mediana juntas não é redundância. O mercado tem vendas de 1 de
 * ouro ao lado de vendas de milhões no mesmo item (medido: `luvas-arqueiro`
 * com média 232.646 e mediana 35.000). A média sozinha mente; a distância
 * entre as duas é a informação de que o item tem preço instável.
 *
 * O `price_hint` do servidor aparece no detalhe, junto do número local, em vez
 * de substituí-lo: ele cobre 30 ou 90 dias que o banco não tem, mas é um
 * número só, sem as vendas por trás. Os dois lado a lado dizem mais do que
 * qualquer um sozinho.
 */

(() => {
  'use strict';

  /** Janelas de tempo. 0 é tudo o que o banco tem. */
  const PERIODOS = [
    { days: 1, label: '24 h' },
    { days: 7, label: '7 dias' },
    { days: 30, label: '30 dias' },
    { days: 0, label: 'tudo' }
  ];

  const ORDENS = [
    { id: 'vendas', label: 'Mais vendidos' },
    { id: 'recente', label: 'Vendidos agora' },
    { id: 'volume', label: 'Maior volume' },
    { id: 'preco-desc', label: 'Mais caros' },
    { id: 'preco-asc', label: 'Mais baratos' },
    { id: 'nome', label: 'Nome' }
  ];

  const escape = text => String(text == null ? '' : text).replace(/[&<>"]/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]
  ));

  /**
   * Preços de jogo chegam a bilhões. Mostrar o número cheio em toda célula
   * torna a tabela ilegível justamente onde ela precisa ser comparada de
   * relance; o valor exato fica no `title`.
   */
  const curto = v => {
    const n = Math.round(Number(v) || 0);
    if (n >= 1e9) return (n / 1e9).toFixed(n >= 1e10 ? 0 : 1).replace('.', ',') + ' B';
    if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1).replace('.', ',') + ' M';
    if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e4 ? 0 : 1).replace('.', ',') + ' k';
    return String(n);
  };

  const cheio = v => Math.round(Number(v) || 0).toLocaleString('pt-BR');

  /** Hora do dia para vendas recentes, data para as antigas. */
  const quando = ms => {
    const n = Number(ms);
    if (!Number.isFinite(n) || n <= 0) return '—';
    const d = new Date(n);
    const idade = Date.now() - n;
    if (idade < 86400000) return d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
  };

  const decorrido = ms => {
    const n = Date.now() - (Number(ms) || 0);
    if (!Number.isFinite(n) || n < 0) return '—';
    const min = Math.floor(n / 60000);
    if (min < 1) return 'agora';
    if (min < 60) return `${min} min`;
    const h = Math.floor(min / 60);
    if (h < 24) return `${h} h`;
    return `${Math.floor(h / 24)} d`;
  };

  /** Quanto falta até um instante futuro. Oposto de `decorrido`. */
  const restante = ms => {
    const n = (Number(ms) || 0) - Date.now();
    if (n <= 0) return 'expirado';
    const min = Math.floor(n / 60000);
    if (min < 60) return `${min} min`;
    const h = Math.floor(min / 60);
    if (h < 24) return `${h} h`;
    return `${Math.floor(h / 24)} d`;
  };

  const moeda = c => (String(c || '').includes('DIAMOND') ? '💎' : '🪙');

  /**
   * Preço por unidade de um anúncio à venda.
   *
   * Em `MARKET_KIND_EXCHANGE` o servidor repete o preço do lote em
   * `unit_price` — medido: um pacote de 10 diamantes por 3.780.000 chega com
   * `unit_price` e `total` iguais. O mesmo conserto que `leveling-market-db`
   * faz nas vendas gravadas, aqui para os anúncios abertos, que não passam
   * pelo banco.
   */
  const unitPedido = l => {
    const unit = Number(l && l.unit_price) || 0;
    const cambio = String((l && l.kind) || '').endsWith('_EXCHANGE')
      || String((l && l.def_id) || '').startsWith('cambio:');
    if (!cambio) return unit;
    const total = Number(l.total) || 0;
    const qty = Number(l.quantity) || 0;
    if (total <= 0 || qty <= 1) return unit;
    return Math.max(1, Math.round(total / qty));
  };

  /**
   * Desconto do teto sugerido ao criar uma regra de sniper a partir do item.
   *
   * Espelha `SNIPE_DISCOUNT` de `leveling-sniper.js`, onde a regra é testada;
   * a cópia existe porque este arquivo é script de navegador e não tem
   * `require`. O cálculo real da regra gravada é o do domínio — aqui ele só
   * preenche o campo que o usuário vai conferir.
   */
  const SNIPE_DESCONTO = 0.2;

  /**
   * Ordens da aba Anunciar.
   *
   * "Valor do lote" é o padrão porque é a pergunta da aba: num inventário de
   * 300 peças o valor está concentrado em poucas, e a ordem de aquisição
   * esconderia justamente as que compensam anunciar. "Unitário" existe
   * porque um lote caro de item barato e uma peça cara pedem decisões
   * diferentes.
   */
  const ORDENS_ANUNCIO = [
    { id: 'valor', label: 'valor do lote' },
    { id: 'unidade', label: 'valor unitário' },
    { id: 'nivel', label: 'nível' },
    { id: 'qtd', label: 'quantidade' },
    { id: 'nome', label: 'nome' }
  ];

  /** Recusas de anúncio do servidor, em português. O código cru fica à vista. */
  const ERROS_ANUNCIO = {
    'market.limit': 'limite de anúncios atingido',
    'market.locked': 'o item está trancado no jogo',
    'market.equipped': 'o item está vestido',
    'market.notFound': 'o item não estava mais no inventário',
    'market.priceMax': 'acima do preço máximo do servidor',
    'market.quantity': 'quantidade recusada',
    'inv.offline': 'a conta saiu do modo monitor'
  };

  /** Rótulos dos atributos base, para a ficha do item. */
  const STATS = {
    atk: 'ATQ', def: 'DEF', hp: 'HP', mp: 'MP', crit: 'Crít.',
    crit_dmg: 'Dano crít.', speed: 'Vel.', eva: 'Esquiva', acc: 'Precisão'
  };

  const PioMarket = {
    api: null,
    view: 'items',
    /** Item aberto na visão de detalhe. */
    defId: '',
    query: { days: 7, sort: 'vendas', category: 'todos', search: '', limit: 150 },
    data: { items: [], total: 0, stats: null, categories: [], sales: [], item: null, hint: null },
    /**
     * Ícones, cores de raridade e sprites de monstro, recortados do catálogo
     * do jogo. Começa vazio e nunca é esperado: a tabela pinta com o que tem,
     * e repinta sozinha quando o catálogo chega. Sem isso a tela ficaria
     * travada atrás de um login que pode não acontecer.
     */
    catalog: { items: {}, rarities: {}, shadowRanks: {}, monsters: {}, origin: '' },
    /** Anúncios à venda agora, por `def_id`. Só a ficha vem daqui. */
    listings: [],
    /**
     * Preço por nível do item aberto. Vazio não significa "não varia por
     * nível": significa que o nível dessas vendas ainda não foi descoberto —
     * o enriquecedor pergunta anúncio por anúncio, em segundo plano.
     */
    levels: { levels: [], coverage: null },
    /**
     * Nível por `listing_id`, para o ao vivo. Acumula entre repinturas: a
     * resposta já paga não precisa ser pedida outra vez quando o feed traz
     * vendas novas.
     */
    saleLevels: {},
    /**
     * Quem tem cada item, por `def_id`. Pedido depois da tabela já estar
     * pintada: depende das contas conectadas e de ida ao servidor, e a tela
     * não pode ficar esperando isso para mostrar preço.
     */
    owners: { byDef: {}, accounts: [], offline: [], readAtMs: 0 },
    /** Houve tentativa de ler as posses desta página? Separa "0" de "não sei". */
    ownersAsked: false,
    loading: false,
    /** Evita refazer a consulta a cada tecla digitada na busca. */
    searchTimer: null,
    /** Assinatura da barra de filtros já montada; ver `render`. */
    barSig: '',
    /**
     * Inventário completo das contas, para a aba "Minha bolsa". Vem de uma
     * varredura (4 páginas por conta, ~107 ms medidos), não do filtro por
     * def_ids: aqui a pergunta é "o que eu tenho", sem lista prévia.
     */
    bolsa: null,
    /**
     * Equipamento aparece na bolsa? Desligado por padrão: a pergunta da aba
     * é "quanto posso lucrar", e o que está vestido não está à venda. A
     * caixa existe porque às vezes a resposta é vender a armadura mesmo.
     */
    showEquip: false,
    /**
     * Conta filtrada na bolsa. `null` = todas.
     *
     * Peneira local sobre `bolsa`, que já traz todas as contas: a varredura
     * custa quatro páginas por conta, e refazê-la a cada troca de seletor
     * pagaria o preço de ler as outras sete para mostrar uma.
     */
    bolsaConta: null,
    /**
     * Aba "Meus anúncios": o que cada conta tem à venda e o que já vendeu.
     *
     * Duas fontes com honestidades diferentes, e a aba diz qual é qual: os
     * anúncios vêm do servidor e são a verdade do momento; as vendas vêm do
     * banco local e só existem a partir do primeiro dia de launcher aberto,
     * porque o servidor não guarda a lista das vendas de uma conta.
     */
    mine: null,
    /** Conta filtrada na aba de anúncios. `null` = todas. */
    mineConta: null,
    /** `ativos` ou `vendas`. São duas perguntas, e misturá-las confunde. */
    mineAba: 'ativos',
    /**
     * Regra de sniper em confirmação, criada a partir do item aberto.
     * `null` quando não há nenhuma — o botão só a abre.
     */
    snipe: null,

    /**
     * Aba "Anunciar". Uma conta por vez, e por instância de item.
     *
     * Diferente de `bolsa` em duas coisas que importam: ali o inventário é
     * agregado por `def_id` e varre todas as contas, aqui cada linha é um
     * `uid` de uma conta só. `MarketCreate.item_uid` identifica uma peça
     * específica, e duas espadas iguais com níveis diferentes valem preços
     * diferentes — o agregado não teria como distingui-las.
     */
    sell: {
      /** Índice da conta escolhida. `null` = nenhuma ainda. */
      account: null,
      /** Contas do launcher, para o seletor. Vem junto da varredura. */
      accounts: [],
      items: [],
      loading: false,
      error: '',
      /** Equipamento na lista? Mesma razão da bolsa, e também desligado. */
      showEquip: false,
      /**
       * Filtros da lista. Peneira local, não consulta: o inventário já está
       * todo na memória depois da varredura, e refazer a leitura da conta a
       * cada troca de categoria seria ida ao servidor para reordenar uma
       * lista que não mudou.
       */
      filter: {
        category: 'todos', slot: 'todos', rarity: 'todos', search: '', sort: 'valor',
        /** Só o que o automático não soube precificar — a fila de trabalho manual. */
        sem: false
      },
      /** `uid` → preço do pacote digitado. Só os marcados entram. */
      picked: new Map(),
      /** `uid` dos que estão em automático: o preço acompanha a sugestão. */
      auto: new Set(),
      /** Confirmação aberta: `null` ou o plano montado por `planListings`. */
      confirm: null,
      /** Resultado do último envio, linha a linha. */
      results: null,
      busy: false
    },

    init(api) {
      this.api = api || window.pokeAPI;
      if (this.api && this.api.onMarket) {
        // Entraram vendas novas. Só repinta se a tela está aberta: o coletor
        // roda o tempo todo, inclusive com o launcher na bandeja.
        //
        // E nunca no meio de um anúncio. O coletor avisa a cada minuto, e
        // `load()` na aba Anunciar relê o inventário da conta e descarta a
        // seleção, os preços digitados e a confirmação aberta — vinte itens
        // conferidos desapareciam porque alguém, em outro lugar do jogo,
        // vendeu alguma coisa. Vendas novas não alteram a lista do
        // inventário; só mudariam os preços sugeridos, e trocar uma sugestão
        // sob o olho de quem está confirmando é pior que mostrá-la um minuto
        // velha.
        this.api.onMarket(() => {
          if (!this.isOpen()) return;
          if (this.view === 'sell') return;
          this.load();
        });
      }
      if (this.api && this.api.onMarketCatalog) {
        // Chegou um login: as cores e ícones podem ter mudado de versão.
        this.api.onMarketCatalog(data => {
          if (data && data.catalog) this.applyCatalog(data.catalog);
          if (!this.isOpen()) return;
          // Mesmo cuidado do coletor, por um motivo mais estreito: o catálogo
          // chega quando uma conta loga, e isso pode acontecer no meio da
          // revisão. Ele só muda ícone e cor — nada que valha repintar por
          // cima de um preço sendo digitado.
          if (this.view === 'sell' && (this.sell.confirm || this.sell.picked.size)) return;
          this.render();
        });
      }
      this.loadCatalog();
      this.wire();
    },

    /**
     * Busca o recorte de aparência. Falha em silêncio de propósito: sem ele a
     * tela perde os ícones, não os preços, e preço é o que ela existe para
     * mostrar.
     */
    async loadCatalog() {
      if (!this.api || !this.api.marketCatalog) return;
      const res = await this.api.marketCatalog().catch(() => null);
      if (res && res.catalog) this.applyCatalog(res.catalog);
    },

    applyCatalog(cat) {
      this.catalog = {
        items: (cat && cat.items) || {},
        rarities: (cat && cat.rarities) || {},
        shadowRanks: (cat && cat.shadowRanks) || {},
        monsters: (cat && cat.monsters) || {},
        origin: (cat && cat.origin) || ''
      };
    },

    /**
     * Aparência de uma linha: ícone, cor e raridade.
     *
     * Sombra e item não se resolvem igual. Sombra não tem `def_id` de item —
     * o feed manda o nome do monstro nesse campo — e também não tem
     * raridade: o que a classifica é o rank, cuja cor vem de outro mapa. Por
     * isso o `kind` decide antes de qualquer busca.
     */
    look(row) {
      const id = String((row && row.def_id) || '');
      const sombra = String((row && row.kind) || '') === 'MARKET_KIND_SHADOW'
        || (row && row.category) === 'sombra';

      if (sombra) {
        const m = this.catalog.monsters[id];
        const rank = (row && row.shadow_rank) || '';
        const r = this.catalog.shadowRanks[rank];
        return {
          icon: (m && m.icon) || '',
          color: (r && r.color) || '',
          label: (r && r.name) || '',
          def: null
        };
      }

      const def = this.catalog.items[id] || null;
      const rarity = String((row && row.rarity) || (def && def.rarity) || '');
      const r = this.catalog.rarities[rarity];
      return {
        icon: (def && def.icon) || '',
        color: (r && r.color) || '',
        label: (r && r.name) || rarity,
        def
      };
    },

    /**
     * Célula do ícone. A imagem vem do servidor do jogo, que pode estar fora
     * do ar ou ter mudado de caminho; o `onerror` esconde o `<img>` quebrado
     * em vez de deixar o ícone de imagem partida em toda linha.
     *
     * O quadro fica mesmo sem imagem, pintado com a cor da raridade: a
     * coluna não muda de largura conforme o servidor responde ou não.
     */
    iconHtml(row) {
      const v = this.look(row);
      const cor = v.color ? ` style="--mk-cor:${escape(v.color)}"` : '';
      const src = v.icon ? this.catalog.origin + v.icon : '';
      return `<span class="mk-icon"${cor}>${
        // `width`/`height` declarados e `decoding="async"`: sem as dimensões
        // a imagem chega e muda a altura da linha, forçando o navegador a
        // refazer o layout da tabela no meio da rolagem; sem o `decoding` a
        // decodificação acontece na thread principal, no mesmo quadro.
        src ? `<img src="${escape(src)}" alt="" width="28" height="28" loading="lazy" decoding="async" onerror="this.remove()">` : ''
      }</span>`;
    },

    /** Nome pintado com a cor da raridade, como no jogo. */
    nameHtml(row, extra) {
      const v = this.look(row);
      const cor = v.color ? ` style="color:${escape(v.color)}"` : '';
      return `<b${cor}>${escape(row.name)}${extra || ''}</b>`;
    },

    /**
     * "nv. 2" ao lado do nome, no ao vivo.
     *
     * É a diferença entre "Topázio" e "Topázio nv. 2" — dois itens com o
     * mesmo nome vendidos, medido no banco real, por 4 128 300 e por 999. O
     * preço na mesma linha só é interpretável com isto ao lado.
     *
     * Três estados, e a distinção importa:
     *   - nada: o anúncio ainda não foi perguntado, ou não há conta em modo
     *     monitor para perguntar. Omitir é honesto; `nv. 0` não seria.
     *   - `nv. n`: o nível, como o jogo mostra.
     *   - nada também quando o nível é 0: câmbio e consumível não têm nível,
     *     e marcá-los diria que a informação falta quando ela não existe.
     */
    levelTagHtml(sale) {
      const d = this.saleLevels[String(sale && sale.listing_id)];
      if (!d || !(Number(d.level) > 0)) return '';
      return ` <span class="mk-nv">nv. ${Number(d.level)}</span>`;
    },

    /**
     * Linha de baixo do nome: moeda, categoria, raridade e o que o catálogo
     * souber do item — slot e atributos base. É o que responde "isto é uma
     * arma de quê" sem precisar abrir o detalhe.
     */
    subHtml(row) {
      const v = this.look(row);
      const partes = [escape(row.category || '')];
      if (v.label) partes.push(escape(v.label));
      if (v.def && v.def.slot) partes.push(escape(v.def.slot));
      if (row.shadow_level) partes.push(`nv ${row.shadow_level}`);
      if (row.shadow_power) partes.push(`${curto(row.shadow_power)} pd`);
      return `<small>${moeda(row.currency)} ${partes.filter(Boolean).join(' · ')}</small>`;
    },

    isOpen() {
      const overlay = document.getElementById('marketOverlay');
      return !!overlay && overlay.classList.contains('show');
    },

    wire() {
      const atualizar = document.getElementById('marketRefresh');
      if (atualizar) atualizar.onclick = () => this.pollNow();
    },

    async open() {
      this.view = 'items';
      this.defId = '';
      this.render();
      await this.load();
    },

    /** Lê o banco conforme a visão atual. Nunca lança: a tela mostra o erro. */
    async load() {
      if (!this.api) return;
      this.loading = true;
      this.paintStatus();
      try {
        if (this.view === 'detail' && this.defId) {
          const res = await this.api.marketItem(this.defId, { days: this.query.days, limit: 120 });
          this.data.item = (res && res.item) || null;
          // O número do servidor é pedido depois e não bloqueia a pintura: ele
          // depende de uma conta conectada, e a tela tem de abrir sem isso.
          this.data.hint = null;
          this.listings = [];
          this.levels = { levels: [], coverage: null };
          this.render();
          this.loadHint();
          this.loadListings();
          this.loadOwners([this.defId]);
          this.loadLevels();
          return;
        }
        if (this.view === 'bolsa') {
          // Varredura de inventário: a única visão que depende inteiramente
          // do servidor. Sem conta em modo monitor ela não tem o que mostrar,
          // e dizer isso é mais útil que uma tabela vazia.
          const res = this.api.marketBag
            ? await this.api.marketBag({ days: this.query.days }).catch(() => null)
            : null;
          this.bolsa = res || { contas: [], offline: [], precos: {}, errorCode: 'bag.failed' };
          return;
        }
        if (this.view === 'sell') {
          // Sem conta escolhida isto só traz a lista de contas para o
          // seletor: varrer uma conta por palpite seria tráfego para mostrar
          // o inventário errado, e a escolha é do usuário.
          await this.loadSellable();
          return;
        }
        if (this.view === 'mine') {
          // Todas as contas de uma vez, ao contrário de "Anunciar": a
          // pergunta é de acompanhamento, e respondê-la conta a conta faria o
          // usuário clicar oito vezes pela visão que ele já queria inteira.
          const res = this.api.marketMine
            ? await this.api.marketMine({ days: this.query.days }).catch(() => null)
            : null;
          this.mine = res || { contas: [], errorCode: 'mine.failed' };
          return;
        }
        if (this.view === 'live') {
          const res = await this.api.marketRecent({
            limit: 200, days: this.query.days,
            category: this.query.category, search: this.query.search
          });
          this.data.sales = (res && res.sales) || [];
        } else {
          const res = await this.api.marketSummary(this.query);
          this.data.items = (res && res.items) || [];
          this.data.total = (res && res.total) || 0;
          this.data.stats = (res && res.stats) || null;
          if (res && res.categories) this.data.categories = res.categories;
        }
      } catch (e) {
        this.erro = e && e.message || String(e);
      } finally {
        this.loading = false;
        this.render();
        // Depois da pintura, nunca antes: sombra fica de fora porque o
        // inventário é indexado por `def_id` de item e `def_id` de sombra é o
        // nome do monstro — não casaria com nada.
        // A bolsa já traz posse e preço juntos: perguntar de novo seria uma
        // segunda varredura para repetir o que acabou de chegar.
        if (this.view === 'bolsa' || this.view === 'sell' || this.view === 'mine') return;
        const visiveis = (this.view === 'live' ? this.data.sales : this.data.items)
          .filter(r => r.kind !== 'MARKET_KIND_SHADOW' && r.category !== 'sombra')
          .map(r => r.def_id);
        this.loadOwners(visiveis);
        // "Topázio" sozinho não diz nada: são quatro itens com esse nome. No
        // ao vivo a linha é uma venda, então o nível dela é o que falta para
        // o preço ao lado fazer sentido.
        if (this.view === 'live') this.loadSaleLevels(this.data.sales);
      }
    },

    /** Estatística do servidor para o item aberto. Falha em silêncio. */
    async loadHint() {
      if (!this.api || !this.api.marketHint || !this.defId) return;
      const alvo = this.defId;
      const hint = await this.api.marketHint(alvo, 30).catch(() => null);
      // O usuário pode ter trocado de item enquanto a resposta vinha.
      if (alvo !== this.defId) return;
      this.data.hint = hint && !hint.errorCode ? hint : null;
      if (this.view === 'detail') this.render();
    },

    /**
     * Quem tem os itens visíveis agora.
     *
     * Vem depois da pintura, e repinta quando chega. A alternativa — esperar
     * a resposta para mostrar a tabela — faria o preço, que é local e
     * instantâneo, ficar refém de oito sockets de rede.
     *
     * Falha em silêncio: sem conta conectada a coluna fica em "—", que é a
     * resposta honesta. Dizer "0" seria afirmar que não tenho o item.
     */
    async loadOwners(defIds) {
      if (!this.api || !this.api.marketOwners) return;
      const ids = [...new Set((defIds || []).filter(Boolean))];
      if (!ids.length) return;
      const marca = this.view + '|' + this.defId + '|' + ids.length;
      const res = await this.api.marketOwners(ids).catch(() => null);
      // A tela pode ter mudado de visão ou de item enquanto a resposta vinha.
      if (marca !== this.view + '|' + this.defId + '|' + ids.length) return;
      this.ownersAsked = true;
      if (res && !res.errorCode) this.owners = res;
      this.render();
    },

    /**
     * O nível de cada venda listada no ao vivo.
     *
     * Aqui o pedido é diferente de todos os outros desta tela: ele pode
     * causar tráfego. As vendas do ao vivo são as mais novas do banco, logo
     * as que o enriquecedor de fundo ainda não perguntou — e ele vai da mais
     * nova para a mais velha, mas com milhares de vendas atrasadas e 40 por
     * minuto de orçamento, "ele vai chegar" pode significar meia hora.
     * Perguntar pelos anúncios visíveis é o que põe o nível na tela aberta.
     *
     * O que já tem nível não é perguntado de novo: o banco responde de
     * memória e o pedido sai só para o que falta.
     *
     * Falha em silêncio. Sem conta em modo monitor não há a quem perguntar, e
     * a linha fica sem nível — que é a verdade, não um nível inventado.
     */
    async loadSaleLevels(vendas) {
      if (!this.api || !this.api.marketLevelsFor) return;
      const ids = [...new Set((vendas || [])
        .map(s => Number(s.listing_id))
        .filter(id => id > 0 && !this.saleLevels[String(id)]))];
      if (!ids.length) return;

      const marca = this.view;
      // Em lotes de 50, de cima para baixo. A aba mostra 200 vendas e o canal
      // aceita 100 por pedido, então um pedido só deixaria metade da tabela
      // sem nível — foi o que aconteceu quando medido. Lotes também fazem as
      // primeiras linhas, que são as que o usuário está lendo, aparecerem
      // antes de as últimas serem perguntadas.
      for (let i = 0; i < ids.length; i += 50) {
        const res = await this.api.marketLevelsFor(ids.slice(i, i + 50)).catch(() => null);
        // Trocou de aba no meio: o resto dos lotes é trabalho para ninguém.
        if (marca !== this.view) return;
        const vindos = (res && res.levels) || {};
        if (!Object.keys(vindos).length) continue;
        Object.assign(this.saleLevels, vindos);
        this.render();
      }
    },

    /**
     * Preço por nível. É leitura local do banco, mas vem depois da pintura
     * pelo mesmo princípio das outras: o preço geral já está na tela e não
     * precisa esperar por um detalhamento.
     */
    async loadLevels() {
      if (!this.api || !this.api.marketLevels || !this.defId) return;
      const alvo = this.defId;
      const res = await this.api.marketLevels(alvo, { days: this.query.days }).catch(() => null);
      if (alvo !== this.defId) return;
      this.levels = res || { levels: [], coverage: null };
      if (this.view === 'detail') this.render();
    },

    /** O que as minhas contas têm deste item, ou `null` se não foi lido. */
    ownedOf(defId) {
      if (!this.ownersAsked) return null;
      return this.owners.byDef[String(defId || '')] || { total: 0, equipped: 0, accounts: [] };
    },

    /**
     * Anúncios à venda agora deste item. É a única fonte de nível, potência e
     * qualidade: `MarketSale` não carrega nenhum dos três. Preço pedido não é
     * preço pago, então entram como ficha e não como estatística.
     *
     * Falha em silêncio: depende de uma conta conectada, e o histórico local
     * — que é o motivo da tela — não depende.
     */
    async loadListings() {
      if (!this.api || !this.api.marketListings || !this.defId) return;
      const alvo = this.defId;
      const it = this.data.item;
      const res = await this.api.marketListings({
        search: (it && it.name) || alvo,
        category: (it && it.category) || '',
        limit: 20
      }).catch(() => null);
      // O usuário pode ter trocado de item enquanto a resposta vinha.
      if (alvo !== this.defId) return;
      const lista = (res && !res.errorCode && res.listings) || [];
      // A busca é por nome e pode trazer vizinhos; só o item aberto interessa.
      this.listings = lista.filter(l => {
        const d = (l.item && l.item.def_id) || (l.shadow && l.shadow.monster_id) || '';
        return d === alvo || l.name === ((it && it.name) || alvo);
      });
      if (this.view === 'detail' && this.listings.length) this.render();
    },

    // ----------------------------------------------------------- anunciar

    /**
     * O inventário da conta escolhida, com o preço sugerido de cada peça.
     *
     * Chamada também sem conta escolhida — é assim que o seletor recebe a
     * lista de contas na primeira abertura, sem varrer inventário nenhum.
     */
    async loadSellable() {
      if (!this.api || !this.api.marketSellable) return;
      const alvo = this.sell.account;
      this.sell.loading = true;
      this.sell.error = '';
      this.render();

      const res = await this.api.marketSellable({ index: alvo, days: this.query.days })
        .catch(e => ({ errorCode: (e && e.message) || 'sellable.failed' }));

      // O usuário pode ter trocado de conta enquanto a varredura corria.
      if (alvo !== this.sell.account) return;

      this.sell.loading = false;
      if (res && res.accounts) this.sell.accounts = res.accounts;
      if (!res || res.errorCode) {
        this.sell.items = [];
        this.sell.error = (res && res.errorCode) || 'sellable.failed';
        this.render();
        return;
      }
      if (alvo === null) { this.render(); return; }
      this.sell.items = res.items || [];
      // Trocar de conta não pode carregar a seleção da anterior: os `uid` são
      // de outro inventário, e anunciar por eles falharia item a item sem
      // explicação.
      this.sell.picked = new Map();
      this.sell.auto = new Set();
      this.sell.confirm = null;
      this.sell.results = null;
      // Os filtros também: categoria e slot que existiam na conta anterior
      // podem não existir nesta, e um filtro por valor ausente esconderia o
      // inventário inteiro sem dizer por quê.
      this.sell.filter = {
        category: 'todos', slot: 'todos', rarity: 'todos', search: '', sort: 'valor', sem: false
      };
      this.render();
    },

    /**
     * Categoria, slot e raridade de uma peça, resolvidos pelo catálogo.
     *
     * O inventário manda `def_id` e a raridade da instância; categoria e slot
     * só existem no catálogo do jogo. Quando ele não chegou, tudo cai em
     * vazio — e os filtros, montados a partir destes mesmos valores, nem
     * oferecem a opção. A tela nunca filtra por um campo que não sabe ler.
     */
    sellFacets(it) {
      const def = this.catalog.items[it.defId] || {};
      return {
        category: String(it.category || def.category || ''),
        slot: String(def.slot || ''),
        rarity: String(it.rarity || def.rarity || '')
      };
    },

    /**
     * Os valores que existem de fato no inventário da conta, para os
     * seletores.
     *
     * Montados do que está carregado, não de uma lista fixa de categorias do
     * jogo: um seletor com trinta opções das quais três têm item é um
     * seletor que obriga a tentar e errar. Equipado entra na contagem quando
     * a caixa o revela, senão a opção some ao marcar a caixa.
     */
    sellFacetOptions() {
      const cats = new Set();
      const slots = new Set();
      const rars = new Set();
      for (const it of this.sell.items) {
        if (it.blocked && !(it.blocked === 'equipped' && this.sell.showEquip)) continue;
        const f = this.sellFacets(it);
        if (f.category) cats.add(f.category);
        if (f.slot) slots.add(f.slot);
        if (f.rarity) rars.add(f.rarity);
      }
      const ord = s => [...s].sort((a, b) => a.localeCompare(b, 'pt-BR'));
      return { categories: ord(cats), slots: ord(slots), rarities: ord(rars) };
    },

    /**
     * As linhas que a aba mostra agora: vendáveis, peneiradas e ordenadas.
     *
     * A ordem padrão é por valor sugerido, decrescente. Um inventário de 300
     * peças tem valor concentrado em poucas delas, e a ordem de `uid` — que é
     * a de aquisição — esconderia justamente as que compensam anunciar.
     */
    sellRows() {
      const f = this.sell.filter;
      const busca = f.search.toLowerCase();

      const linhas = this.sell.items.filter(it => {
        if (it.blocked === 'equipped' ? !this.sell.showEquip : it.blocked) return false;
        // Trancado e sem uid nunca aparecem: diferente de equipado, não há
        // nada que o usuário possa fazer na tela a respeito, e a linha só
        // ocuparia espaço entre o que ele pode de fato anunciar.
        const faceta = this.sellFacets(it);
        if (f.category !== 'todos' && faceta.category !== f.category) return false;
        if (f.slot !== 'todos' && faceta.slot !== f.slot) return false;
        if (f.rarity !== 'todos' && faceta.rarity !== f.rarity) return false;
        if (f.sem && it.suggestion) return false;
        if (busca && !this.itemLabel(it).toLowerCase().includes(busca)) return false;
        return true;
      });

      const nome = it => this.itemLabel(it);
      const ordens = {
        valor: (a, b) => (b.suggestion * b.qty) - (a.suggestion * a.qty),
        unidade: (a, b) => b.suggestion - a.suggestion,
        nome: (a, b) => nome(a).localeCompare(nome(b), 'pt-BR'),
        nivel: (a, b) => b.level - a.level,
        qtd: (a, b) => b.qty - a.qty
      };
      return linhas.sort(ordens[f.sort] || ordens.valor);
    },

    /**
     * O preço sugerido **do lote**, que é o que o campo da tela recebe.
     *
     * `suggestion` vem do banco e é por unidade — `unit_price` é a coluna das
     * vendas. O campo de preço, por decisão da aba, é o do pacote inteiro.
     * Multiplicar era o passo que faltava: um lote de 10 poções com sugestão
     * de 380 000 cada entrava no campo como 380 000 pelas dez, e o anúncio
     * saía por 38 000 a unidade — um décimo do preço, para o primeiro
     * comprador que passasse.
     *
     * Espelha `lotPrice` de `leveling-listing.js`, onde a regra é testada. A
     * cópia existe porque este arquivo é script de navegador e não tem
     * `require`; a volta — lote de novo para unitário — é o `unitPrice` de
     * `normalizeDraft`, e um teste verifica que as duas fecham.
     */
    sellSuggested(it) {
      return (Number(it && it.suggestion) || 0) * Math.max(1, Number(it && it.qty) || 1);
    },

    /** Algum filtro está peneirando a lista? Separa "conta vazia" de "filtro apertado". */
    sellFiltered() {
      const f = this.sell.filter;
      return f.category !== 'todos' || f.slot !== 'todos' || f.rarity !== 'todos'
        || !!f.search || !!f.sem;
    },

    /** Quantos itens a conta tem de vendável, ignorando os filtros. */
    sellRowsAll() {
      return this.sell.items.filter(it =>
        it.blocked === 'equipped' ? this.sell.showEquip : !it.blocked).length;
    },

    /** Volta os filtros ao estado inicial, preservando a seleção já feita. */
    clearSellFilter() {
      this.sell.filter = {
        category: 'todos', slot: 'todos', rarity: 'todos', search: '', sort: 'valor', sem: false
      };
      this.render();
    },

    /** Marca ou desmarca um item. Marcar liga o automático por padrão. */
    toggleSellPick(uid) {
      const s = this.sell;
      if (s.picked.has(uid)) {
        s.picked.delete(uid);
        s.auto.delete(uid);
      } else {
        const it = s.items.find(i => i.uid === uid);
        // O automático é o padrão porque é o motivo da aba existir: marcar
        // dez itens e digitar dez preços à mão seria o trabalho que ela veio
        // evitar. Sem sugestão o item entra marcado e sem preço, e a
        // confirmação o separa como "falta valor".
        s.picked.set(uid, this.sellSuggested(it));
        if (it && it.suggestion) s.auto.add(uid);
      }
      this.render();
    },

    /** Marca tudo que está à vista, ou desmarca se já estava tudo marcado. */
    toggleSellAll() {
      const linhas = this.sellRows();
      const todos = linhas.length && linhas.every(l => this.sell.picked.has(l.uid));
      if (todos) {
        this.sell.picked = new Map();
        this.sell.auto = new Set();
      } else {
        for (const it of linhas) {
          if (this.sell.picked.has(it.uid)) continue;
          this.sell.picked.set(it.uid, this.sellSuggested(it));
          if (it.suggestion) this.sell.auto.add(it.uid);
        }
      }
      this.render();
    },

    /**
     * Preço digitado à mão. Sai do automático na hora: os dois estados não
     * podem coexistir, senão a próxima sugestão apagaria o que foi digitado.
     */
    setSellPrice(uid, valor) {
      const n = Math.max(0, Math.floor(Number(valor) || 0));
      this.sell.picked.set(uid, n);
      this.sell.auto.delete(uid);
    },

    /** Volta o item ao preço sugerido. */
    setSellAuto(uid, ligado) {
      const it = this.sell.items.find(i => i.uid === uid);
      if (ligado) {
        this.sell.auto.add(uid);
        this.sell.picked.set(uid, this.sellSuggested(it));
      } else {
        this.sell.auto.delete(uid);
      }
      this.render();
    },

    /** Os rascunhos como o domínio os espera. */
    sellDrafts() {
      const out = [];
      for (const [uid, total] of this.sell.picked) {
        const it = this.sell.items.find(i => i.uid === uid);
        if (!it) continue;
        out.push({
          uid,
          defId: it.defId,
          name: this.itemLabel(it),
          level: it.level,
          // Lote inteiro: o usuário pediu que item com mais de uma unidade
          // seja anunciado como pacote, e o preço digitado é o do pacote.
          quantity: it.qty,
          total,
          auto: this.sell.auto.has(uid)
        });
      }
      return out;
    },

    /**
     * Nome de uma peça em texto puro, para a confirmação e a busca.
     *
     * A mesma identidade de `gearNameHtml`, sem marcação: a tela de confirmar
     * mostra "Espada lendária nv. 12 +3", e é por esse nome que o usuário
     * reconhece a peça que vai sair do inventário dele. Confirmar "Espada" e
     * descobrir depois qual das três era não é uma confirmação.
     */
    itemLabel(it) {
      const def = this.catalog.items[it.defId] || {};
      const rarityId = String(it.rarity || def.rarity || '');
      const rar = this.catalog.rarities[rarityId];
      const partes = [def.name || it.defId];
      const nomeRar = (rar && rar.name) || rarityId;
      if (nomeRar) partes.push(String(nomeRar).toLowerCase());
      if (it.level) partes.push(`nv. ${it.level}`);
      if (it.enchant) partes.push(`+${it.enchant}`);
      return partes.join(' ');
    },

    /**
     * Abre a confirmação. Nada é mandado aqui: o usuário pediu uma tela que
     * mostra cada item e o valor antes de acontecer, e é ela que o botão de
     * confirmar de verdade vai usar.
     */
    openSellConfirm() {
      const drafts = this.sellDrafts();
      const ready = [];
      const blocked = [];
      for (const d of drafts) {
        if (d.total > 0) {
          ready.push({ ...d, unitPrice: Math.max(1, Math.ceil(d.total / Math.max(1, d.quantity))) });
        } else {
          blocked.push({ ...d, reason: 'price.missing' });
        }
      }
      this.sell.confirm = {
        ready, blocked,
        totalGold: ready.reduce((s, d) => s + d.total, 0)
      };
      this.sell.results = null;
      this.render();
    },

    closeSellConfirm() {
      this.sell.confirm = null;
      this.render();
    },

    /** Manda os anúncios. Falha parcial é resultado, não erro. */
    async confirmSell() {
      const c = this.sell.confirm;
      if (!c || !c.ready.length || this.sell.busy) return;
      this.sell.busy = true;
      this.render();

      const res = await this.api.marketAnnounce({
        index: this.sell.account,
        drafts: c.ready
      }).catch(e => ({ errorCode: (e && e.message) || 'announce.failed' }));

      this.sell.busy = false;
      this.sell.confirm = null;
      this.sell.results = res && res.results
        ? res.results
        : [{ ok: false, error: (res && res.errorCode) || 'announce.failed', name: '' }];

      // O que entrou saiu do inventário: reler é o que impede a tela de
      // oferecer de novo um item que já está anunciado.
      const entrou = (this.sell.results || []).some(r => r.ok);
      if (entrou) await this.loadSellable();
      else this.render();
    },

    /** Leitura imediata do mercado, sem esperar o minuto do coletor. */
    async pollNow() {
      if (!this.api || !this.api.marketPoll) return;
      this.loading = true;
      this.paintStatus();
      const res = await this.api.marketPoll().catch(() => null);
      const erro = res && res.poll && res.poll.lastError;
      if (erro === 'market.noneActive') {
        this.erro = 'Nenhuma conta em modo monitor — o mercado é lido pela sessão de uma conta.';
      } else if (erro) {
        this.erro = `O servidor recusou a leitura (${erro}).`;
      } else {
        this.erro = '';
      }
      await this.load();
    },

    show(defId) {
      this.defId = String(defId || '');
      this.view = this.defId ? 'detail' : 'items';
      this.load();
    },

    // ------------------------------------------------------------- pintura

    /**
     * Pinta a tela.
     *
     * A barra de filtros e a tabela são trocadas separadamente de propósito.
     * Antes isto era um `host.innerHTML` único, e o efeito era um bug: o
     * `<input>` da busca era destruído e recriado a cada repintura, então
     * digitar uma letra disparava a consulta, a consulta repintava e o
     * cursor saía da caixa no meio da palavra. Repintar só `.mk-view` deixa
     * o input vivo, com foco e cursor onde o usuário deixou.
     *
     * A barra ainda precisa ser refeita quando sua *estrutura* muda — abas,
     * campos presentes, categorias descobertas. A assinatura abaixo é o que
     * detecta isso sem recriar nada no caso comum.
     */
    render() {
      const host = document.getElementById('marketBody');
      if (!host) return;

      // O texto buscado fica fora da assinatura de propósito, nas duas abas:
      // ele muda a cada tecla, e refazer a barra recriaria o input e tiraria
      // o cursor de dentro dele. O que entra é só o que muda a *estrutura*
      // da barra — quais campos existem e com que opções.
      const assinatura = [
        this.view, this.itemName(), this.query.days, this.query.sort,
        this.query.category, this.data.categories.join(','),
        this.sell.account, this.sell.items.length, this.sell.showEquip,
        this.sell.filter.category, this.sell.filter.slot,
        this.sell.filter.rarity, this.sell.filter.sort, this.sell.filter.sem
      ].join('|');

      let bar = host.querySelector('.mk-bar');
      let vista = host.querySelector('.mk-view');

      if (!bar || !vista) {
        host.innerHTML = `${this.filtersHtml()}<div class="mk-view"></div>`;
        bar = host.querySelector('.mk-bar');
        vista = host.querySelector('.mk-view');
        this.barSig = assinatura;
        this.wireBar(host);
      } else if (assinatura !== this.barSig) {
        // O valor digitado não vem de `this.query.search`: o debounce faz com
        // que eles divirjam por 250 ms, e reescrever a barra nesse intervalo
        // apagaria a última letra digitada.
        const busca = bar.querySelector('[data-role="search"], [data-role="sell-search"]');
        const digitado = busca ? busca.value : null;
        const tinhaFoco = busca && document.activeElement === busca;
        const caret = tinhaFoco ? busca.selectionStart : 0;

        bar.outerHTML = this.filtersHtml();
        bar = host.querySelector('.mk-bar');
        this.barSig = assinatura;
        this.wireBar(host);

        const novo = bar.querySelector('[data-role="search"], [data-role="sell-search"]');
        if (novo && digitado != null) {
          novo.value = digitado;
          if (tinhaFoco) { novo.focus(); novo.setSelectionRange(caret, caret); }
        }
      }

      vista.innerHTML = this.view === 'detail' ? this.detailHtml()
        : this.view === 'bolsa' ? this.bolsaHtml()
        : this.view === 'sell' ? this.sellHtml()
        : this.view === 'mine' ? this.mineHtml()
        : this.view === 'live' ? this.liveHtml()
        : this.itemsHtml();

      this.wireRows(vista);
      this.paintActions();
      this.paintStatus();
    },

    /**
     * Ações da aba ativa, no rodapé fixo, ao lado de "Ler agora".
     *
     * "Revisar e anunciar" estava no fim da lista de itens, que rola: com
     * trinta itens marcados o botão ficava fora da tela justamente no momento
     * em que ele era o próximo passo. O rodapé é o único lugar da janela que
     * não sai de vista.
     */
    paintActions() {
      const host = document.getElementById('marketActions');
      if (!host) return;
      const s = this.sell;

      if (this.view !== 'sell' || s.results) { host.innerHTML = ''; return; }

      if (s.confirm) {
        host.innerHTML = `
          <button type="button" data-role="sell-back" ${s.busy ? 'disabled' : ''}>Voltar</button>
          <button type="button" class="primary" data-role="sell-go"
            ${s.busy || !s.confirm.ready.length ? 'disabled' : ''}>${
          s.busy ? 'Anunciando…' : `Anunciar ${s.confirm.ready.length} ${
            s.confirm.ready.length === 1 ? 'item' : 'itens'}`}</button>`;
      } else {
        const n = s.picked.size;
        host.innerHTML = `
          <button type="button" class="primary" data-role="sell-review" ${n ? '' : 'disabled'}>${
          n ? `Revisar e anunciar (${n})` : 'Revisar e anunciar'}</button>`;
      }

      // O rodapé está fora de `.mk-view`, então o ouvinte delegado das linhas
      // não o alcança: ele precisa do seu próprio.
      host.onclick = ev => {
        const alvo = ev.target;
        if (alvo && alvo.closest) this.wireSellClick(alvo);
      };
    },

    filtersHtml() {
      const abas = [
        { id: 'items', label: 'Itens' },
        { id: 'live', label: 'Ao vivo' },
        { id: 'bolsa', label: 'Minha bolsa' },
        { id: 'sell', label: 'Anunciar' },
        { id: 'mine', label: 'Meus anúncios' }
      ];
      return `
        <div class="mk-bar">
          <div class="mk-tabs" role="tablist">
            ${abas.map(a => `
              <button type="button" class="mk-tab${this.view === a.id ? ' is-on' : ''}"
                data-view="${a.id}" role="tab" aria-selected="${this.view === a.id}">${a.label}</button>`).join('')}
            ${this.view === 'detail' ? `
              <button type="button" class="mk-tab is-on" role="tab" aria-selected="true"
                data-view="items" title="Voltar à lista">&larr; ${escape(this.itemName())}</button>` : ''}
          </div>

          <div class="mk-filters">
            <label class="mk-field">
              <span>Período</span>
              <select data-role="days">
                ${PERIODOS.map(p => `<option value="${p.days}" ${p.days === this.query.days ? 'selected' : ''}>${p.label}</option>`).join('')}
              </select>
            </label>
            ${this.view === 'sell' ? this.sellFiltersHtml() : ''}
            ${this.view === 'detail' || this.view === 'bolsa' || this.view === 'sell' || this.view === 'mine' ? '' : `
              <label class="mk-field">
                <span>Categoria</span>
                <select data-role="category">
                  <option value="todos">todas</option>
                  ${this.data.categories.map(c => `<option value="${escape(c)}" ${c === this.query.category ? 'selected' : ''}>${escape(c)}</option>`).join('')}
                </select>
              </label>
              ${this.view === 'items' ? `
                <label class="mk-field">
                  <span>Ordem</span>
                  <select data-role="sort">
                    ${ORDENS.map(o => `<option value="${o.id}" ${o.id === this.query.sort ? 'selected' : ''}>${o.label}</option>`).join('')}
                  </select>
                </label>` : ''}
              <label class="mk-field mk-search">
                <span>Buscar</span>
                <input type="search" data-role="search" value="${escape(this.query.search)}" placeholder="nome do item">
              </label>`}
          </div>
        </div>
      `;
    },

    /**
     * Filtros da aba Anunciar.
     *
     * Ficam na barra do topo, junto do Período, e não dentro da aba. A aba
     * se repinta a cada clique de marcar item e a cada preço digitado; um
     * campo de busca ali dentro perderia o foco no meio da palavra, que é o
     * mesmo motivo pelo qual a barra é repintada só quando sua estrutura
     * muda. O Período já estava aqui e serve a aba: é a janela de vendas que
     * o preço automático olha.
     *
     * Só aparecem com conta escolhida e lista carregada — filtro sobre lista
     * vazia é um seletor que não faz nada.
     */
    sellFiltersHtml() {
      const s = this.sell;
      if (s.account === null || !s.items.length) return '';
      const f = s.filter;
      // O rótulo não é o valor: raridade vem como `ITEM_RARITY_EPICO` do
      // servidor, e o catálogo tem o nome que o jogo mostra. Um seletor com
      // os enums crus obrigaria o usuário a traduzir de cabeça.
      const op = (lista, atual, rotuloTodos, rotulo) => `
        <option value="todos">${rotuloTodos}</option>
        ${lista.map(v => `<option value="${escape(v)}" ${v === atual ? 'selected' : ''}>${
        escape(String((rotulo && rotulo(v)) || v).toLowerCase())}</option>`).join('')}`;
      const nomeRaridade = id => {
        const r = this.catalog.rarities[id];
        return (r && r.name) || id;
      };
      const facetas = this.sellFacetOptions();
      const semPreco = s.items.filter(i => !i.blocked && !i.suggestion).length;

      return `
        ${facetas.categories.length > 1 ? `
          <label class="mk-field">
            <span>Categoria</span>
            <select data-role="sell-cat">${op(facetas.categories, f.category, 'todas')}</select>
          </label>` : ''}
        ${facetas.slots.length > 1 ? `
          <label class="mk-field">
            <span>Slot</span>
            <select data-role="sell-slot">${op(facetas.slots, f.slot, 'todos')}</select>
          </label>` : ''}
        ${facetas.rarities.length > 1 ? `
          <label class="mk-field">
            <span>Raridade</span>
            <select data-role="sell-rar">${op(facetas.rarities, f.rarity, 'todas', nomeRaridade)}</select>
          </label>` : ''}
        <label class="mk-field">
          <span>Ordem</span>
          <select data-role="sell-sort">
            ${ORDENS_ANUNCIO.map(o => `<option value="${o.id}" ${o.id === f.sort ? 'selected' : ''}>${o.label}</option>`).join('')}
          </select>
        </label>
        <label class="mk-field mk-search">
          <span>Buscar</span>
          <input type="search" data-role="sell-search" value="${escape(f.search)}" placeholder="nome do item">
        </label>
        ${semPreco ? `
          <label class="mk-check mk-field-check">
            <input type="checkbox" data-role="sell-sem" ${f.sem ? 'checked' : ''}>
            <span>Só sem preço (${semPreco})</span>
          </label>` : ''}`;
    },

    /** Liga os campos de filtro da aba Anunciar. Peneira local: não relê a conta. */
    wireSellBar(host) {
      const liga = (role, fn) => {
        const el = host.querySelector(`[data-role="${role}"]`);
        if (el) el.onchange = () => { fn(el); this.render(); };
      };
      liga('sell-cat', el => { this.sell.filter.category = el.value; });
      liga('sell-slot', el => { this.sell.filter.slot = el.value; });
      liga('sell-rar', el => { this.sell.filter.rarity = el.value; });
      liga('sell-sort', el => { this.sell.filter.sort = el.value; });
      liga('sell-sem', el => { this.sell.filter.sem = !!el.checked; });

      const busca = host.querySelector('[data-role="sell-search"]');
      if (busca) {
        // Sem debounce, ao contrário da busca das outras abas: aqui não há
        // consulta nenhuma, só um `filter` sobre uma lista que já está na
        // memória. Esperar 250 ms seria atrasar de propósito.
        busca.oninput = () => {
          this.sell.filter.search = busca.value.trim();
          this.paintSellView();
        };
      }
    },

    /**
     * Repinta só a lista, deixando a barra intacta.
     *
     * A busca não pode passar por `render`: ele reescreve a barra quando a
     * assinatura muda, e a assinatura inclui o texto buscado — o input seria
     * recriado a cada tecla e o cursor sairia dele.
     */
    paintSellView() {
      const vista = document.getElementById('marketBody');
      const alvo = vista && vista.querySelector('.mk-view');
      if (!alvo) return;
      alvo.innerHTML = this.sellHtml();
      this.wireRows(alvo);
    },

    wireBar(host) {
      for (const botao of host.querySelectorAll('[data-view]')) {
        botao.onclick = () => {
          this.view = botao.dataset.view;
          if (this.view !== 'detail') this.defId = '';
          this.load();
        };
      }
      const dias = host.querySelector('[data-role="days"]');
      if (dias) dias.onchange = () => { this.query.days = +dias.value; this.load(); };

      this.wireSellBar(host);

      const cat = host.querySelector('[data-role="category"]');
      if (cat) cat.onchange = () => { this.query.category = cat.value; this.load(); };

      const ordem = host.querySelector('[data-role="sort"]');
      if (ordem) ordem.onchange = () => { this.query.sort = ordem.value; this.load(); };

      const busca = host.querySelector('[data-role="search"]');
      if (busca) {
        busca.oninput = () => {
          // Consultar a cada tecla faria N consultas para uma palavra.
          clearTimeout(this.searchTimer);
          this.searchTimer = setTimeout(() => {
            this.query.search = busca.value.trim();
            this.load();
          }, 250);
        };
      }
    },

    /**
     * Cliques das linhas.
     *
     * Um ouvinte na tabela, não um por linha. Com 200 linhas, atribuir
     * `onclick` em cada uma era 200 closures recriadas a cada repintura — e
     * repintura acontece a cada venda nova, de minuto em minuto. A delegação
     * custa um ouvinte, sempre.
     */
    wireRows(vista) {
      vista.onclick = ev => {
        const alvo = ev.target;
        if (!alvo || !alvo.closest) return;
        const caixa = alvo.closest('[data-role="equip"]');
        if (caixa) { this.showEquip = !!caixa.checked; this.render(); return; }
        if (this.view === 'sell' && this.wireSellClick(alvo)) return;
        if (this.view === 'detail' && this.wireSnipeClick(alvo)) return;
        if (this.view === 'mine') {
          const sub = alvo.closest('[data-role="mine-aba"]');
          if (sub) { this.mineAba = sub.dataset.aba; this.render(); return; }
        }
        const linha = alvo.closest('[data-item]');
        if (linha) this.show(linha.dataset.item);
      };

      // O preço é tratado no `change`, não no `click`: repintar a cada tecla
      // tiraria o cursor do campo, e `change` só dispara quando o usuário sai
      // dele ou aperta Enter — que é quando o número está completo.
      vista.onchange = ev => {
        const alvo = ev.target;
        if (!alvo || !alvo.dataset) return;
        if (alvo.dataset.price !== undefined) {
          this.setSellPrice(alvo.dataset.price, alvo.value);
          this.render();
          return;
        }
        const seletor = alvo.closest && alvo.closest('[data-role="sell-account"]');
        if (seletor) {
          const v = seletor.value;
          this.sell.account = v === '' ? null : Number(v);
          this.sell.items = [];
          this.load();
          return;
        }
        // Bolsa: filtro local, sem releitura. `render`, não `load`.
        const conta = alvo.closest && alvo.closest('[data-role="bolsa-conta"]');
        if (conta) {
          this.bolsaConta = conta.value === 'todas' ? null : Number(conta.value);
          this.render();
          return;
        }
        const contaMine = alvo.closest && alvo.closest('[data-role="mine-conta"]');
        if (contaMine) {
          this.mineConta = contaMine.value === 'todas' ? null : Number(contaMine.value);
          this.render();
          return;
        }

        // Campos da regra de sniper. Guardados sem repintar: a confirmação
        // está aberta e repintá-la tiraria o cursor do campo no meio do
        // número. O botão "Criar regra" lê o estado, que já está atualizado.
        const s = this.snipe;
        if (!s) return;
        const papel = alvo.dataset.role;
        if (papel === 'snipe-max') s.maxGold = Math.max(0, Math.floor(Number(alvo.value) || 0));
        else if (papel === 'snipe-target') s.target = Math.max(0, Math.floor(Number(alvo.value) || 0));
        else if (papel === 'snipe-account') s.account = Number(alvo.value) || 0;
      };
    },

    /**
     * Cliques do botão de sniper, no detalhe. Devolve `true` quando tratou.
     */
    wireSnipeClick(alvo) {
      const papel = alvo.closest && alvo.closest('[data-role]');
      const role = papel && papel.dataset.role;
      if (role === 'snipe') { this.openSnipe(); return true; }
      if (role === 'snipe-cancel') { this.snipe = null; this.render(); return true; }
      if (role === 'snipe-ok') { this.confirmSnipe(); return true; }
      return false;
    },

    /**
     * Prepara a regra com o teto já calculado.
     *
     * As contas vêm de `marketSellable` sem índice, que é o pedido barato que
     * devolve só a lista — a aba Anunciar já o usa para montar o seletor
     * dela, e aqui a pergunta é a mesma: quem está em modo monitor.
     */
    async openSnipe() {
      const it = this.data.item;
      if (!it) return;
      const mediana = Number(it.mediana) || 0;
      if (!mediana) return;

      if (!this.sell.accounts.length && this.api.marketSellable) {
        const res = await this.api.marketSellable({ index: null }).catch(() => null);
        if (res && res.accounts) this.sell.accounts = res.accounts;
      }
      const viva = (this.sell.accounts || []).find(a => a.connected);

      this.snipe = {
        defId: it.def_id,
        name: it.name || it.def_id,
        median: mediana,
        maxGold: Math.max(1, Math.floor(mediana * (1 - SNIPE_DESCONTO))),
        target: 1,
        account: viva ? viva.index : 0
      };
      this.render();
    },

    /** Grava a regra. O canal acrescenta — nunca manda a configuração inteira. */
    async confirmSnipe() {
      const s = this.snipe;
      if (!s || !s.maxGold) return;
      const res = await this.api.sniperAdd({
        defId: s.defId,
        name: s.name,
        maxGold: s.maxGold,
        target: s.target,
        account: s.account
      }).catch(e => ({ ok: false, error: (e && e.message) || 'falhou' }));

      this.snipe = null;
      this.render();
      if (res && res.ok) {
        this.say(`${res.replaced ? 'Regra atualizada' : 'Regra criada'}: compra ${
          s.target ? `${s.target} unidade(s)` : 'sem limite'} de ${s.name} até ${cheio(s.maxGold)} 🪙.`);
      } else {
        this.say('Não foi possível criar a regra: ' + ((res && res.error) || 'erro'), true);
      }
    },

    /**
     * Cliques da aba Anunciar. Devolve `true` quando tratou, para o clique
     * não cair na navegação de item que vale nas outras visões.
     */
    wireSellClick(alvo) {
      const d = alvo.dataset || {};
      if (d.pick !== undefined) { this.toggleSellPick(d.pick); return true; }
      if (d.auto !== undefined) { this.setSellAuto(d.auto, !!alvo.checked); return true; }
      const papel = alvo.closest('[data-role]');
      const role = papel && papel.dataset.role;
      if (role === 'sell-all') { this.toggleSellAll(); return true; }
      if (role === 'sell-equip') { this.sell.showEquip = !!papel.checked; this.render(); return true; }
      if (role === 'sell-clear') { this.clearSellFilter(); return true; }
      if (role === 'sell-review') { this.openSellConfirm(); return true; }
      if (role === 'sell-back') { this.closeSellConfirm(); return true; }
      if (role === 'sell-go') { this.confirmSell(); return true; }
      if (role === 'sell-done') { this.sell.results = null; this.render(); return true; }
      return false;
    },

    itemsHtml() {
      if (!this.data.items.length) return this.emptyHtml();

      return `
        <table class="mk-table">
          <thead>
            <tr>
              <th class="mk-c-ic" aria-label="Ícone"></th>
              <th class="mk-c-name">Item</th>
              <th class="mk-c-n" title="Vendas registradas no período">Vendas</th>
              <th class="mk-c-p" title="Média ponderada pela quantidade">Média</th>
              <th class="mk-c-p" title="O preço do meio — não se deixa puxar por vendas extremas">Mediana</th>
              <th class="mk-c-p mk-c-opt">Mínimo</th>
              <th class="mk-c-p mk-c-opt">Máximo</th>
              <th class="mk-c-p">Último</th>
              <th class="mk-c-p mk-c-dia" title="Mediana das vendas feitas em diamante — moeda separada, nunca somada ao ouro">💎</th>
              <th class="mk-c-own" title="Quanto as suas contas em modo monitor têm deste item">Minhas</th>
              <th class="mk-c-t">Quando</th>
            </tr>
          </thead>
          <tbody>
            ${this.data.items.map(i => {
              // Média muito acima da mediana significa cauda de vendas caras:
              // o número que representa o item é a mediana, não a média.
              const torto = i.mediana > 0 && (i.media / i.mediana > 2 || i.mediana / i.media > 2);
              return `
              <tr data-item="${escape(i.def_id)}" tabindex="0" class="${torto ? 'is-spread' : ''}">
                <td class="mk-c-ic">${this.iconHtml(i)}</td>
                <td class="mk-c-name">
                  ${this.nameHtml(i)}
                  ${this.subHtml(i)}
                </td>
                <td class="mk-c-n">${i.vendas}<small>${curto(i.unidades)} un</small></td>
                <td class="mk-c-p" title="${cheio(i.media)}">${curto(i.media)}</td>
                <td class="mk-c-p mk-strong" title="${cheio(i.mediana)}${torto
                  // Dispersão alta quase sempre é nível, não mercado nervoso:
                  // "Topázio" são quatro itens com o mesmo nome. Dizer onde
                  // olhar é o que transforma o sinal em ação, em vez de só
                  // avisar que o número não serve.
                  ? ' — este nome reúne preços muito diferentes, em geral porque o item varia por nível ou encantamento. Clique para ver a quebra por nível.'
                  : ''}">${curto(i.mediana)}${torto
                  ? ' <span class="mk-flag" aria-label="preço disperso: varia por nível">≠</span>'
                  : ''}</td>
                <td class="mk-c-p mk-c-opt" title="${cheio(i.minimo)}">${curto(i.minimo)}</td>
                <td class="mk-c-p mk-c-opt" title="${cheio(i.maximo)}">${curto(i.maximo)}</td>
                <td class="mk-c-p" title="${cheio(i.ultimo_preco)}">${curto(i.ultimo_preco)}</td>
                ${this.diamondCellHtml(i)}
                ${this.ownedCellHtml(i)}
                <td class="mk-c-t" title="${new Date(Number(i.ultima_venda_ms)).toLocaleString('pt-BR')}">${decorrido(i.ultima_venda_ms)}</td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
        ${this.data.total > this.data.items.length
          ? `<p class="hint">Mostrando ${this.data.items.length} de ${this.data.total} itens. Use a busca ou a categoria para estreitar.</p>`
          : ''}
      `;
    },

    liveHtml() {
      if (!this.data.sales.length) return this.emptyHtml();
      return `
        <table class="mk-table mk-live">
          <thead>
            <tr>
              <th class="mk-c-t">Hora</th>
              <th class="mk-c-ic" aria-label="Ícone"></th>
              <th class="mk-c-name">Item</th>
              <th class="mk-c-n">Qtd</th>
              <th class="mk-c-p">Unitário</th>
              <th class="mk-c-p">Total</th>
            </tr>
          </thead>
          <tbody>
            ${this.data.sales.map(s => `
              <tr data-item="${escape(s.def_id)}" tabindex="0">
                <td class="mk-c-t" title="${new Date(Number(s.sold_at_ms)).toLocaleString('pt-BR')}">${quando(s.sold_at_ms)}</td>
                <td class="mk-c-ic">${this.iconHtml(s)}</td>
                <td class="mk-c-name">
                  ${this.nameHtml(s, this.levelTagHtml(s) + (s.enchant ? ' +' + s.enchant : ''))}
                  ${this.subHtml(s)}
                </td>
                <td class="mk-c-n">${curto(s.quantity)}</td>
                <td class="mk-c-p mk-strong" title="${cheio(s.unit_price)}">${curto(s.unit_price)}</td>
                <td class="mk-c-p" title="${cheio(s.total)}">${curto(s.total)}</td>
              </tr>`).join('')}
          </tbody>
        </table>
      `;
    },

    /**
     * "Minha bolsa": o que dá para vender, em cada conta, e por quanto.
     *
     * A aba responde uma pergunta que as outras duas não respondem. "Itens"
     * diz quanto as coisas valem; esta diz quanto *eu* tenho em valor, que é
     * a soma que decide se vale a pena abrir o jogo.
     *
     * Equipamento fica de fora por padrão. Não é economia de espaço: o que
     * está vestido não está à venda, e somá-lo ao total transformaria o
     * número de "posso lucrar isto" em "possuo isto", que é outra coisa. A
     * caixa revela porque às vezes a decisão é vender a armadura mesmo.
     */
    bolsaHtml() {
      const b = this.bolsa;
      if (!b) return `<p class="hint">Lendo o inventário das contas…</p>`;

      // Filtro por conta. Com oito contas a tabela passa de mil linhas, e a
      // pergunta quase sempre é sobre uma delas — "o que esta conta tem para
      // vender". É peneira sobre o que já foi lido, não uma releitura: trocar
      // de conta não pode custar uma varredura nova de inventário.
      const contas = b.contas || [];
      const caixa = `
        <div class="mk-bolsa-filtros">
          ${contas.length > 1 ? `
            <label class="mk-field">
              <span>Conta</span>
              <select data-role="bolsa-conta">
                <option value="todas"${this.bolsaConta === null ? ' selected' : ''}>todas (${contas.length})</option>
                ${contas.map(c => `
                  <option value="${c.index}"${this.bolsaConta === c.index ? ' selected' : ''}>${
            escape(`${c.index + 1} · ${c.name || 'conta ' + (c.index + 1)}`)}</option>`).join('')}
              </select>
            </label>` : ''}
          <label class="mk-check">
            <input type="checkbox" data-role="equip" ${this.showEquip ? 'checked' : ''}>
            <span>Mostrar equipamentos vestidos</span>
          </label>
        </div>`;

      if (!b.contas.length) {
        return `
          ${caixa}
          <p class="hint">Nenhuma conta em modo monitor. O inventário é lido pela sessão de cada
          conta, então sem monitor não há bolsa para somar${
            b.offline && b.offline.length ? ` — ${b.offline.length} conta(s) fora: ${
              escape(b.offline.map(o => o.name || 'conta ' + (o.index + 1)).join(', '))
            }` : ''
          }.</p>`;
      }

      // Uma linha por item e por conta. Agrupar por conta é o que torna a
      // tabela acionável: vender exige entrar numa conta específica.
      const linhas = [];
      const totalPorConta = new Map();
      for (const conta of b.contas) {
        // O filtro corta aqui, antes de somar: o total tem de ser o da conta
        // escolhida, senão o card diria um número que não corresponde à
        // tabela logo abaixo.
        if (this.bolsaConta !== null && conta.index !== this.bolsaConta) continue;
        let soma = 0;
        for (const [defId, d] of Object.entries(conta.owned)) {
          const vestido = !d.qty && d.equipped;
          // `qty` já exclui o que está vestido: item só-equipado tem qty 0.
          if (vestido && !this.showEquip) continue;
          const preco = b.precos[defId] || null;
          const unit = preco ? (Number(preco.mediana) || Number(preco.media) || 0) : 0;
          const qtd = vestido ? d.equipped : d.qty;
          const valor = unit * qtd;
          if (!vestido) soma += valor;
          linhas.push({
            def_id: defId, conta, dados: d, preco, unit, qtd, valor, vestido,
            name: (preco && preco.name)
              || (this.catalog.items[defId] && this.catalog.items[defId].name)
              || defId,
            rarity: (d.melhor && d.melhor.rarity) || (preco && preco.rarity) || ''
          });
        }
        totalPorConta.set(conta.index, soma);
      }

      // Maior valor primeiro: é a ordem da decisão. Item sem preço conhecido
      // vai para o fim em vez de desaparecer — não ter cotação não é o mesmo
      // que não valer nada.
      linhas.sort((a, b2) => b2.valor - a.valor || a.name.localeCompare(b2.name));

      const total = [...totalPorConta.values()].reduce((s, n) => s + n, 0);
      const semPreco = linhas.filter(l => !l.unit).length;

      if (!linhas.length) {
        // "A conta está vazia" e "o filtro não deixou passar" mandam o
        // usuário para lados opostos.
        return `${caixa}<p class="hint">${this.bolsaConta !== null
          ? 'Nada vendável nesta conta. Escolha "todas" para ver as outras.'
          : 'Nada vendável nas contas lidas.'}</p>`;
      }

      return `
        <div class="mk-bolsa-top">
          ${caixa}
          <div class="mk-cards">
            ${this.cardHtml('Total vendável', total, 'pela mediana de cada item, sem o que está vestido')}
            <div class="mk-card">
              <span class="mk-card-label">Contas lidas</span>
              <b class="mk-card-value">${this.bolsaConta === null ? b.contas.length : 1}</b>
              <small>${this.bolsaConta === null
          ? (b.offline && b.offline.length ? `${b.offline.length} fora do monitor` : 'todas em monitor')
          : `de ${b.contas.length} lidas · filtrando`}</small>
            </div>
            <div class="mk-card">
              <span class="mk-card-label">Linhas</span>
              <b class="mk-card-value">${linhas.length}</b>
              <small>${semPreco ? `${semPreco} sem cotação no período` : 'todas com cotação'}</small>
            </div>
          </div>
        </div>

        <table class="mk-table">
          <thead>
            <tr>
              <th class="mk-c-ic" aria-label="Ícone"></th>
              <th class="mk-c-name">Item</th>
              <th class="mk-c-name">Conta</th>
              <th class="mk-c-n">Qtd</th>
              <th class="mk-c-p" title="Mediana do mercado por unidade">Unitário</th>
              <th class="mk-c-p" title="Preço em diamante, quando o item já foi vendido nessa moeda">💎</th>
              <th class="mk-c-p mk-strong">Valor</th>
            </tr>
          </thead>
          <tbody>
            ${linhas.map(l => `
              <tr data-item="${escape(l.def_id)}" tabindex="0" class="${l.vestido ? 'is-equipped' : ''}">
                <td class="mk-c-ic">${this.iconHtml({ def_id: l.def_id, rarity: l.rarity })}</td>
                <td class="mk-c-name">
                  ${this.nameHtml({ def_id: l.def_id, name: l.name, rarity: l.rarity },
                    l.dados.melhor && l.dados.melhor.enchant ? ' +' + l.dados.melhor.enchant : '')}
                  <small>${l.vestido ? 'vestido — não está à venda'
                    : `${l.dados.bag ? l.dados.bag + ' mochila' : ''}${l.dados.bag && l.dados.warehouse ? ' · ' : ''}${l.dados.warehouse ? l.dados.warehouse + ' depósito' : ''}`}</small>
                </td>
                <td class="mk-c-name">${escape(l.conta.name || 'conta ' + (l.conta.index + 1))}</td>
                <td class="mk-c-n">${curto(l.qtd)}</td>
                <td class="mk-c-p" title="${l.unit ? cheio(l.unit) : 'nenhuma venda registrada neste período'}">${l.unit ? curto(l.unit) : '—'}</td>
                ${this.diamondCellHtml(l.preco)}
                <td class="mk-c-p mk-strong" title="${cheio(l.valor)}">${l.valor ? curto(l.valor) : '—'}</td>
              </tr>`).join('')}
          </tbody>
        </table>
        ${semPreco ? `<p class="hint">${semPreco} linha(s) sem cotação: o item não foi vendido no período
        escolhido. Troque o período para "tudo" — o banco guarda desde o primeiro dia de uso.</p>` : ''}
      `;
    },

    /**
     * Aba "Meus anúncios".
     *
     * Duas perguntas que não se misturam: "o que está de pé agora" e "o que
     * já saiu". A primeira é acionável — anúncio parado perto de expirar pede
     * decisão; a segunda é histórico. Numa tabela só, a segunda enterraria a
     * primeira, porque vendas acumulam para sempre e anúncios ativos são
     * poucos por conta.
     */
    mineHtml() {
      const m = this.mine;
      if (!m) return `<p class="hint">Lendo os anúncios das contas…</p>`;

      const contas = (m.contas || []).filter(
        c => this.mineConta === null || c.index === this.mineConta
      );
      const vivas = (m.contas || []).filter(c => !c.offline);

      const filtros = `
        <div class="mk-bolsa-filtros">
          ${(m.contas || []).length > 1 ? `
            <label class="mk-field">
              <span>Conta</span>
              <select data-role="mine-conta">
                <option value="todas"${this.mineConta === null ? ' selected' : ''}>todas (${m.contas.length})</option>
                ${m.contas.map(c => `
                  <option value="${c.index}"${this.mineConta === c.index ? ' selected' : ''}>${
            escape(`${c.index + 1} · ${c.name || c.username || 'conta ' + (c.index + 1)}`)}${
            c.offline ? ' (offline)' : ''}</option>`).join('')}
              </select>
            </label>` : ''}
          <div class="mk-subtabs" role="tablist">
            <button type="button" class="mk-tab${this.mineAba === 'ativos' ? ' is-on' : ''}"
              data-role="mine-aba" data-aba="ativos">À venda agora</button>
            <button type="button" class="mk-tab${this.mineAba === 'vendas' ? ' is-on' : ''}"
              data-role="mine-aba" data-aba="vendas">Vendidos</button>
          </div>
        </div>`;

      if (!vivas.length) {
        return `${filtros}<p class="hint">Nenhuma conta em modo monitor. Os anúncios ativos são lidos
          pela sessão de cada conta, então sem monitor só o histórico já gravado aparece.</p>
          ${this.mineAba === 'vendas' ? this.mineSalesHtml(contas) : ''}`;
      }

      return `${filtros}${this.mineAba === 'ativos'
        ? this.mineListingsHtml(contas)
        : this.mineSalesHtml(contas)}`;
    },

    /** Os anúncios de pé, por conta. Vindos do servidor: é o estado de agora. */
    mineListingsHtml(contas) {
      const linhas = [];
      for (const c of contas) {
        for (const l of c.listings || []) linhas.push({ ...l, conta: c });
      }
      // Quem expira primeiro no topo: é a única linha que pede decisão hoje.
      linhas.sort((a, b) => Number(a.expires_at_ms || 0) - Number(b.expires_at_ms || 0));

      const totalOuro = linhas
        .filter(l => !String(l.currency || '').includes('DIAMOND'))
        .reduce((s, l) => s + (Number(l.total) || 0), 0);

      if (!linhas.length) {
        return `<p class="hint">Nenhum anúncio ativo${
          this.mineConta !== null ? ' nesta conta' : ''}. Use a aba <b>Anunciar</b> para criar.</p>`;
      }

      return `
        <div class="mk-cards">
          ${this.cardHtml('Pedido em aberto', totalOuro, 'soma do que está à venda, em ouro')}
          <div class="mk-card">
            <span class="mk-card-label">Anúncios</span>
            <b class="mk-card-value">${linhas.length}</b>
            <small>${contas.map(c => c.limit
          ? `${c.active || 0}/${c.limit}`
          : `${(c.listings || []).length}`).join(' · ')} por conta</small>
          </div>
        </div>

        <table class="mk-table">
          <thead>
            <tr>
              <th class="mk-c-ic" aria-label="Ícone"></th>
              <th class="mk-c-name">Item</th>
              <th class="mk-c-name">Conta</th>
              <th class="mk-c-n">Qtd</th>
              <th class="mk-c-p">Unitário</th>
              <th class="mk-c-p mk-strong">Total</th>
              <th class="mk-c-t" title="Quando o anúncio sai do mercado">Expira</th>
            </tr>
          </thead>
          <tbody>
            ${linhas.map(l => {
          const resta = Number(l.expires_at_ms || 0) - Date.now();
          // Menos de seis horas é o que ainda dá para reagir; depois disso o
          // item volta para a mochila e o anúncio precisa ser refeito.
          const urgente = resta > 0 && resta < 6 * 3600000;
          return `
              <tr data-item="${escape(l.def_id || '')}" tabindex="0">
                <td class="mk-c-ic">${this.iconHtml(l)}</td>
                <td class="mk-c-name">
                  ${this.nameHtml(l, l.level ? ` <span class="mk-nv">nv. ${l.level}</span>` : '')}
                  ${this.subHtml(l)}
                </td>
                <td class="mk-c-name">${escape(l.conta.name || 'conta ' + (l.conta.index + 1))}</td>
                <td class="mk-c-n">${curto(l.quantity)}</td>
                <td class="mk-c-p" title="${cheio(unitPedido(l))}">${moeda(l.currency)} ${curto(unitPedido(l))}</td>
                <td class="mk-c-p mk-strong" title="${cheio(l.total)}">${curto(l.total)}</td>
                <td class="mk-c-t ${urgente ? 'is-warn' : ''}"
                  title="${l.expires_at_ms ? new Date(Number(l.expires_at_ms)).toLocaleString('pt-BR') : 'sem data'}">${
            resta > 0 ? `em ${quando(Date.now() - resta)}` : '—'}</td>
              </tr>`;
        }).join('')}
          </tbody>
        </table>
        <p class="hint">O launcher não cancela anúncios: isso é feito no jogo.</p>`;
    },

    /**
     * O que já foi vendido, por conta.
     *
     * Do banco local, e a aba diz isso. A venda só é registrada pelo push que
     * o servidor manda a quem vendeu, então o histórico começa no primeiro
     * dia de launcher aberto — e `total_sales` do servidor, quando a conta
     * está conectada, mostra o tamanho do que falta.
     */
    mineSalesHtml(contas) {
      const linhas = [];
      for (const c of contas) {
        for (const s of c.sales || []) linhas.push({ ...s, conta: c });
      }
      linhas.sort((a, b) => Number(b.sold_at_ms || 0) - Number(a.sold_at_ms || 0));

      const liquido = linhas
        .filter(l => !String(l.currency || '').includes('DIAMOND'))
        .reduce((s, l) => s + (Number(l.net) || Number(l.total) || 0), 0);
      const servidor = contas.reduce(
        (s, c) => s + ((c.overview && c.overview.totalSales) || 0), 0
      );

      if (!linhas.length) {
        return `<p class="hint">Nenhuma venda registrada${
          this.mineConta !== null ? ' nesta conta' : ''} no período escolhido.${
          servidor ? ` O servidor conta <b>${cheio(servidor)}</b> no total — o launcher só registra
            o que acontece com ele aberto.` : ''}</p>`;
      }

      return `
        <div class="mk-cards">
          ${this.cardHtml('Recebido', liquido, 'líquido, já sem a taxa do jogo')}
          <div class="mk-card">
            <span class="mk-card-label">Vendas</span>
            <b class="mk-card-value">${linhas.length}</b>
            <small>${servidor
          ? `de ${cheio(servidor)} que o servidor conta`
          : 'registradas pelo launcher'}</small>
          </div>
        </div>

        <table class="mk-table">
          <thead>
            <tr>
              <th class="mk-c-ic" aria-label="Ícone"></th>
              <th class="mk-c-name">Item</th>
              <th class="mk-c-name">Conta</th>
              <th class="mk-c-n">Qtd</th>
              <th class="mk-c-p">Total</th>
              <th class="mk-c-p mk-strong" title="O que entrou na conta, já sem a taxa">Líquido</th>
              <th class="mk-c-name">Comprador</th>
              <th class="mk-c-t">Quando</th>
            </tr>
          </thead>
          <tbody>
            ${linhas.map(l => `
              <tr data-item="${escape(l.def_id || '')}" tabindex="0">
                <td class="mk-c-ic">${this.iconHtml(l)}</td>
                <td class="mk-c-name">
                  ${this.nameHtml(l, l.level ? ` <span class="mk-nv">nv. ${l.level}</span>` : '')}
                  ${this.subHtml(l)}
                </td>
                <td class="mk-c-name">${escape(l.conta.name || 'conta ' + (l.conta.index + 1))}</td>
                <td class="mk-c-n">${curto(l.quantity)}</td>
                <td class="mk-c-p" title="${cheio(l.total)}">${moeda(l.currency)} ${curto(l.total)}</td>
                <td class="mk-c-p mk-strong" title="${l.fee ? `taxa de ${cheio(l.fee)}` : cheio(l.net || l.total)}">${
          curto(l.net || l.total)}</td>
                <td class="mk-c-name">${escape(l.buyer_name || '—')}</td>
                <td class="mk-c-t" title="${new Date(Number(l.sold_at_ms)).toLocaleString('pt-BR')}">${quando(l.sold_at_ms)}</td>
              </tr>`).join('')}
          </tbody>
        </table>
        <p class="hint">O histórico é do launcher: uma venda só é registrada se ele estava aberto
          quando ela aconteceu. O servidor não guarda a lista das vendas de uma conta, só o total.</p>`;
    },

    /**
     * Preço por nível.
     *
     * A quebra que faltava. "Topázio" não é um item: são quatro, de nível 1 a
     * 4, vendidos no mesmo nome por preços que no banco real vão de 1 a 10
     * milhões. Somar tudo numa média produzia um número que não serve para
     * comprar nem para vender nenhum deles.
     *
     * A cobertura é mostrada sempre, e é a parte honesta: o nível não vem no
     * feed de vendas, ele é descoberto consultando o anúncio de cada venda,
     * um por vez, em segundo plano. No começo a quebra cobre poucas vendas, e
     * dizer isso é o que impede o usuário de confiar numa amostra de três.
     */
    levelsHtml(it) {
      const dados = (this.levels && this.levels.levels) || [];
      const cob = this.levels && this.levels.coverage;
      const faltam = cob ? Math.max(0, (cob.total || 0) - (cob.perguntadas || 0)) : 0;

      if (!dados.length) {
        if (!cob || !cob.total) return '';
        return `
          <h3 class="mk-group">Por nível</h3>
          <p class="hint">${faltam
            ? `O nível ainda não foi descoberto para ${faltam} das ${cob.total} vendas deste período.
               Ele não vem no feed de vendas — o launcher consulta o anúncio de cada venda em
               segundo plano, alguns por minuto, enquanto uma conta está em modo monitor.`
            : `Nenhuma das ${cob.total} vendas deste período tem nível: o item não varia por nível,
               ou os anúncios já expiraram do servidor antes de poderem ser consultados.`}</p>`;
      }

      // O nível mais caro primeiro na dica, mas a tabela fica em ordem de
      // nível: é como o jogo apresenta, e procurar "o nível 3" numa lista
      // ordenada por preço é mais difícil do que parece.
      const maisVendido = dados.reduce((a, b) => (b.vendas > a.vendas ? b : a), dados[0]);

      return `
        <h3 class="mk-group">Por nível <small>${dados.length} ${
          dados.length === 1 ? 'nível' : 'níveis'
        } distintos${cob && cob.total ? ` · ${cob.comNivel} de ${cob.total} vendas identificadas` : ''}</small></h3>
        <table class="mk-table mk-levels">
          <thead>
            <tr>
              <th class="mk-c-n">Nível</th>
              <th class="mk-c-n">Vendas</th>
              <th class="mk-c-p" title="Média ponderada pela quantidade, só das vendas em ouro">Média</th>
              <th class="mk-c-p mk-c-opt">Mínimo</th>
              <th class="mk-c-p mk-c-opt">Máximo</th>
              <th class="mk-c-p mk-c-dia" title="Mediana das vendas em diamante neste nível">💎</th>
              <th class="mk-c-t">Última</th>
            </tr>
          </thead>
          <tbody>
            ${dados.map(l => `
              <tr class="${l === maisVendido && dados.length > 1 ? 'mk-row-top' : ''}">
                <td class="mk-c-n"><b>nv ${l.level}</b></td>
                <td class="mk-c-n">${l.vendas}<small>${curto(l.unidades)} un</small></td>
                <td class="mk-c-p mk-strong" title="${cheio(l.media)}">${l.media ? curto(l.media) : '—'}</td>
                <td class="mk-c-p mk-c-opt" title="${cheio(l.minimo)}">${l.minimo ? curto(l.minimo) : '—'}</td>
                <td class="mk-c-p mk-c-opt" title="${cheio(l.maximo)}">${l.maximo ? curto(l.maximo) : '—'}</td>
                <td class="mk-c-p mk-c-dia${l.media_dia ? '' : ' is-none'}" title="${
                  l.media_dia ? cheio(l.media_dia) + ' 💎' : 'nenhuma venda em diamante neste nível'
                }">${l.media_dia ? '💎 ' + curto(l.media_dia) : '—'}</td>
                <td class="mk-c-t" title="${new Date(Number(l.ultima_venda_ms)).toLocaleString('pt-BR')}">${decorrido(l.ultima_venda_ms)}</td>
              </tr>`).join('')}
          </tbody>
        </table>
        ${faltam ? `<p class="hint">Faltam ${faltam} de ${cob.total} vendas por identificar. O nível não vem
        no feed: é consultado anúncio por anúncio em segundo plano, e anúncio antigo pode já ter
        expirado do servidor — essas vendas ficam sem nível para sempre.</p>` : ''}
      `;
    },

    /**
     * Preço em diamante.
     *
     * Coluna própria, nunca somada ao ouro. São moedas de ordens de grandeza
     * diferentes — milhares contra dezenas — e a média das duas juntas é um
     * número que não corresponde a nenhuma venda que aconteceu.
     *
     * Vazio quando o item nunca foi vendido em diamante. `0` daria a entender
     * que ele vale nada nessa moeda, quando o fato é que ninguém o vendeu
     * nela.
     */
    diamondCellHtml(row) {
      const n = row && (Number(row.mediana_dia) || Number(row.media_dia) || 0);
      if (!n) {
        return `<td class="mk-c-p mk-c-dia is-none" title="Nunca vendido em diamante no período">—</td>`;
      }
      const vendas = (row && row.vendas_dia) || 0;
      const ultimo = (row && Number(row.ultimo_preco_dia)) || 0;
      const dica = [
        `${cheio(n)} 💎 pela mediana`,
        vendas ? `${vendas} venda(s) em diamante` : '',
        ultimo ? `último: ${cheio(ultimo)} 💎` : ''
      ].filter(Boolean).join('\n');
      return `<td class="mk-c-p mk-c-dia" title="${escape(dica)}">💎 ${curto(n)}</td>`;
    },

    /**
     * "Adicionar ao sniper", no canto da ficha do item.
     *
     * Aqui é onde a decisão acontece: o usuário acabou de ver a mediana, o
     * mínimo e o histórico. Obrigá-lo a abrir outra janela e redigitar o nome
     * do item para transformar isso numa regra perderia o contexto no
     * caminho.
     *
     * Sombra fica de fora: a regra do sniper casa por `def_id`, e uma sombra
     * não é um item do catálogo — a busca nunca a encontraria.
     */
    snipeButtonHtml(it) {
      if (!this.api || !this.api.sniperAdd) return '';
      const sombra = String(it.kind || '') === 'MARKET_KIND_SHADOW' || it.category === 'sombra';
      if (sombra) return '';
      const mediana = Number(it.mediana) || 0;
      if (!mediana) {
        return `<button type="button" class="mk-snipe" disabled
          title="Sem mediana no período: não há de onde tirar um teto">Adicionar ao sniper</button>`;
      }
      return `<button type="button" class="mk-snipe" data-role="snipe"
        title="Cria uma regra de compra automática com teto 20% abaixo da mediana">Adicionar ao sniper</button>`;
    },

    /**
     * A confirmação da regra: teto, quantidade e conta, antes de gravar.
     *
     * O teto já vem preenchido com 20% abaixo da mediana, que é o pedido, mas
     * editável — é dinheiro gastando sozinho, e um número que o usuário não
     * pôde conferir não deveria virar regra. A quantidade é perguntada aqui
     * porque é a única coisa que a tela do item não tem como adivinhar.
     */
    snipeConfirmHtml() {
      const s = this.snipe;
      if (!s) return '';
      const contas = (this.sell.accounts || []).filter(a => a.connected);
      return `
        <div class="mk-snipe-box">
          <h3 class="mk-group">Adicionar ao sniper <small>${escape(s.name)}</small></h3>
          <p class="hint">O sniper compra sozinho, sem perguntar de novo, qualquer anúncio deste
            item que entrar <b>igual ou abaixo</b> do teto. A sugestão é ${Math.round(SNIPE_DESCONTO * 100)}%
            abaixo da mediana de ${cheio(s.median)}.</p>
          <div class="mk-snipe-campos">
            <label class="mk-field">
              <span>Teto 🪙 por unidade</span>
              <input type="number" class="mk-snipe-in" data-role="snipe-max" min="1" step="1" value="${s.maxGold}">
            </label>
            <label class="mk-field">
              <span>Quantidade alvo</span>
              <input type="number" class="mk-snipe-in" data-role="snipe-target" min="0" step="1" value="${s.target}">
              <small>0 = sem limite, compra sempre</small>
            </label>
            <label class="mk-field">
              <span>Conta que paga</span>
              <select data-role="snipe-account">
                ${contas.length
          ? contas.map(a => `<option value="${a.index}"${a.index === s.account ? ' selected' : ''}>${
            escape(`${a.index + 1} · ${a.name || a.username || 'conta'}`)}</option>`).join('')
          : '<option value="">nenhuma conta em modo monitor</option>'}
              </select>
            </label>
          </div>
          <div class="mk-snipe-acoes">
            <button type="button" data-role="snipe-cancel">Cancelar</button>
            <button type="button" class="primary" data-role="snipe-ok"
              ${contas.length && s.maxGold > 0 ? '' : 'disabled'}>Criar regra</button>
          </div>
        </div>`;
    },

    detailHtml() {
      const it = this.data.item;
      if (!it) return `<p class="hint">Nenhuma venda deste item no período escolhido. Tente "tudo".</p>`;

      const h = this.data.hint;
      return `
        <div class="mk-detail">
          ${this.fichaHtml(it)}
          ${this.snipeConfirmHtml()}
          <div class="mk-cards">
            ${this.cardHtml('Mediana', it.mediana, 'o preço do meio — é este o número a usar')}
            ${this.cardHtml('Média', it.media, 'ponderada pela quantidade vendida')}
            ${this.cardHtml('Mínimo', it.minimo)}
            ${this.cardHtml('Máximo', it.maximo)}
            ${this.cardHtml('Último', it.ultimo_preco, quando(it.ultima_venda_ms))}
            <div class="mk-card">
              <span class="mk-card-label">Vendas</span>
              <b class="mk-card-value">${it.vendas}</b>
              <small>${curto(it.unidades)} unidades · ${curto(it.volume)} movimentado</small>
            </div>
            ${it.vendas_dia ? `
              <div class="mk-card mk-card-dia">
                <span class="mk-card-label">💎 Diamante</span>
                <b class="mk-card-value" title="${cheio(it.mediana_dia)}">${curto(it.mediana_dia)}</b>
                <small>mediana em ${it.vendas_dia} venda(s) · média ${curto(it.media_dia)}
                  · ${curto(it.minimo_dia)}–${curto(it.maximo_dia)}</small>
              </div>` : ''}
          </div>

          ${h && h.sales ? `
            <div class="mk-hint">
              <b>O servidor diz</b>, sobre os últimos ${h.days || 30} dias:
              média <b title="${cheio(h.average)}">${curto(h.average)}</b>,
              mediana <b title="${cheio(h.median)}">${curto(h.median)}</b>,
              entre ${curto(h.lowest_sold)} e ${curto(h.highest_sold)},
              em ${h.sales} vendas${h.lowest_now ? ` · menor pedido agora: <b>${curto(h.lowest_now)}</b>` : ''}.
              <small>Cobre um período maior que o banco local, mas sem as vendas por trás.</small>
            </div>` : ''}

          ${this.levelsHtml(it)}

          ${this.ownersHtml(it)}

          ${this.chartHtml(it.series)}

          ${this.listingsHtml()}

          <h3 class="mk-group">Vendas registradas</h3>
          <table class="mk-table mk-live">
            <thead>
              <tr>
                <th class="mk-c-t">Quando</th>
                <th class="mk-c-n">Qtd</th>
                <th class="mk-c-p">Unitário</th>
                <th class="mk-c-p">Total</th>
                <th class="mk-c-n">Ench.</th>
              </tr>
            </thead>
            <tbody>
              ${it.sales.map(s => `
                <tr>
                  <td class="mk-c-t" title="${new Date(Number(s.sold_at_ms)).toLocaleString('pt-BR')}">${quando(s.sold_at_ms)}</td>
                  <td class="mk-c-n">${curto(s.quantity)}</td>
                  <td class="mk-c-p mk-strong" title="${cheio(s.unit_price)}">${curto(s.unit_price)}</td>
                  <td class="mk-c-p" title="${cheio(s.total)}">${curto(s.total)}</td>
                  <td class="mk-c-n">${s.enchant ? '+' + s.enchant : '—'}</td>
                </tr>`).join('')}
            </tbody>
          </table>
        </div>
      `;
    },

    /**
     * Célula "Minhas": quanto as contas têm, e quanto isso valeria.
     *
     * Três estados, e confundi-los levaria a decisões opostas:
     *
     *   `—`  ainda não perguntei, ou nenhuma conta está conectada
     *   `0`  perguntei e nenhuma conta tem
     *   `n`  tenho, e o `title` diz em quais contas
     *
     * O valor estimado usa a mediana, não a média: é o número que representa
     * o item quando o mercado tem vendas extremas, que é sempre.
     */
    ownedCellHtml(row) {
      const own = this.ownedOf(row.def_id);
      if (!own) {
        return `<td class="mk-c-own is-unknown" title="Nenhuma conta em modo monitor — não há como saber o que você tem">—</td>`;
      }
      if (!own.total && !own.equipped) {
        return `<td class="mk-c-own is-zero" title="Nenhuma das suas contas tem este item">0</td>`;
      }

      const preco = Number(row.mediana) || Number(row.media) || 0;
      const vale = preco * own.total;
      const onde = own.accounts
        .map(a => `${a.name || 'conta ' + (a.index + 1)}: ${cheio(a.qty)}${a.equipped ? ` (+${a.equipped} equipado)` : ''}`)
        .join('\n');
      const dica = [
        onde,
        own.equipped ? `${own.equipped} equipado — não está disponível para vender` : '',
        vale ? `≈ ${cheio(vale)} pela mediana` : ''
      ].filter(Boolean).join('\n');

      return `
        <td class="mk-c-own is-owned" title="${escape(dica)}">
          <b>${curto(own.total)}</b>
          <small>${own.accounts.length === 1
            ? escape(own.accounts[0].name || 'conta ' + (own.accounts[0].index + 1))
            : own.accounts.length + ' contas'}</small>
        </td>`;
    },

    /**
     * Cabeçalho do detalhe: ícone grande, nome na cor da raridade e o que o
     * catálogo sabe do item — slot, categoria, empilhável e os atributos
     * base. Para sombra o catálogo não tem ficha; o que a descreve são os
     * anúncios ativos, logo abaixo.
     */
    fichaHtml(it) {
      const v = this.look(it);
      const def = v.def;
      const linhas = [];
      if (v.label) linhas.push(['Raridade', v.label]);
      if (def && def.slot) linhas.push(['Slot', def.slot]);
      if (it.category) linhas.push(['Categoria', it.category]);
      if (def && def.stackable) linhas.push(['Pilha', 'empilhável']);

      const atributos = def && def.stats
        ? Object.entries(def.stats).map(([k, n]) => `${STATS[k] || k} ${n}`)
        : [];

      const cor = v.color ? ` style="--mk-cor:${escape(v.color)}"` : '';
      const nomeCor = v.color ? ` style="color:${escape(v.color)}"` : '';
      const src = v.icon ? this.catalog.origin + v.icon : '';

      return `
        <div class="mk-ficha">
          <span class="mk-icon mk-icon-lg"${cor}>${
            src ? `<img src="${escape(src)}" alt="" onerror="this.remove()">` : ''
          }</span>
          <div class="mk-ficha-txt">
            <b class="mk-ficha-nome"${nomeCor}>${escape(it.name)}</b>
            ${linhas.length ? `<span class="mk-ficha-tags">${
              linhas.map(([, valor]) => `<em>${escape(valor)}</em>`).join('')
            }</span>` : ''}
            ${atributos.length ? `<span class="mk-ficha-stats">${
              atributos.map(a => `<em>${escape(a)}</em>`).join('')
            }</span>` : ''}
          </div>
          ${this.snipeButtonHtml(it)}
        </div>`;
    },

    /**
     * Quais das minhas contas têm este item.
     *
     * É a ponte entre as duas metades da decisão: o preço diz quanto vale, e
     * isto diz se tenho e onde está. Com oito contas, essa segunda metade
     * estava em oito inventários que o launcher nunca abria.
     *
     * O valor estimado fica por conta e no total, pela mediana. Equipado
     * aparece à parte, porque está no patrimônio mas não à venda.
     */
    ownersHtml(it) {
      const own = this.ownedOf(it.def_id);
      if (!own) {
        return `
          <h3 class="mk-group">Nas minhas contas</h3>
          <p class="hint">Nenhuma conta em modo monitor agora. O inventário é lido pela sessão de
          cada conta, então sem monitor não há como saber o que você tem — e mostrar zero aqui
          seria afirmar que você não tem.</p>`;
      }

      const preco = Number(it.mediana) || Number(it.media) || 0;

      if (!own.total && !own.equipped) {
        return `
          <h3 class="mk-group">Nas minhas contas</h3>
          <p class="hint">Nenhuma das ${this.owners.accounts.length} contas conectadas tem este item${
            this.owners.offline.length ? `, e ${this.owners.offline.length} não estão em modo monitor` : ''
          }.</p>`;
      }

      return `
        <h3 class="mk-group">Nas minhas contas <small>${curto(own.total)} em ${own.accounts.length} ${
          own.accounts.length === 1 ? 'conta' : 'contas'
        }${preco ? ` · ≈ ${curto(preco * own.total)} pela mediana` : ''}</small></h3>
        <table class="mk-table mk-owners">
          <thead>
            <tr>
              <th class="mk-c-name">Conta</th>
              <th class="mk-c-n">Mochila</th>
              <th class="mk-c-n" title="O depósito não é lido pelo mercado, mas conta como seu">Depósito</th>
              <th class="mk-c-n" title="Vestido no personagem ou numa sombra: é seu, mas não está à venda">Equipado</th>
              <th class="mk-c-name" title="A melhor peça que esta conta tem deste item">Melhor</th>
              <th class="mk-c-p" title="Quantidade disponível pela mediana do mercado">Valor</th>
            </tr>
          </thead>
          <tbody>
            ${own.accounts.map(a => {
              const m = a.melhor;
              const r = m && this.catalog.rarities[m.rarity];
              const estilo = r && r.color ? ` style="color:${escape(r.color)}"` : '';
              return `
                <tr>
                  <td class="mk-c-name"><b>${escape(a.name || 'conta ' + (a.index + 1))}</b></td>
                  <td class="mk-c-n">${a.bag ? curto(a.bag) : '—'}</td>
                  <td class="mk-c-n">${a.warehouse ? curto(a.warehouse) : '—'}</td>
                  <td class="mk-c-n">${a.equipped ? curto(a.equipped) : '—'}</td>
                  <td class="mk-c-name"${estilo}>${m
                    ? `${escape((r && r.name) || m.rarity || '—')}${m.level ? ` · nv ${m.level}` : ''}${
                        m.enchant ? ` · +${m.enchant}` : ''
                      }${m.power ? ` · ${curto(m.power)} pd` : ''}${m.locked ? ' 🔒' : ''}`
                    : '—'}</td>
                  <td class="mk-c-p" title="${cheio(preco * a.qty)}">${a.qty && preco ? curto(preco * a.qty) : '—'}</td>
                </tr>`;
            }).join('')}
          </tbody>
        </table>
        ${this.owners.offline.length ? `
          <p class="hint">${this.owners.offline.length} ${
            this.owners.offline.length === 1 ? 'conta não está' : 'contas não estão'
          } em modo monitor e ${this.owners.offline.length === 1 ? 'não foi' : 'não foram'} consultada${
            this.owners.offline.length === 1 ? '' : 's'
          }: ${escape(this.owners.offline.map(o => o.name || 'conta ' + (o.index + 1)).join(', '))}.</p>` : ''}
      `;
    },

    /**
     * Anúncios à venda agora. Separado do histórico de propósito: é preço
     * pedido, não preço pago, e um vendedor pode pedir o que quiser. Vale
     * porque é a única linha que mostra nível, potência e qualidade — e
     * porque diz por quanto dá para comprar neste instante.
     */
    listingsHtml() {
      if (!this.listings.length) return '';
      const sombra = this.listings.some(l => l.shadow);
      return `
        <h3 class="mk-group">À venda agora <small>preço pedido, não preço pago</small></h3>
        <table class="mk-table mk-live">
          <thead>
            <tr>
              <th class="mk-c-p">Pedido</th>
              <th class="mk-c-n">Qtd</th>
              ${sombra
                ? '<th class="mk-c-n">Nível</th><th class="mk-c-n">Poder</th><th class="mk-c-name">Rank / qualidade</th>'
                : '<th class="mk-c-n">Nível</th><th class="mk-c-name">Raridade / slot</th>'}
              <th class="mk-c-t">Expira</th>
            </tr>
          </thead>
          <tbody>
            ${this.listings.map(l => {
              const s = l.shadow;
              const i = l.item;
              const rank = s ? this.catalog.shadowRanks[s.rank] : null;
              const rar = i ? this.catalog.rarities[i.rarity] : null;
              const cor = (rank && rank.color) || (rar && rar.color) || '';
              const estilo = cor ? ` style="color:${escape(cor)}"` : '';
              // Câmbio manda o preço do lote em `unit_price` (medido:
              // `unit_price == total` num pacote de 10). Repetir o número
              // aqui diria que o pacote custa dez vezes mais por unidade do
              // que o avulso, quando ele é justamente o mais barato.
              const unit = unitPedido(l);
              return `
                <tr>
                  <td class="mk-c-p mk-strong" title="${cheio(unit)}">${moeda(l.currency)} ${curto(unit)}</td>
                  <td class="mk-c-n">${curto(l.quantity)}</td>
                  ${sombra ? `
                    <td class="mk-c-n">${(s && s.level) || '—'}</td>
                    <td class="mk-c-n">${s && s.power ? curto(s.power) : '—'}</td>
                    <td class="mk-c-name"${estilo}>${escape((rank && rank.name) || (s && s.rank) || '—')}${
                      s && s.quality ? ` · ${escape(s.quality)}` : ''
                    }${s && s.potential_total ? ` · pot ${s.potential_total}` : ''}</td>`
                  : `
                    <td class="mk-c-n">${(i && i.level) || '—'}</td>
                    <td class="mk-c-name"${estilo}>${escape((rar && rar.name) || (i && i.rarity) || '—')}${
                      i && i.slot ? ` · ${escape(i.slot)}` : ''
                    }</td>`}
                  <td class="mk-c-t">${restante(l.expires_at_ms)}</td>
                </tr>`;
            }).join('')}
          </tbody>
        </table>`;
    },

    /**
     * A aba "Anunciar".
     *
     * Três estados em sequência, e a tela só mostra um de cada vez: escolher
     * a conta, escolher os itens e o preço, confirmar. A confirmação é um
     * passo separado de propósito — anunciar é irreversível pelo launcher
     * (cancelar não passa por aqui), e o usuário pediu para ver cada item e
     * o valor antes de acontecer.
     */
    sellHtml() {
      const s = this.sell;
      if (s.results) return this.sellResultsHtml();
      if (s.confirm) return this.sellConfirmHtml();

      const seletor = `
        <div class="mk-sell-bar">
          <label class="mk-field">
            <span>Conta</span>
            <select data-role="sell-account">
              <option value="">escolha a conta</option>
              ${s.accounts.map(a => {
        const nome = a.name || a.username || `Conta ${a.index + 1}`;
        return `<option value="${a.index}"${s.account === a.index ? ' selected' : ''}
                  ${a.connected ? '' : ' disabled'}>${escape(
          `${a.index + 1} · ${nome}${a.connected ? '' : ' (fora do monitor)'}`)}</option>`;
      }).join('')}
            </select>
          </label>
          ${s.account !== null ? `
            <label class="mk-check">
              <input type="checkbox" data-role="sell-equip" ${s.showEquip ? 'checked' : ''}>
              <span>Mostrar equipamentos vestidos</span>
            </label>` : ''}
        </div>`;

      if (s.account === null) {
        const vivas = s.accounts.filter(a => a.connected).length;
        return `${seletor}
          <p class="hint">${vivas
          ? 'Escolha a conta cujo inventário você quer anunciar.'
          : 'Nenhuma conta está em <b>modo monitor</b>. Anunciar sai do socket da conta, então é preciso ligar o monitor de pelo menos uma.'}</p>`;
      }

      if (s.loading) return `${seletor}<p class="hint">Lendo o inventário…</p>`;
      if (s.error) {
        return `${seletor}<p class="hint">Não foi possível ler o inventário (<code>${escape(s.error)}</code>).</p>`;
      }

      const linhas = this.sellRows();
      if (!linhas.length) {
        // Dois vazios diferentes: "a conta não tem nada vendável" e "o
        // filtro não deixou nada passar". Confundi-los faria o usuário
        // concluir que a conta está vazia quando ele só escolheu mal a
        // categoria.
        return `${seletor}${this.sellFiltered()
          ? `<p class="hint">Nenhum item com esses filtros.
              <button type="button" class="mk-link" data-role="sell-clear">Limpar filtros</button></p>`
          : '<p class="hint">Nada nesta conta pode ir para o mercado agora.</p>'}`;
      }

      // A conta é de *tudo* que está marcado, não só do que está à vista: o
      // filtro esconde linha, não desmarca item, e um total que ignorasse o
      // escondido mentiria sobre o que o botão vai anunciar.
      const soma = [...s.picked.values()].reduce((t, v) => t + v, 0);
      const marcadosTotal = s.picked.size;
      const semPreco = [...s.picked.values()].filter(v => !v).length;
      const visiveisMarcados = linhas.filter(l => s.picked.has(l.uid)).length;
      const ocultos = marcadosTotal - visiveisMarcados;
      const todos = visiveisMarcados === linhas.length;

      return `
        ${seletor}
        <table class="mk-table mk-sell">
          <thead>
            <tr>
              <th class="mk-c-pick">
                <input type="checkbox" data-role="sell-all" ${todos ? 'checked' : ''}
                  aria-label="Marcar todos" title="Marca os ${linhas.length} itens à vista">
              </th>
              <th class="mk-c-name">Item</th>
              <th class="mk-c-n">Qtd</th>
              <th class="mk-c-p" title="Maior das últimas vendas, descartando as anormais">Sugerido</th>
              <th class="mk-c-p">Preço do anúncio</th>
              <th class="mk-c-n">Auto</th>
            </tr>
          </thead>
          <tbody>
            ${linhas.map(it => this.sellRowHtml(it)).join('')}
          </tbody>
        </table>

        <div class="mk-sell-foot">
          <span>${marcadosTotal
          ? `<b>${marcadosTotal}</b> ${marcadosTotal === 1 ? 'item marcado' : 'itens marcados'} · ${curto(soma)} 🪙${
            semPreco ? ` · <b class="is-warn">${semPreco} sem preço</b>` : ''}${
            ocultos ? ` · <span class="is-warn">${ocultos} fora do filtro</span>` : ''}`
          : `Nenhum item marcado. <span class="mk-unit">${linhas.length} à vista${
            this.sellFiltered() ? ` de ${this.sellRowsAll()} vendáveis` : ''}</span>`}</span>
        </div>`;
    },

    /** Uma peça do inventário. */
    sellRowHtml(it) {
      const s = this.sell;
      const marcado = s.picked.has(it.uid);
      const auto = s.auto.has(it.uid);
      const preco = s.picked.get(it.uid) || 0;
      const def = this.catalog.items[it.defId];
      const src = def && def.icon ? this.catalog.origin + def.icon : '';
      const from = it.suggestionFrom || {};
      const sugerido = this.sellSuggested(it);

      // De onde o preço sugerido veio. Um número sem procedência não dá para
      // julgar, e o do servidor é mais grosso: `price_hint` não conhece nível.
      const dica = !it.suggestion
        ? 'Sem vendas suficientes para sugerir um preço — digite o valor.'
        : `${from.source === 'server'
          ? `Estimativa do servidor sobre ${from.samples || 0} vendas de 30 dias. Não considera o nível do item.`
          : `Maior das ${from.samples} últimas vendas${it.level ? ` de nível ${it.level}` : ''}${
            from.dropped ? `, descartando ${from.dropped} anormal${from.dropped > 1 ? 'is' : ''}` : ''
          }. Mediana ${cheio(from.median)}.`}${
          it.qty > 1 ? ` ${cheio(it.suggestion)} por unidade × ${it.qty} = ${cheio(sugerido)} pelo lote.` : ''}`;

      return `
        <tr class="${marcado ? 'is-picked' : ''}${it.blocked === 'equipped' ? ' is-equipped' : ''}">
          <td class="mk-c-pick">
            <input type="checkbox" data-pick="${escape(it.uid)}" ${marcado ? 'checked' : ''}
              ${it.blocked ? 'disabled' : ''}>
          </td>
          <td class="mk-c-name">
            <span class="mk-icon">${src
          ? `<img src="${escape(src)}" alt="" width="24" height="24" loading="lazy" decoding="async" onerror="this.remove()">`
          : ''}</span>
            ${this.gearNameHtml(it)}
            ${this.gearSubHtml(it)}
          </td>
          <td class="mk-c-n">${curto(it.qty)}</td>
          <td class="mk-c-p ${it.suggestion ? '' : 'is-none'}" title="${escape(dica)}">${
          sugerido ? curto(sugerido) : '—'}${
          from.source === 'server' ? '<small class="mk-src">servidor</small>' : ''}${
          // O unitário sob o sugerido quando há lote: o número grande é o do
          // pacote, e sem o de baixo não se sabe se o lote está caro ou se o
          // item é caro.
          it.qty > 1 && it.suggestion ? `<small class="mk-unit">${curto(it.suggestion)} cada</small>` : ''}</td>
          <td class="mk-c-p">
            <input type="number" class="mk-price" data-price="${escape(it.uid)}" min="0" step="1"
              value="${marcado ? preco : ''}" placeholder="${sugerido || 0}"
              ${marcado && !it.blocked ? '' : 'disabled'}
              title="${it.qty > 1 ? `Preço dos ${it.qty} juntos` : 'Preço do item'}">
            ${it.qty > 1 && marcado && preco
          ? `<small class="mk-unit">${curto(Math.ceil(preco / it.qty))} cada</small>` : ''}
          </td>
          <td class="mk-c-n">
            <input type="checkbox" data-auto="${escape(it.uid)}" ${auto ? 'checked' : ''}
              ${marcado && it.suggestion ? '' : 'disabled'}
              title="Acompanha o preço sugerido">
          </td>
        </tr>`;
    },

    /**
     * Nome de uma peça do inventário, como o jogo a identifica.
     *
     * O jogo não chama a peça de "Espada": chama de "Espada lendária nv. 12".
     * Raridade, nível e encantamento não são decoração — são o que distingue
     * duas linhas de mesmo nome que valem preços de ordens de grandeza
     * diferentes. A cor do nome já carrega a raridade, mas cor sozinha exige
     * decorar a paleta; o nome escrito ao lado dispensa isso.
     */
    gearNameHtml(it) {
      const def = this.catalog.items[it.defId] || {};
      const rarityId = String(it.rarity || def.rarity || '');
      const rar = this.catalog.rarities[rarityId];
      const cor = rar && rar.color ? ` style="color:${escape(rar.color)}"` : '';
      const nomeRar = (rar && rar.name) || rarityId;
      const partes = [escape(def.name || it.defId)];
      if (nomeRar) partes.push(`<span class="mk-rar">${escape(String(nomeRar).toLowerCase())}</span>`);
      if (it.level) partes.push(`<span class="mk-nv">nv. ${it.level}</span>`);
      if (it.enchant) partes.push(`<span class="mk-ench">+${it.enchant}</span>`);
      return `<b${cor}>${partes.join(' ')}</b>`;
    },

    /**
     * Linha de baixo: poder, slot e o que impede o anúncio.
     *
     * Poder é o número que o jogo usa para comparar duas peças, e é por ele
     * que o comprador decide — mostrá-lo aqui é o que permite julgar se o
     * preço sugerido faz sentido para *esta* peça e não para a média do nome.
     */
    gearSubHtml(it) {
      const def = this.catalog.items[it.defId] || {};
      const partes = [];
      if (it.power) partes.push(`${curto(Math.round(it.power))} pd`);
      if (def.slot) partes.push(escape(String(def.slot).toLowerCase()));
      if (def.category) partes.push(escape(String(def.category).toLowerCase()));
      if (it.sellPrice) partes.push(`NPC ${curto(it.sellPrice)}`);
      if (it.blocked === 'equipped') partes.push('<b class="is-warn">vestido</b>');
      return partes.length ? `<small>${partes.join(' · ')}</small>` : '';
    },

    /**
     * A verificação. Cada item e o valor que vai ser anunciado, antes de
     * qualquer coisa sair daqui.
     */
    sellConfirmHtml() {
      const c = this.sell.confirm;
      return `
        <h3 class="mk-group">Confirmar anúncios <small>${c.ready.length} ${
        c.ready.length === 1 ? 'item' : 'itens'} · ${this.sell.busy ? 'enviando…' : 'nada foi anunciado ainda'}</small></h3>

        ${c.blocked.length ? `
          <p class="hint">${c.blocked.length} ${c.blocked.length === 1 ? 'item ficou' : 'itens ficaram'} de fora
            por não ter preço: ${escape(c.blocked.map(b => b.name).join(', '))}.</p>` : ''}

        <table class="mk-table">
          <thead>
            <tr>
              <th class="mk-c-name">Item</th>
              <th class="mk-c-n">Qtd</th>
              <th class="mk-c-p" title="É o que o servidor recebe: o preço do lote dividido pela quantidade">Unitário</th>
              <th class="mk-c-p">Total do lote</th>
            </tr>
          </thead>
          <tbody>
            ${c.ready.map(d => `
              <tr>
                <td class="mk-c-name"><b>${escape(d.name)}</b><small>${
        d.auto ? 'preço automático' : 'preço digitado'}${
        // Lote é o caso em que o erro custa caro: dizer "× 10" na própria
        // linha é o que deixa ver se o total pedido é pelos dez ou por um.
        d.quantity > 1 ? ` · lote de ${d.quantity}` : ''}</small></td>
                <td class="mk-c-n${d.quantity > 1 ? ' mk-strong' : ''}">${curto(d.quantity)}</td>
                <td class="mk-c-p" title="${cheio(d.unitPrice)}">${curto(d.unitPrice)}</td>
                <td class="mk-c-p mk-strong" title="${cheio(d.total)}">${curto(d.total)}</td>
              </tr>`).join('')}
          </tbody>
          <tfoot>
            <tr>
              <td colspan="3">Total pedido</td>
              <td class="mk-c-p mk-strong" title="${cheio(c.totalGold)}">${curto(c.totalGold)} 🪙</td>
            </tr>
          </tfoot>
        </table>

        <p class="hint">O anúncio dura <b>2 dias</b>. A taxa de venda é cobrada pelo jogo sobre o
          valor recebido, não sobre o pedido. O launcher não cancela anúncios: isso é feito no jogo.
          Os botões de <b>Voltar</b> e <b>Anunciar</b> estão no rodapé da janela.</p>`;
    },

    /** O que aconteceu com cada item. Falha parcial é o caso normal. */
    sellResultsHtml() {
      const r = this.sell.results;
      const ok = r.filter(x => x.ok).length;
      return `
        <h3 class="mk-group">Resultado <small>${ok} de ${r.length} ${
        r.length === 1 ? 'anunciado' : 'anunciados'}</small></h3>
        <table class="mk-table">
          <thead>
            <tr>
              <th class="mk-c-name">Item</th>
              <th class="mk-c-p">Pedido</th>
              <th class="mk-c-name">Situação</th>
            </tr>
          </thead>
          <tbody>
            ${r.map(x => `
              <tr class="${x.ok ? '' : 'is-err'}">
                <td class="mk-c-name"><b>${escape(x.name || '—')}</b></td>
                <td class="mk-c-p">${x.total ? curto(x.total) : '—'}</td>
                <td class="mk-c-name">${x.ok
        ? '✅ anunciado'
        : `❌ ${escape(ERROS_ANUNCIO[x.error] || x.error || 'recusado')}`}</td>
              </tr>`).join('')}
          </tbody>
        </table>
        <div class="mk-sell-foot">
          <button type="button" class="primary" data-role="sell-done">Voltar ao inventário</button>
        </div>`;
    },

    cardHtml(label, valor, nota) {
      return `
        <div class="mk-card">
          <span class="mk-card-label">${escape(label)}</span>
          <b class="mk-card-value" title="${cheio(valor)}">${curto(valor)}</b>
          ${nota ? `<small>${escape(nota)}</small>` : ''}
        </div>`;
    },

    /**
     * Preço médio por dia, em barras. Um gráfico de verdade exigiria canvas e
     * uma biblioteca; o que a pergunta "está subindo ou caindo?" precisa é da
     * forma, e a forma cabe em divs com altura proporcional.
     */
    chartHtml(series) {
      if (!series || series.length < 2) return '';
      const maximo = Math.max(...series.map(p => p.media || 0));
      if (!maximo) return '';
      return `
        <h3 class="mk-group">Preço médio por dia</h3>
        <div class="mk-chart" role="img" aria-label="Preço médio por dia">
          ${series.map(p => {
            const altura = Math.max(2, Math.round((p.media / maximo) * 100));
            const dia = new Date(Number(p.dia_ms)).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
            return `
              <div class="mk-bar-wrap" title="${dia}: média ${cheio(p.media)} em ${p.vendas} vendas (de ${cheio(p.minimo)} a ${cheio(p.maximo)})">
                <div class="mk-bar-fill" style="height:${altura}%"></div>
                <span class="mk-bar-label">${dia.slice(0, 5)}</span>
              </div>`;
          }).join('')}
        </div>`;
    },

    /**
     * O vazio tem duas causas muito diferentes, e tratá-las igual deixaria o
     * usuário esperando por dados que nunca viriam: ou o banco ainda não teve
     * tempo de encher, ou o filtro é que não casa com nada.
     */
    emptyHtml() {
      const vazio = !this.data.stats || !this.data.stats.vendas;
      if (vazio) {
        return `
          <p class="hint">Ainda não há vendas guardadas. O launcher lê o mercado de minuto em
          minuto <b>enquanto alguma conta está em modo monitor</b>, e o histórico cresce a
          partir daí — o servidor só mostra os últimos 30 minutos, então o que vale é o
          tempo que o launcher ficar ligado.</p>`;
      }
      return `<p class="hint">Nenhuma venda com esses filtros. Tente um período maior ou limpe a busca.</p>`;
    },

    itemName() {
      const it = this.data.item;
      return (it && it.name) || this.defId || 'item';
    },

    /**
     * Um recado na barra de rodapé, por alguns segundos.
     *
     * A barra normalmente mostra o estado do banco; um recado a ocupa e ela
     * volta sozinha ao normal. É o lugar certo para "regra criada": a ação
     * aconteceu em outra janela, e sem confirmação o clique pareceria não ter
     * feito nada.
     */
    say(texto, aviso) {
      const barra = document.getElementById('marketStatusBar');
      if (!barra) return;
      barra.textContent = texto;
      barra.className = aviso ? 'lv-status-bar is-warn' : 'lv-status-bar';
      clearTimeout(this.sayTimer);
      this.sayTimer = setTimeout(() => { this.sayTimer = null; this.paintStatus(); }, 6000);
    },

    /** Barra de rodapé: diz o que o banco tem e se o coletor está vivo. */
    paintStatus() {
      const barra = document.getElementById('marketStatusBar');
      if (!barra) return;

      // Um recado em curso tem precedência: ele responde a um clique que o
      // usuário acabou de dar, e o estado do banco pode esperar seis
      // segundos. Sem isto o coletor apagaria a confirmação ao repintar.
      if (this.sayTimer) return;

      if (this.erro) {
        barra.textContent = this.erro;
        barra.className = 'lv-status-bar is-warn';
        return;
      }
      if (this.loading) {
        barra.textContent = 'Consultando…';
        barra.className = 'lv-status-bar';
        return;
      }

      const s = this.data.stats;
      if (!s || !s.ready) {
        barra.textContent = s && s.error ? `Banco indisponível: ${s.error}` : 'Banco de preços ainda não aberto.';
        barra.className = 'lv-status-bar is-warn';
        return;
      }
      const mb = s.bytes ? ` · ${(s.bytes / 1048576).toFixed(1)} MB` : '';
      barra.textContent = s.vendas
        ? `${cheio(s.vendas)} vendas de ${cheio(s.itens)} itens, desde ${new Date(Number(s.desde_ms)).toLocaleString('pt-BR')}${mb}`
        : 'Nenhuma venda guardada ainda.';
      barra.className = 'lv-status-bar';
    }
  };

  window.PioMarket = PioMarket;
})();

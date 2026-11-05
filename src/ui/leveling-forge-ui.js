/**
 * @file leveling-forge-ui.js
 * Tela da auto-forja: o que cada slot de cada conta tem hoje, o que daria para
 * forjar nele agora, e quanto isso custa.
 *
 * A pergunta mudou em relação à primeira versão. Antes era "quanto custa levar
 * todas as contas ao nível 60 lendário". Agora é **"o que esta conta, com o que
 * ela já tem na bolsa, consegue melhorar hoje"** — porque alvo único não existe:
 * uma conta está no 30 com raras, outra no 80 com épicas, e o mesmo número não
 * serve às duas.
 *
 * ## A grade é a razão de ser da tela
 *
 * Esta é a automação que **destrói mais coisa** do launcher: desmontar apaga a
 * peça para sempre — não há token de respec que a traga de volta, ao contrário
 * do ponto de atributo — e cada fusão consome cinco peças de uma vez. Então a
 * grade mostra, slot a slot e antes de qualquer botão: o que está no corpo, o
 * que a fusão produziria, e com quais níveis.
 *
 * Os níveis de entrada vão à vista de propósito. O nível de saída de uma fusão
 * é o **menor** dos cinco insumos, e ver "55, 55, 55, 55, 52 → 52" é a única
 * forma de o usuário perceber que uma peça atrasada puxou a fusão para baixo.
 *
 * Tudo vem pronto de `leveling-forge.js`, pelo mesmo código que decide a
 * rodada. Uma estimativa calculada aqui em paralelo poderia divergir do que de
 * fato acontece, e seria pior que nenhuma.
 *
 * ## Por que salvar não forja
 *
 * No auto-status, salvar a tela já distribui os pontos parados — o usuário que
 * escolheu a build espera ver o efeito. Aqui é o contrário, de propósito:
 * salvar só guarda a política. O gesto de marcar uma caixinha não pode ser o
 * que começa a apagar equipamento. Quem dispara a rodada é o próximo drop da
 * caçada, ou o botão "Forjar agora", que diz no título o que faz.
 */

(() => {
  'use strict';

  const escape = s => String(s === undefined || s === null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

  /** Hora do dia, para a coluna do relatório. */
  const relogio = ms => {
    const n = Number(ms);
    if (!n) return '';
    const d = new Date(n);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  };

  const num = n => (Number(n) || 0).toLocaleString('pt-BR');

  /**
   * Motivos, em português. O código fica no `title`.
   *
   * Quase todos significam que o launcher **não destruiu** nada — e isso é bom,
   * não defeito. `noPositiveWindow` é o mais importante da lista: a conta já
   * está no melhor que o material dela permite, e a automação para por si. Um
   * usuário que lesse isso como falha iria mexer em configuração sem motivo.
   */
  const MOTIVOS = {
    'forge.off': 'a auto-forja está desligada',
    'forge.accountOff': 'esta conta está de fora',
    'forge.noRules': 'as regras de fusão do jogo ainda não foram lidas: conecte o monitor',
    'forge.badRarity': 'a raridade escolhida para o teto de desmonte não existe no jogo',
    'forge.dismantleClash': 'o teto de desmonte alcança a raridade que a fusão consome: baixe o teto',
    'forge.noPositiveWindow': 'nenhuma fusão possível sairia melhor do que o que já está equipado',
    'forge.equipFirst': 'a bolsa já tem peça melhor: equipar sai de graça, e vem antes de forjar',
    'forge.noInputs': 'aguardando peças: ainda não há cinco do mesmo slot e raridade',
    'forge.noDust': 'falta pó arcano, e não há peça descartável suficiente para cobrir',
    'forge.noGain': 'a peça forjada não melhorou nada: a estimativa de poder errou',
    'forge.badUid': 'o servidor mandou um id de item ilegível',
    'forge.fuseFailed': 'o servidor recusou a fusão',
    'forge.dismantleFailed': 'o servidor recusou o desmonte',
    'forge.equipFailed': 'o servidor recusou equipar'
    ,'forge.inventoryRefreshFailed': 'não foi possível atualizar o inventário após uma operação; aguardando a próxima rodada'
    ,'item.equipped': 'o servidor já considera o item equipado; inventário será atualizado'
    ,'item.alreadyBest': 'a conta já está com o melhor equipamento disponível'
  };

  const PioForge = {
    api: null,
    config: { enabled: false, dismantleUpTo: '', disabled: [], slotsOff: [], keep: [] },
    accounts: [],
    rarities: [],
    rules: null,
    slots: [],
    log: [],
    saving: false,
    timer: null,

    async init(api) {
      this.api = api || window.pokeAPI;
      if (!this.api || !this.api.forgeGet) return;

      if (this.api.onForge) {
        // A rodada é disparada pelo monitor, não por esta janela: cada fusão e
        // cada desmonte aparecem sem a tela perguntar.
        this.api.onForge(() => this.load());
      }

      await this.load();
      this.wire();

      // Releitura periódica, como no câmbio e no status: as contas caçam
      // sozinhas, e o material entra na bolsa sem a janela saber. Sem `force`:
      // usa o resumo que a última rodada apurou, em vez de varrer a bolsa de
      // cada conta a cada quinze segundos.
      this.timer = setInterval(() => {
        if (!this.saving) this.load();
      }, 15000);
    },

    async load(force) {
      const res = await this.api.forgeGet(force ? { force: true } : undefined).catch(() => null);
      if (!res) {
        this.say('Não foi possível ler a configuração da forja.', true);
        return;
      }
      this.apply(res);
      this.render();
    },

    apply(res) {
      if (res.config) this.config = res.config;
      if (res.accounts) this.accounts = res.accounts;
      if (res.rarities) this.rarities = res.rarities;
      if (res.slots) this.slots = res.slots;
      if (res.log) this.log = res.log;
      // `rules` pode vir nulo de propósito — é o que significa "o catálogo
      // ainda não foi lido" — então substitui sempre, sem guarda de presença.
      this.rules = res.rules || null;
    },

    // ------------------------------------------------------------- desenho

    render() {
      this.renderControls();
      this.renderAccounts();
      this.renderLog();
    },

    /**
     * As políticas. Não há mais alvo aqui: ele é derivado de cada conta.
     *
     * O que sobrou é pequeno de propósito. Antes esta área pedia nível e
     * raridade, e era ela que fazia a automação errar nas contas que não se
     * pareciam com a média — o alvo que servia à conta de nível 80 fazia a de
     * nível 30 moer inventário atrás de algo que ela não ia equipar tão cedo.
     *
     * O teto de desmonte continua, mas agora é **opcional**: vazio significa as
     * duas raridades mais baixas, que é o que paga a conta sem nunca destruir
     * insumo. Escolher um teto mais alto é assumir o risco, e a tela avisa
     * quando ele alcança o que a fusão consome.
     */
    renderControls() {
      const host = document.getElementById('forgeControls');
      if (!host) return;

      if (!this.rarities.length) {
        host.innerHTML = `
          <label class="xp-master">
            <input type="checkbox" id="forgeEnabled" ${this.config.enabled ? 'checked' : ''}>
            <span>Forjar automaticamente</span>
          </label>
          <p class="hint">As raridades e as regras de fusão do jogo ainda não foram lidas. Elas chegam no
            primeiro login de qualquer conta em modo monitor — ligue um monitor e esta tela se completa.</p>`;
        return;
      }

      const inputs = this.rules ? this.rules.inputs : 0;

      host.innerHTML = `
        <label class="xp-master">
          <input type="checkbox" id="forgeEnabled" ${this.config.enabled ? 'checked' : ''}>
          <span>Forjar automaticamente</span>
        </label>

        <div class="xp-row">
          <label title="Tudo até esta raridade vira pó arcano no começo de cada rodada. Vazio usa as duas raridades mais baixas, que nunca servem de insumo. Um teto mais alto pode alcançar o material da própria fusão.">
            <span>Desmontar até</span>
            ${this.raritySelect('forgeDismantle', this.config.dismantleUpTo, 'comum e incomum')}
          </label>

          <label title="Teto de peças desmontadas por rodada. Existe para que uma configuração errada não esvazie a bolsa de uma vez.">
            <span>por rodada, no máx.</span>
            <input type="number" id="forgeMaxDismantle" min="1" max="100" step="1"
              value="${Number(this.config.maxDismantle) || 50}">
          </label>

          <label title="Quantas fusões por rodada. Cada uma consome cinco peças, então cinco fusões são vinte e cinco peças de uma vez. O que não couber na rodada é refeito na seguinte, com o inventário relido.">
            <span>Fusões por rodada</span>
            <input type="number" id="forgeMaxFusions" min="1" max="50" step="1"
              value="${Number(this.config.maxFusions) || 5}">
          </label>

          <label title="Depois de fundir, pede ao jogo para vestir a melhor peça de cada slot, pelo critério de potência. Quem decide se a peça nova é melhor é o servidor, não o launcher. Desligado, a peça forjada fica na bolsa e a rodada seguinte forjaria a mesma coisa de novo.">
            <input type="checkbox" id="forgeEquipBest" ${this.config.equipBest ? 'checked' : ''}>
            <span>Equipar o melhor</span>
          </label>
        </div>

        <label class="xp-keep"
          title="Ids de item que nunca são tocados, separados por vírgula. O cadeado do jogo já protege peça por peça; esta lista protege um tipo inteiro.">
          <span>Nunca desmontar nem fundir</span>
          <input type="text" id="forgeKeep" placeholder="ex: espada-lendaria, anel-monarca"
            value="${escape((this.config.keep || []).join(', '))}">
        </label>

        <p class="hint">${inputs
          ? `Cada fusão consome <b>${inputs}</b> peças do mesmo slot e da mesma raridade e devolve <b>1</b> da
             raridade acima. O nível que sai é o <b>menor</b> dos ${inputs} — por isso o launcher escolhe sempre
             as peças mais baixas que ainda melhoram o que está no corpo, e guarda as altas para a fusão
             seguinte. ${this.clashHtml()}`
          : 'As regras de fusão ainda não foram lidas.'}</p>`;
    },

    /** Um seletor de raridade na ordem do jogo. */
    raritySelect(id, escolhido, vazio) {
      const opcoes = this.rarities.map(r => `
        <option value="${escape(r.id)}" ${escolhido === r.id ? 'selected' : ''}>${escape(r.name)}</option>`).join('');
      return `
        <select id="${id}">
          <option value="" ${!escolhido ? 'selected' : ''}>— ${escape(vazio)} —</option>
          ${opcoes}
        </select>`;
    },

    rarityName(id) {
      const r = this.rarities.find(x => x.id === id);
      return r ? r.name : id;
    },

    rarityOrder(id) {
      const r = this.rarities.find(x => x.id === id);
      return r ? Number(r.order) : null;
    },

    /**
     * O aviso de que o teto de desmonte come o insumo de alguma fusão
     * planejada.
     *
     * É o único erro de configuração que sobrou, e o usuário pode cometê-lo sem
     * perceber: escolher "raro" como teto parece razoável até se lembrar de que
     * raro é exatamente o que vira épico. A tela avisa antes; quem recusa de
     * verdade é o domínio, com `dismantleClash`.
     */
    clashHtml() {
      const teto = this.rarityOrder(this.config.dismantleUpTo);
      if (teto === null) return '';

      // Qual raridade alguma conta usaria de insumo agora. Vem do resumo, e não
      // de uma suposição: sem conta conectada não há o que avisar.
      const insumos = new Set();
      for (const conta of this.accounts) {
        const est = conta.summary && conta.summary.estimate;
        if (est && est.best && est.best.inputRarity) insumos.add(est.best.inputRarity);
      }

      for (const id of insumos) {
        const ordem = this.rarityOrder(id);
        if (ordem !== null && teto >= ordem) {
          return `<b class="xp-peso-warn">O teto de desmonte alcança ${escape(this.rarityName(id))}, que é o
            que a fusão consome agora: nada seria forjado. Baixe o teto.</b>`;
        }
      }
      return '';
    },

    /**
     * Uma linha por conta, e abaixo dela a grade de onze slots.
     *
     * Conta desconectada continua na lista: é nela que o usuário quer conferir
     * se vai participar **antes** de ligar o monitor, porque o primeiro
     * `inventory_delta` depois do login já dispara uma rodada.
     */
    renderAccounts() {
      const host = document.getElementById('forgeAccounts');
      if (!host) return;

      if (!this.accounts.length) {
        host.innerHTML = '<p class="hint">Nenhuma conta configurada.</p>';
        return;
      }

      const fora = new Set((this.config.disabled || []).map(Number));

      host.innerHTML = this.accounts.map(conta => {
        const nome = conta.name || conta.username || `Conta ${conta.index + 1}`;
        const resumo = conta.summary || null;
        const est = resumo && resumo.estimate;

        return `
          <div class="xp-forge-acc">
            <div class="xp-forge-head">
              <label title="Desmarcar deixa esta conta de fora da auto-forja">
                <input type="checkbox" data-account="${conta.index}" ${fora.has(conta.index) ? '' : 'checked'}>
                <span class="xp-dot ${conta.connected ? 'is-on' : ''}"></span>
                <b>${escape(nome)}</b>
              </label>
              ${resumo ? `<span class="xp-at">nível ${escape(resumo.level || '—')}</span>` : ''}
              ${resumo ? `<span class="xp-at" title="Pó arcano: a moeda da fusão. Vem do desmonte.">pó ${num(resumo.dust)}</span>` : ''}
              ${conta.stats && conta.stats.lastError
            ? `<span class="xp-boss-fail" title="${escape(conta.stats.lastError)}">${escape(MOTIVOS[conta.stats.lastError] || conta.stats.lastError)}</span>`
            : ''}
            </div>
            ${this.slotsHtml(conta, resumo)}
            ${est ? this.estimateHtml(est) : ''}
          </div>`;
      }).join('');
    },

    /**
     * A grade de slots: o que cada um tem hoje e o que a forja faria nele.
     *
     * Três estados, e a diferença entre eles é a tela inteira:
     *
     *   verde   nada a fazer. Não há fusão que saia melhor do que o que está no
     *           corpo, e não há peça melhor parada na bolsa. A automação
     *           **para** aqui, em vez de continuar moendo.
     *   azul    a bolsa já tem peça melhor. Equipar é de graça e vem antes de
     *           forjar — gastar cinco peças para substituir algo que ia ser
     *           substituído sem custo seria desperdício puro.
     *   âmbar   há uma fusão que melhora, com os níveis que entram à vista.
     *
     * Os níveis de entrada aparecem porque o nível de saída é o **menor** deles.
     * Ver "55 55 55 55 52" ao lado de "→ 52" é a única forma de o usuário
     * perceber que uma peça atrasada está puxando a fusão para baixo e decidir
     * esperar por outra.
     */
    slotsHtml(conta, resumo) {
      if (!resumo) {
        const motivo = conta.connected
          ? 'inventário ainda não lido nesta conta'
          : 'conta sem monitor: ligue o monitor para ver os slots';
        return `<p class="hint">${escape(motivo)}</p>`;
      }

      const fora = new Set((this.config.slotsOff || []).map(Number));

      const celulas = (resumo.slots || []).map(s => {
        const atual = s.rarity
          ? `${escape(this.rarityName(s.rarity))} ${escape(s.level)}`
          : '—';

        let estado = 'is-ok';
        let acao = '<span class="xp-forge-slot-none">nada a fazer</span>';

        if (s.equipFirst && s.candidate) {
          estado = 'is-equip';
          acao = '<span class="xp-forge-slot-eq" title="A bolsa já tem uma peça mais forte para este slot: primeiro tenta equipar; a fusão fica como alternativa após atualizar o inventário.">já há melhor na bolsa</span>';
        } else if (s.candidate) {
          const c = s.candidate;
          estado = 'is-off';
          acao = `
            <span class="xp-forge-slot-next"
              title="Cinco peças ${escape(this.rarityName(c.inputRarity))} dos níveis ${escape((c.inputLevels || []).join(', '))} viram uma ${escape(this.rarityName(c.rarity))} de nível ${escape(c.level)} — o menor dos cinco.${c.assumed ? ' O catálogo não trouxe o multiplicador desta raridade: o ganho é presumido, e o jogo confirma na hora de equipar.' : ''}">
              → ${escape(this.rarityName(c.rarity))} ${escape(c.level)}${c.assumed ? ' <span class="xp-at">?</span>' : ''}
            </span>
            <span class="xp-forge-slot-in">${escape((c.inputLevels || []).join(' '))}</span>
            ${s.ready > 1
          ? `<span class="xp-at" title="Fusões prontas neste slot. A rodada faz quantas o pó e o teto por rodada permitirem.">${num(s.ready)} prontas</span>`
          : ''}
            ${c.waste ? `<span class="xp-peso-warn" title="Níveis jogados fora: tudo acima do menor insumo é arrastado para baixo na saída.">−${num(c.waste)} níveis</span>` : ''}
            <span class="xp-at">${num(c.dustCost)} pó</span>`;
        }

        const estoque = (s.stock || [])
          .map(e => `${escape(this.rarityName(e.rarity))} ×${e.count}`)
          .join(' · ');

        return `
          <div class="xp-forge-slot ${estado}"
            title="${escape(s.name)}${s.rarity ? ` · ${escape(this.rarityName(s.rarity))} nível ${escape(s.level)}` : ' · vazio'}${estoque ? ` · na bolsa: ${escape(estoque)}` : ''}">
            <span class="xp-forge-slot-name">${escape(s.name)}</span>
            <span class="xp-forge-slot-val">${atual}</span>
            <span class="xp-forge-slot-act">${acao}</span>
            <label title="Desmarcar tira este slot da auto-forja em todas as contas">
              <input type="checkbox" data-slot="${s.slot}" ${fora.has(Number(s.slot)) ? '' : 'checked'}>
            </label>
          </div>`;
      }).join('');

      return `<div class="xp-forge-grid">${celulas}</div>`;
    },

    /**
     * O que esta conta consegue fazer agora.
     *
     * Deixou de ser "quanto falta para o alvo" e passou a ser "qual é a próxima
     * fusão e se dá para pagá-la". A fusão é **uma por rodada**, a de maior
     * ganho, então projetar um total não diria nada útil: o inventário muda a
     * cada drop e a escolha é refeita.
     *
     * O ouro aparece em **kills**, que é como o jogo expressa o custo de fusão
     * (`fusion_gold_kills`). A conversão para ouro depende de coeficientes cuja
     * ordem não está documentada no protocolo, e um número convertido errado
     * seria pior que o número cru.
     */
    estimateHtml(est) {
      if (!est.ready) {
        return `<p class="hint">${escape(MOTIVOS[est.reason] || est.reason || '')}</p>`;
      }
      if (!est.best) {
        return `<p class="hint"><b>Nada a forjar.</b> Nenhuma fusão possível com o que está na bolsa sairia
          melhor do que o que já está equipado${est.junkPieces
          ? ` — mas ${num(est.junkPieces)} ${est.junkPieces === 1 ? 'peça será moída' : 'peças serão moídas'}
             para ~${num(est.dustFromJunk)} de pó`
          : ''}.</p>`;
      }

      const b = est.best;
      const faltaPo = Math.max(0, est.dustNeeded - est.dustHave);

      return `
        <div class="xp-forge-est">
          <span><b>${num(est.upgradable)}</b> de ${num(est.slots)} slots têm melhoria</span>
          <span title="Slots com uma peça melhor já disponível na bolsa. Equipar vem antes da fusão.">
            equipar: <b>${num(est.equipFirst)}</b>
          </span>
          <span title="Candidatos de fusão que continuam depois de excluir slots que têm peça melhor na bolsa.">
            fundíveis agora: <b>${num(est.forgeableNow)}</b>
          </span>
          <span title="Quantas fusões a rodada faria agora, e quantas o pó de hoje paga. O resto fica para a rodada seguinte.">
            lote: <b>${num(est.affordable)}</b> de ${num(est.possible)}
            ${est.affordable < est.possible
          ? `<span class="xp-at">o pó só paga ${num(est.affordable)}</span>`
          : ''}
          </span>
          <span title="O máximo de fusões encadeadas por rodada. Peças criadas no primeiro lote podem entrar no segundo.">
            encadeamento: <b>até 2 passes</b>
          </span>
          <span title="A fusão de maior ganho entre todos os slots, a primeira do lote. O nível de saída é o menor dos insumos.">
            a seguir: <b>${escape(b.name)}</b>
            ${escape(this.rarityName(b.rarity))} ${escape(b.level)}
            <span class="xp-at">de ${escape((b.inputLevels || []).join(', '))}
              ${escape(this.rarityName(b.inputRarity))}</span>
          </span>
          <span title="Pó arcano. O desmonte é a única fonte: moer comuns e incomuns é a primeira coisa de cada rodada.">
            pó ${num(est.dustHave)} / <b>${num(est.dustNeeded)}</b>
            ${faltaPo
          ? (est.dustFromJunk
            ? `<span class="xp-at">o lixo renderia ~${num(est.dustFromJunk)}</span>`
            : `<span class="xp-peso-warn">faltam ${num(faltaPo)} e não há lixo a moer</span>`)
          : ''}
          </span>
          ${b.goldKills
          ? `<span title="O jogo expressa o custo de ouro da fusão em kills; a conversão exata não está documentada, então o número vai como veio.">ouro ~${num(b.goldKills)} kills</span>`
          : ''}
        </div>`;
    },

    renderLog() {
      const host = document.getElementById('forgeLog');
      if (!host) return;
      if (!this.log.length) {
        host.innerHTML = `<p class="hint">Nada forjado ainda. O relatório sobrevive ao fechamento do launcher, e é
          o único lugar onde o histórico existe — o jogo não guarda registro de desmonte, e as peças não
          voltam.</p>`;
        return;
      }
      host.innerHTML = this.log.map(linha => this.lineHtml(linha)).join('');
    },

    /**
     * Uma linha do relatório.
     *
     * O que entrou e o que saiu vai à vista, não no `title`: sem o jogo guardar
     * registro de desmonte, "a conta 3 moeu 12 peças e fundiu um peitoral
     * lendário" é a única auditoria que existe, e esconder isso num tooltip
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

      if (!linha.ok) {
        const motivo = MOTIVOS[linha.reason] || linha.reason || 'falhou';
        return envelope('is-err', `
          <span class="xp-boss-fail" title="${escape(linha.reason || '')}">✖ nada feito</span>
          <span class="xp-at">${escape(motivo)}</span>`);
      }

      if (linha.action === 'fuse') {
        const antes = linha.before;
        return envelope('', `
          <span class="xp-boss-ok">✔ fundido</span>
          <b>${escape(linha.slotName || linha.slot || '')}</b>
          ${antes && antes.rarity
            ? `<span class="xp-at">${escape(this.rarityName(antes.rarity))} ${escape(antes.level)} →</span>`
            : ''}
          <span>${escape(this.rarityName(linha.rarity))} nível ${escape(linha.level)}</span>
          <span class="xp-at" title="Os níveis que entraram. O nível que saiu é o menor deles.">${num(linha.inputs)} × ${escape(this.rarityName(linha.inputRarity))}${(linha.inputLevels || []).length
            ? ` (${escape((linha.inputLevels || []).join(', '))})` : ''}</span>
          ${linha.waste ? `<span class="xp-peso-warn" title="Níveis arrastados para baixo pelo insumo mais fraco">−${num(linha.waste)} níveis</span>` : ''}
          <span class="xp-at">−${num(linha.dust)} pó</span>
          ${linha.wasEstimated ? '<span class="xp-at" title="O catálogo não trouxe o multiplicador da raridade: o ganho foi presumido pelo degrau, e o jogo confirmou ao equipar.">ganho presumido</span>' : ''}
          ${linha.slotSwap ? '<span class="xp-at" title="Saída em slot diferente do das peças: custou mais pó">troca de slot</span>' : ''}`);
      }

      if (linha.action === 'dismantle') {
        const dirigido = linha.kind === 'sacrifice';
        return envelope('', `
          <span class="xp-boss-ok">✔ desmontado</span>
          <b>${num(linha.pieces)} ${Number(linha.pieces) === 1 ? 'peça' : 'peças'}</b>
          ${dirigido
            ? '<span class="xp-at" title="Peças acima do lixo, moídas só para fechar o pó de uma fusão: nenhuma delas serviria de insumo, porque o nível era baixo demais.">para pagar a fusão</span>'
            : '<span class="xp-at">lixo</span>'}
          <span class="xp-at">+${num(linha.dust)} pó</span>
          ${linha.stones ? `<span class="xp-at">+${num(linha.stones)} pedras</span>` : ''}
          ${linha.gems ? `<span class="xp-at">${num(linha.gems)} gemas devolvidas</span>` : ''}`);
      }

      if (linha.action === 'equip') {
        return envelope('', `
          <span class="xp-boss-ok">✔ equipado</span>
          <b>${num(linha.changes)} ${Number(linha.changes) === 1 ? 'troca' : 'trocas'}</b>
          <span class="xp-at">${escape((linha.slots || []).join(', '))}</span>
          ${linha.delta ? `<span class="xp-at">+${num(linha.delta)} de poder</span>` : ''}`);
      }

      return envelope('', '<span class="xp-boss-ok">✔</span>');
    },

    // ------------------------------------------------------------- eventos

    wire() {
      // Delegado nos dois blocos: as duas áreas são redesenhadas a cada leitura
      // — e esta tela relê de quinze em quinze segundos — então um ouvinte por
      // campo morreria junto com ele.
      //
      // `change`, não `input`: salvar a cada tecla do nível mandaria o valor
      // intermediário de "6" no caminho para "60".
      const controls = document.getElementById('forgeControls');
      if (controls) controls.onchange = () => this.save();

      const accounts = document.getElementById('forgeAccounts');
      if (accounts) {
        accounts.onchange = e => {
          const d = e.target.dataset || {};
          if (d.account !== undefined || d.slot !== undefined) this.save();
        };
      }

      const run = document.getElementById('forgeRun');
      if (run) run.onclick = () => this.run();

      const refresh = document.getElementById('forgeRefresh');
      if (refresh) refresh.onclick = () => this.refresh();

      const clear = document.getElementById('forgeClear');
      if (clear) clear.onclick = () => this.clear();
    },

    /**
     * Lê a tela inteira numa ida só, como nas outras automações.
     *
     * As duas listas — contas de fora e slots de fora — são derivadas das
     * caixinhas **desmarcadas**, nunca uma lista de permissões: assim uma conta
     * nova participa por padrão, e um slot que o jogo acrescente entra na busca
     * em vez de ficar de fora em silêncio.
     */
    collect() {
      const valor = id => (document.getElementById(id) || {}).value;
      const marcado = id => !!(document.getElementById(id) || {}).checked;

      const disabled = [];
      for (const caixa of document.querySelectorAll('[data-account]')) {
        if (!caixa.checked) disabled.push(Number(caixa.dataset.account));
      }

      // A grade de slots é repetida por conta, e a escolha é global: as
      // caixinhas de todas as contas são o mesmo conjunto de slots, então basta
      // coletar as desmarcadas de qualquer uma — um `Set` resolve a repetição.
      const slotsOff = new Set();
      for (const caixa of document.querySelectorAll('[data-slot]')) {
        if (!caixa.checked) slotsOff.add(Number(caixa.dataset.slot));
      }

      return {
        enabled: marcado('forgeEnabled'),
        dismantleUpTo: valor('forgeDismantle') || '',
        maxDismantle: Number(valor('forgeMaxDismantle')) || 50,
        maxFusions: Number(valor('forgeMaxFusions')) || 5,
        equipBest: marcado('forgeEquipBest'),
        keep: String(valor('forgeKeep') || '').split(',').map(s => s.trim()).filter(Boolean),
        disabled,
        slotsOff: [...slotsOff]
      };
    },

    async save() {
      if (this.saving) return;
      this.saving = true;
      const res = await this.api.forgeSet(this.collect()).catch(e => ({ error: e.message }));
      this.saving = false;

      if (!res || res.error || !res.ok) {
        this.say('Falha ao salvar: ' + ((res && res.error) || 'desconhecida'), true);
        return;
      }

      this.apply(res);
      this.render();

      if (!this.config.enabled) {
        this.say('Salvo. A auto-forja está desligada: nenhuma peça é tocada.');
        return;
      }
      const fora = (this.config.disabled || []).length;
      this.say(`Salvo${fora ? `, ${fora} conta${fora === 1 ? '' : 's'} de fora` : ''}. Cada conta forja conforme
        o que ela própria tem — a primeira rodada sai no próximo drop, salvar não forja.`);
    },

    /**
     * "Forjar agora".
     *
     * Destrói peças de verdade, e é o único jeito de o usuário ver a automação
     * funcionar sem esperar a caçada. A grade e o custo já estão na tela acima
     * do botão, que é a conferência que esta tela existe para dar.
     */
    async run() {
      const botao = document.getElementById('forgeRun');
      if (botao) botao.disabled = true;
      this.say('Forjando…');

      const res = await this.api.forgeRun().catch(e => ({ error: e.message }));
      if (botao) botao.disabled = false;

      if (!res || res.error) {
        this.say('Falha ao forjar: ' + ((res && res.error) || 'desconhecida'), true);
        return;
      }
      this.apply(res);
      this.render();

      const faltando = this.accounts.filter(c =>
        c.summary && c.summary.estimate && c.summary.estimate.upgradable > 0).length;
      if (faltando) {
        // Não é erro: a fusão é uma por rodada, e a rodada seguinte continua de
        // onde esta parou.
        this.say(`Pronto. Ainda há ${faltando} ${faltando === 1 ? 'conta' : 'contas'} com slots a melhorar —
          uma fusão por rodada, a de maior ganho. A próxima sai no próximo drop.`);
        return;
      }
      this.say('Pronto. Nenhuma conta em monitor tem fusão que melhore o que já está equipado.');
    },

    /** Relê a bolsa de cada conta: lento de propósito, e por isso num botão. */
    async refresh() {
      const botao = document.getElementById('forgeRefresh');
      if (botao) botao.disabled = true;
      this.say('Lendo o inventário de cada conta…');
      await this.load(true);
      if (botao) botao.disabled = false;
      this.say('Inventário relido.');
    },

    async clear() {
      const res = await this.api.forgeLogClear().catch(e => ({ error: e.message }));
      if (!res || res.error) {
        this.say('Falha ao limpar: ' + ((res && res.error) || 'desconhecida'), true);
        return;
      }
      this.log = [];
      this.renderLog();
      this.say('Relatório limpo. As peças já desmontadas continuam destruídas.');
    },

    say(text, isError) {
      const bar = document.getElementById('forgeStatusBar');
      if (!bar) return;
      bar.textContent = text;
      bar.classList.toggle('is-error', !!isError);
    }
  };

  if (typeof window !== 'undefined') window.PioForge = PioForge;
  if (typeof module !== 'undefined' && module.exports) module.exports = PioForge;
})();

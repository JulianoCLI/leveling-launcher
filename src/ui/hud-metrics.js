/**
 * @file hud-metrics.js
 * Métricas do HUD declaradas por jogo.
 *
 * O HUD antigo tinha `Pokébolas` e `Shinies` escritos no HTML, o que só serve
 * para o PokeIdle. Aqui cada jogo declara quais números mostrar; o HUD apenas
 * renderiza a lista. Adicionar um jogo passa a ser escrever um adapter.
 *
 * Um adapter tem:
 *   - `id`: casa com `state.game` vindo do serviço headless;
 *   - `metrics`: até seis colunas, cada uma com `label` e `value(state)`;
 *   - `banner(state)`: linha de alerta opcional (morte, portal vermelho...).
 *
 * `value` devolve a string já formatada, ou `null` para esconder a coluna.
 *
 * Uma coluna pode declarar:
 *   - `group`: em qual bloco ela aparece (ver `GROUPS`);
 *   - `hint(state)`: segunda linha, pequena, abaixo do número — o contexto que
 *     transforma "1.073" em "1.073 · 4,3k/h";
 *   - `tone(state)`: `'good'`, `'warn'` ou `'bad'`, para o valor mudar de cor
 *     quando ele pede atenção.
 */

(() => {
  'use strict';

  const num = n => Math.round(+n || 0).toLocaleString('pt-BR');

  function compact(n) {
    n = +n || 0;
    const a = Math.abs(n), sg = n < 0 ? '-' : '';
    if (a >= 1e9) return sg + (a / 1e9).toFixed(a >= 1e10 ? 0 : 1).replace('.0', '') + 'bi';
    if (a >= 1e6) return sg + (a / 1e6).toFixed(a >= 1e7 ? 0 : 1).replace('.0', '') + 'M';
    if (a >= 1e3) return sg + (a / 1e3).toFixed(a >= 1e4 ? 0 : 1).replace('.0', '') + 'k';
    return num(a);
  }

  function duration(seconds) {
    seconds = Math.max(0, Math.floor(+seconds || 0));
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    return `${h}h ${String(m).padStart(2, '0')}m ${String(seconds % 60).padStart(2, '0')}s`;
  }

  /**
   * Prazo curto, para previsão. `duration` sempre escreve as três unidades, o
   * que num "faltam 2h" viraria `2h 00m 00s` e esconderia a informação no meio
   * de zeros. Aqui só aparece a unidade que importa na escala do número.
   */
  function eta(seconds) {
    seconds = Math.floor(+seconds || 0);
    if (!(seconds > 0)) return null;
    if (seconds >= 86400 * 2) return `~${Math.round(seconds / 86400)}d`;
    if (seconds >= 3600) {
      const h = Math.floor(seconds / 3600);
      const m = Math.round((seconds % 3600) / 60);
      return m ? `${h}h ${m}m` : `${h}h`;
    }
    if (seconds >= 60) return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`;
    return `${seconds}s`;
  }

  /** `red_portal_tier_3` → `Red Portal Tier 3`: ids do servidor não são rótulo. */
  function titleize(id) {
    return String(id || '')
      .replace(/[_-]+/g, ' ')
      .trim()
      .replace(/\b\p{Ll}/gu, c => c.toUpperCase());
  }

  /**
   * Horário de parede, `14:32:07`.
   *
   * Segundos incluídos de propósito: numa caçada boa cinco coisas caem dentro
   * do mesmo minuto, e `14:32` em cinco linhas seguidas perde a ordem que o
   * registro existe para mostrar.
   */
  function clock(ms) {
    const t = +ms || 0;
    if (!t) return '';
    const d = new Date(t);
    return [d.getHours(), d.getMinutes(), d.getSeconds()]
      .map(n => String(n).padStart(2, '0')).join(':');
  }

  /** `12.345` → `12,3k`, para caber numa linha de dica sem virar coluna. */
  function rate(n) {
    n = Math.round(+n || 0);
    if (!n) return null;
    return compact(n) + '/h';
  }

  /** PokeIdle: reproduz exatamente as quatro colunas que o HUD já mostrava. */
  const pokeidle = {
    id: 'pokeidle',
    metrics: [
      { key: 'time', label: 'Tempo de caça', value: s => duration((s.a || {}).seconds) },
      {
        key: 'balls',
        label: 'Pokébolas',
        value: s => {
          const infinite = !!(s.equippedBall && s.equippedBall.infinite) || (+s.balls >= 999999);
          return infinite ? '∞' : num(s.balls);
        }
      },
      { key: 'xph', label: 'EXP / hora', value: s => compact((s.a || {}).xph) },
      {
        key: 'shinies',
        label: 'Shinies',
        value: s => {
          const a = s.a || {};
          return num(a.shinyCap != null ? a.shinyCap : a.shinyFound);
        }
      }
    ],
    banner: () => null
  };

  /**
   * Os blocos do painel, em ordem de leitura.
   *
   * A grade antiga era uma fileira única de treze células iguais, e nela
   * "Ouro" tinha o mesmo peso visual que "Pontos de talento". Com quatro
   * painéis na tela isso não se lê de relance: tudo parece igualmente
   * importante, então nada se destaca.
   *
   * A ordem aqui é a das perguntas que o usuário faz, nessa sequência:
   * a caçada está rendendo? quanto juntei? falta alguma coisa? tem algo
   * pendente na conta?
   */
  const GROUPS = [
    { id: 'rendimento', title: 'Rendimento' },
    { id: 'carteira', title: 'Carteira' },
    { id: 'suprimentos', title: 'Suprimentos' },
    { id: 'conta', title: 'Conta' }
  ];

  /** Abaixo disto, repor vira assunto; o auto-refill usa limiares próprios. */
  const POCAO_BAIXA = 200;

  /**
   * Leveling Idle 2D: monitor somente leitura da caçada em andamento.
   * Nada aqui envia comando — a automação é do servidor.
   */
  const levelingIdle = {
    id: 'leveling-idle',
    groups: GROUPS,
    metrics: [
      {
        key: 'kills',
        group: 'rendimento',
        label: 'Abates',
        value: s => num((s.hunt || {}).kills),
        // O total sozinho não diz nada sem saber há quanto tempo. A taxa é o
        // número que compara um painel com o outro, e era o único dos três
        // ritmos medidos (`xph`, `goldph`, `killsph`) que não aparecia.
        hint: s => rate((s.a || {}).killsph)
      },
      {
        key: 'time',
        group: 'rendimento',
        label: 'Tempo de caça',
        value: s => duration((s.a || {}).seconds)
      },
      {
        key: 'xph',
        group: 'rendimento',
        label: 'EXP / hora',
        value: s => compact((s.a || {}).xph)
      },
      {
        key: 'levelEta',
        group: 'rendimento',
        label: 'Próximo nível',
        value: s => {
          const xpToNext = +s.xpToNext || 0;
          if (!xpToNext) return '—';
          const xph = +(s.a || {}).xph || 0;
          // Sem taxa medida ainda, o que dá para dizer é o quanto falta de XP.
          if (!xph) return `${compact(xpToNext)} xp`;
          return eta((xpToNext / xph) * 3600) || 'agora';
        },
        hint: s => {
          const xpToNext = +s.xpToNext || 0;
          const xph = +(s.a || {}).xph || 0;
          // Com prazo na linha de cima, a dica mostra o xp cru; sem prazo o
          // valor já é o xp cru e repeti-lo não acrescenta nada.
          return xpToNext && xph ? `${compact(xpToNext)} xp` : null;
        }
      },
      {
        key: 'gold',
        group: 'carteira',
        label: 'Ouro',
        value: s => compact(s.gold),
        hint: s => rate((s.a || {}).goldph)
      },
      { key: 'diamonds', group: 'carteira', label: 'Diamantes', value: s => compact(s.diamonds) },
      {
        key: 'huntGold',
        group: 'carteira',
        label: 'Ouro na caçada',
        value: s => {
          const hunt = s.hunt || {};
          if (!hunt.gold) return null;
          return compact(hunt.gold);
        },
        // O gasto da caçada existe no estado desde sempre e nunca apareceu.
        // Sem ele, "ganhei 2M" esconde que 1,8M voltaram para a loja.
        hint: s => {
          const gasto = +(s.hunt || {}).goldSpent || 0;
          return gasto ? `−${compact(gasto)} gasto` : null;
        }
      },
      {
        key: 'bag',
        group: 'suprimentos',
        label: 'Mochila',
        value: s => {
          const inv = s.inventory || {};
          if (!inv.capacity) return null;
          return `${num(inv.usedSlots)} / ${num(inv.capacity)}`;
        },
        hint: s => {
          const inv = s.inventory || {};
          if (!inv.capacity) return null;
          return `${Math.round((inv.usedSlots / inv.capacity) * 100)}% cheia`;
        },
        // Bolsa cheia para a caçada: o drop é perdido e o auto-anunciar trava.
        // É o aviso mais barato do painel e não existia.
        tone: s => {
          const inv = s.inventory || {};
          if (!inv.capacity) return '';
          const pct = inv.usedSlots / inv.capacity;
          if (pct >= 0.95) return 'bad';
          if (pct >= 0.8) return 'warn';
          return '';
        }
      },
      {
        key: 'potions',
        group: 'suprimentos',
        label: 'Poções HP · MP',
        value: s => {
          const p = s.potions || {};
          if (p.hp == null && p.mana == null) return null;
          return `${compact(p.hp)} · ${compact(p.mana)}`;
        },
        tone: s => {
          const p = s.potions || {};
          if (p.hp == null && p.mana == null) return '';
          return Math.min(+p.hp || 0, +p.mana || 0) < POCAO_BAIXA ? 'warn' : '';
        }
      },
      {
        key: 'revives',
        group: 'suprimentos',
        label: 'Reviver',
        value: s => {
          const p = s.potions || {};
          return p.revives ? num(p.revives) : null;
        }
      },
      {
        key: 'statPoints',
        group: 'conta',
        label: 'Pontos de status',
        value: s => num((s.points || {}).stat),
        // Ponto parado é poder que a conta já ganhou e não está usando.
        tone: s => ((s.points || {}).stat > 0 ? 'warn' : '')
      },
      {
        key: 'talentPoints',
        group: 'conta',
        label: 'Pontos de talento',
        value: s => num((s.points || {}).talent),
        hint: s => {
          const pt = s.points || {};
          // Sombra e ambição são árvores separadas: somar esconderia onde gastar.
          const extra = [];
          if (pt.shadowTalent) extra.push(`${num(pt.shadowTalent)} sombra`);
          if (pt.ambitionTalent) extra.push(`${num(pt.ambitionTalent)} ambição`);
          return extra.length ? extra.join(' · ') : null;
        },
        tone: s => ((s.points || {}).talent > 0 ? 'warn' : '')
      },
      {
        key: 'party',
        group: 'conta',
        label: 'Grupo',
        value: s => {
          const party = s.party || {};
          if (!party.id) return 'Sozinho';
          const total = (party.members || []).length;
          return party.maxMembers ? `${num(total)} / ${num(party.maxMembers)}` : num(total);
        }
      }
    ],

    /**
     * Onde a conta está. Era uma linha de rodapé em cinza-claro, do mesmo
     * tamanho de uma mensagem de erro, e é a primeira coisa que se quer saber
     * ao olhar quatro painéis — por isso virou um bloco próprio no topo.
     */
    location: state => {
      const hunt = state.hunt || {};
      const scene = state.scene || {};
      const map = hunt.gateId ? titleize(hunt.gateId) : (scene.id ? titleize(scene.id) : null);
      if (!map) return null;

      const partes = [];
      if (hunt.tierMin) partes.push(`Tier ${num(hunt.tierMin)}`);
      if (hunt.difficulty) partes.push(titleize(hunt.difficulty));
      if (scene.channel) partes.push(`Canal ${num(scene.channel)}`);

      // `city`/`town` dizem que não há caçada: o rótulo não pode sugerir que há.
      const emCaca = !!hunt.gateId && scene.kind !== 'city' && scene.kind !== 'town';
      return {
        label: emCaca ? 'Caçando em' : 'Local',
        map,
        detail: partes.join(' · '),
        hunting: emCaca
      };
    },

    /** Membros do grupo: lista, não coluna — cada um tem nome, nível e HP. */
    roster: state => {
      const party = state.party || {};
      if (!party.id) return null;
      const members = party.members || [];
      if (!members.length) return null;
      return {
        title: 'Membros do grupo',
        rows: members.map(m => ({
          name: m.name || '—',
          self: !!m.self,
          leader: !!m.leader,
          detail: `Nv ${num(m.level)}`,
          hp: m.maxHp ? `${compact(m.hp)} / ${compact(m.maxHp)}` : '',
          state: m.dead ? 'dead' : (m.online ? 'online' : 'offline')
        }))
      };
    },

    /**
     * O que caiu. Duas leituras do mesmo dado, porque são duas perguntas.
     *
     * `items` responde "o que esta caçada rendeu": acumulado por item, com o
     * saldo em bolsa ao lado — é o número que decide se já dá para abrir as
     * entradas ou se falta chave.
     *
     * `log` responde "o que caiu agora": os últimos ganhos em ordem, com
     * horário. Um sem o outro não serve — o acumulado não diz se a caçada
     * ainda está derrubando chave, e o registro não diz quantas há no total.
     *
     * Chaves e bilhetes vêm primeiro, depois por raridade, depois pelo que
     * caiu mais recentemente. Ordenar por quantidade poria mil essências na
     * frente da chave que caiu uma vez, que é o contrário da leitura.
     */
    loot: state => {
      const data = state.loot || {};
      const itens = Object.values(data.session || {});
      const registro = data.log || [];
      if (!itens.length && !registro.length) return null;

      itens.sort((a, b) => (
        (b.key ? 1 : 0) - (a.key ? 1 : 0)
        || (b.order || 0) - (a.order || 0)
        || (b.lastAtMs || 0) - (a.lastAtMs || 0)
      ));

      return {
        title: 'Drops da caçada',
        items: itens.slice(0, 12).map(it => ({
          defId: it.defId,
          name: it.name,
          color: it.color || '',
          key: !!it.key,
          qty: num(it.qty),
          // O saldo é o que o usuário realmente quer saber antes de agir, e
          // só aparece quando difere do que caiu: repetir "3 · 3 na bolsa"
          // gasta a linha para não dizer nada.
          bag: it.bag && it.bag !== it.qty ? `${num(it.bag)} na bolsa` : ''
        })),
        log: registro.slice(0, 8).map(ev => ({
          name: ev.name,
          color: ev.color || '',
          key: !!ev.key,
          qty: num(ev.qty),
          bag: ev.bag ? num(ev.bag) : '',
          reason: ev.reason === 'drop' ? '' : ev.reason,
          time: clock(ev.atMs)
        }))
      };
    },

    /** Alertas que o usuário precisa ver sem abrir a WebView. */
    banner: state => {
      const death = state.death;
      if (death && death.dead) {
        const perda = death.xpLost ? ` · −${compact(death.xpLost)} xp` : '';
        // O `auto_revive` do servidor resolve; aqui é só aviso.
        return { kind: 'danger', text: `Morto — aguardando reviver automático${perda}` };
      }

      const until = ((state.hunt || {}).redPortalUntilMs) || 0;
      if (until > Date.now()) {
        const left = Math.ceil((until - Date.now()) / 1000);
        return { kind: 'warn', text: `Portal vermelho ativo · ${left}s` };
      }

      const hp = +state.hp || 0;
      const maxHp = +state.maxHp || 0;
      if (maxHp && hp / maxHp < 0.25) {
        return { kind: 'warn', text: `HP baixo · ${num(hp)} / ${num(maxHp)}` };
      }

      return null;
    }
  };

  const adapters = new Map([
    [pokeidle.id, pokeidle],
    [levelingIdle.id, levelingIdle]
  ]);

  const PioHudMetrics = {
    /** Adapter do estado; cai no PokeIdle quando o jogo não se identifica. */
    forState(state) {
      const id = state && state.game;
      return adapters.get(id) || pokeidle;
    },

    get(id) {
      return adapters.get(id) || null;
    },

    register(adapter) {
      if (!adapter || !adapter.id) throw new Error('adapter precisa de id');
      adapters.set(adapter.id, adapter);
    },

    /** Colunas já resolvidas em texto, prontas para o HUD pintar. */
    resolve(state) {
      const adapter = this.forState(state);
      const safe = state || {};
      // `hint` e `tone` são enfeite: um adapter que quebra neles não pode
      // levar junto o número, que é a razão da coluna existir.
      const opcional = (fn, fallback) => {
        if (typeof fn !== 'function') return fallback;
        try {
          const out = fn(safe);
          return out === null || out === undefined ? fallback : String(out);
        } catch {
          return fallback;
        }
      };

      const columns = [];
      for (const metric of adapter.metrics) {
        let value;
        try {
          value = metric.value(safe);
        } catch {
          value = null;
        }
        if (value === null || value === undefined) continue;
        columns.push({
          key: metric.key,
          label: metric.label,
          value: String(value),
          group: metric.group || '',
          hint: opcional(metric.hint, ''),
          tone: opcional(metric.tone, '')
        });
      }

      /*
       * Os blocos, já com as colunas dentro e sem os que ficaram vazios: uma
       * coluna pode sumir (a mochila some sem capacidade conhecida) e um
       * título sozinho sobre espaço em branco parece painel quebrado.
       *
       * Sem `groups` declarados, tudo vira um bloco só sem título — que é
       * exatamente o HUD antigo, e é o que o PokeIdle continua sendo.
       */
      const declarados = Array.isArray(adapter.groups) ? adapter.groups : [];
      const groups = [];
      if (declarados.length) {
        for (const g of declarados) {
          const dentro = columns.filter(c => c.group === g.id);
          if (dentro.length) groups.push({ id: g.id, title: g.title, columns: dentro });
        }
        const soltas = columns.filter(c => !declarados.some(g => g.id === c.group));
        if (soltas.length) groups.push({ id: '', title: '', columns: soltas });
      } else if (columns.length) {
        groups.push({ id: '', title: '', columns });
      }

      let banner = null;
      try {
        banner = adapter.banner ? adapter.banner(safe) : null;
      } catch {
        banner = null;
      }
      let roster = null;
      try {
        roster = adapter.roster ? adapter.roster(safe) : null;
      } catch {
        roster = null;
      }
      let location = null;
      try {
        location = adapter.location ? adapter.location(safe) : null;
      } catch {
        location = null;
      }
      let loot = null;
      try {
        loot = adapter.loot ? adapter.loot(safe) : null;
      } catch {
        loot = null;
      }
      // `columns` continua na resposta junto com `groups`: é a lista achatada,
      // e os testes e qualquer leitor que só queira os números dependem dela.
      return { game: adapter.id, columns, groups, banner, roster, location, loot };
    },

    format: { num, compact, duration, eta, titleize, rate, clock }
  };

  if (typeof window !== 'undefined') window.PioHudMetrics = PioHudMetrics;
  if (typeof module !== 'undefined' && module.exports) module.exports = PioHudMetrics;
})();

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
   * Leveling Idle 2D: monitor somente leitura da caçada em andamento.
   * Nada aqui envia comando — a automação é do servidor.
   */
  const levelingIdle = {
    id: 'leveling-idle',
    /*
     * Ordem é leitura: primeiro o que o usuário checa de relance (carteira e
     * quanto falta para subir), depois o rendimento da caçada, depois o que
     * pede ação dele (mochila, poções, pontos) e por fim o grupo.
     */
    metrics: [
      { key: 'gold', label: 'Ouro', value: s => compact(s.gold) },
      { key: 'diamonds', label: 'Diamantes', value: s => compact(s.diamonds) },
      {
        key: 'levelEta',
        label: 'Próximo nível',
        value: s => {
          const xpToNext = +s.xpToNext || 0;
          if (!xpToNext) return '—';
          const xph = +(s.a || {}).xph || 0;
          // Sem taxa medida ainda, o que dá para dizer é o quanto falta de XP.
          if (!xph) return `${compact(xpToNext)} xp`;
          return eta((xpToNext / xph) * 3600) || 'agora';
        }
      },
      { key: 'time', label: 'Tempo de caça', value: s => duration((s.a || {}).seconds) },
      { key: 'kills', label: 'Abates', value: s => num((s.hunt || {}).kills) },
      { key: 'xph', label: 'EXP / hora', value: s => compact((s.a || {}).xph) },
      { key: 'goldph', label: 'Ouro / hora', value: s => compact((s.a || {}).goldph) },
      {
        key: 'bag',
        label: 'Mochila',
        value: s => {
          const inv = s.inventory || {};
          if (!inv.capacity) return null;
          return `${num(inv.usedSlots)} / ${num(inv.capacity)}`;
        }
      },
      {
        key: 'potions',
        label: 'Poções HP · MP',
        value: s => {
          const p = s.potions || {};
          if (p.hp == null && p.mana == null) return null;
          return `${compact(p.hp)} · ${compact(p.mana)}`;
        }
      },
      {
        key: 'revives',
        label: 'Reviver',
        value: s => {
          const p = s.potions || {};
          return p.revives ? num(p.revives) : null;
        }
      },
      {
        key: 'statPoints',
        label: 'Pontos de status',
        value: s => num((s.points || {}).stat)
      },
      {
        key: 'talentPoints',
        label: 'Pontos de talento',
        value: s => {
          const pt = s.points || {};
          // Sombra e ambição são árvores separadas: somar esconderia onde gastar.
          const extra = [];
          if (pt.shadowTalent) extra.push(`${num(pt.shadowTalent)} sombra`);
          if (pt.ambitionTalent) extra.push(`${num(pt.ambitionTalent)} ambição`);
          return num(pt.talent) + (extra.length ? ` (+${extra.join(', ')})` : '');
        }
      },
      {
        key: 'party',
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
      const columns = [];
      for (const metric of adapter.metrics) {
        let value;
        try {
          value = metric.value(safe);
        } catch {
          value = null;
        }
        if (value === null || value === undefined) continue;
        columns.push({ key: metric.key, label: metric.label, value: String(value) });
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
      return { game: adapter.id, columns, banner, roster, location };
    },

    format: { num, compact, duration, eta, titleize }
  };

  if (typeof window !== 'undefined') window.PioHudMetrics = PioHudMetrics;
  if (typeof module !== 'undefined' && module.exports) module.exports = PioHudMetrics;
})();

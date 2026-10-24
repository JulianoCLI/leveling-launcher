/**
 * @file leveling-hunts.js
 * Catálogo de caçadas reduzido ao que a troca de hunt precisa, e os requisitos
 * de nível de cada combinação.
 *
 * O `content_catalog` passa de 1 MB por login e o monitor não pode guardá-lo:
 * aqui ele é lido uma vez e sobram alguns kilobytes — portais, dificuldades e
 * as faixas de tier de cada portal. Mesmo motivo de `leveling-refill.readCatalog`,
 * que extrai os preços da mesma mensagem.
 *
 * O nível exigido não está num campo só. Medido no schema, três coisas barram
 * uma caçada ao mesmo tempo:
 *
 *   `GateDef.min_level`          nível para o portal existir;
 *   `DifficultyDef.req_level`    nível para aquela dificuldade;
 *   `TierDef.Area.required_level` nível para a faixa naquela dificuldade.
 *
 * O exigido é o **maior** dos três; o recomendado é o nível dos monstros da
 * área (`TierDef.Area.level`), que é o número que diz se a conta vai morrer lá
 * mesmo tendo permissão para entrar.
 */

'use strict';

const arr = v => (Array.isArray(v) ? v : []);
const int = (v, fallback = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
};
const num = (v, fallback = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

/**
 * Extrai o catálogo de caçadas do `content_catalog`. O objeto grande sai de
 * escopo aqui: o cliente guarda só o que esta função devolve.
 *
 * @param {object} value `ContentCatalog` desserializado.
 * @returns {{gates:object[], difficulties:object[], tiers:object}}
 *   `tiers` é indexado por `gate_id`, em ordem crescente de faixa.
 */
function readHuntCatalog(value) {
  const safe = value || {};

  const gates = [];
  for (const def of arr(safe.gates)) {
    if (!def || !def.id) continue;
    gates.push({
      id: def.id,
      sceneId: def.scene_id || '',
      name: def.name || def.id,
      icon: def.icon || '',
      minLevel: int(def.min_level)
    });
  }
  // Ordem de progressão, que é como o jogo as apresenta: o portal de nível 1
  // primeiro. Sem isto a lista sai na ordem interna do catálogo.
  gates.sort((a, b) => a.minLevel - b.minLevel || a.name.localeCompare(b.name));

  const difficulties = [];
  for (const def of arr(safe.difficulties)) {
    if (!def || !def.id) continue;
    difficulties.push({
      id: def.id,
      name: def.name || def.id,
      reqLevel: int(def.req_level),
      levelOffset: int(def.level_offset),
      rewardMult: num(def.reward_mult, 1),
      dropMult: num(def.drop_mult, 1),
      statusMult: num(def.status_mult, 1)
    });
  }
  difficulties.sort((a, b) => a.reqLevel - b.reqLevel || a.statusMult - b.statusMult);

  const tiers = {};
  for (const def of arr(safe.tiers)) {
    if (!def || !def.gate_id) continue;
    // As áreas são por dificuldade: é delas que sai o nível exigido e o nível
    // dos monstros daquela faixa. Guardadas por id de dificuldade para a tela
    // não precisar varrer a lista a cada troca de combo.
    const areas = {};
    for (const area of arr(def.areas)) {
      if (!area || !area.difficulty) continue;
      areas[area.difficulty] = {
        level: int(area.level),
        requiredLevel: int(area.required_level)
      };
    }
    const list = tiers[def.gate_id] || (tiers[def.gate_id] = []);
    list.push({
      min: int(def.min),
      max: int(def.max),
      bossId: def.boss_id || '',
      // O servidor recusa `start_hunt` nestas; a tela as mostra desabilitadas
      // em vez de esconder, para o usuário saber que existem.
      comingSoon: !!def.coming_soon,
      areas
    });
  }
  for (const list of Object.values(tiers)) list.sort((a, b) => a.min - b.min);

  return { gates, difficulties, tiers };
}

/** O catálogo tem o mínimo para montar uma troca de caçada? */
function hasHunts(catalog) {
  return !!catalog && arr(catalog.gates).length > 0;
}

const gateOf = (catalog, gateId) =>
  arr(catalog && catalog.gates).find(g => g.id === gateId) || null;

const tiersOf = (catalog, gateId) =>
  arr(catalog && catalog.tiers && catalog.tiers[gateId]);

const tierOf = (catalog, gateId, tierMin) =>
  tiersOf(catalog, gateId).find(t => t.min === int(tierMin)) || null;

/**
 * Dificuldades que de fato existem na faixa escolhida. Uma faixa sem área
 * declarada aceita a lista toda — é o que o catálogo significa quando omite
 * `areas` — e nesse caso filtrar deixaria a tela sem nenhuma opção.
 */
function difficultiesFor(catalog, gateId, tierMin) {
  const todas = arr(catalog && catalog.difficulties);
  const tier = tierOf(catalog, gateId, tierMin);
  if (!tier) return todas;
  const ids = Object.keys(tier.areas || {});
  if (!ids.length) return todas;
  return todas.filter(d => ids.includes(d.id));
}

/**
 * Requisitos de uma combinação portal/faixa/dificuldade.
 *
 * @returns {{minLevel:number, recommended:number, tierRange:number[],
 *            comingSoon:boolean, known:boolean}}
 *   `known` é falso quando o catálogo não descreve a combinação: nesse caso
 *   nada é afirmado sobre o nível, em vez de afirmar zero.
 */
function requirementFor(catalog, gateId, tierMin, difficultyId) {
  const gate = gateOf(catalog, gateId);
  const tier = tierOf(catalog, gateId, tierMin);
  const difficulty = arr(catalog && catalog.difficulties).find(d => d.id === difficultyId) || null;
  const area = tier && difficulty ? (tier.areas || {})[difficulty.id] : null;

  const minLevel = Math.max(
    gate ? gate.minLevel : 0,
    difficulty ? difficulty.reqLevel : 0,
    area ? area.requiredLevel : 0
  );

  // Nível dos monstros: a área é a fonte exata; sem ela, o topo da faixa é a
  // melhor aproximação, porque é onde os monstros da faixa chegam.
  const recommended = area && area.level ? area.level : (tier ? tier.max : 0);

  return {
    minLevel,
    recommended,
    tierRange: tier ? [tier.min, tier.max] : [],
    comingSoon: !!(tier && tier.comingSoon),
    known: !!(gate && tier)
  };
}

/**
 * A conta pode entrar? Devolve o motivo em código, para a interface traduzir.
 * Não é a palavra final — quem decide é o servidor — mas evita mandar uma
 * troca que já se sabe recusada.
 */
function blockReason(requirement, level) {
  if (!requirement) return '';
  if (requirement.comingSoon) return 'hunt.comingSoon';
  if (requirement.known && int(level) > 0 && int(level) < requirement.minLevel) return 'hunt.level';
  return '';
}

/** Normaliza o bilhete que vai no `start_hunt`. Sem portal não há caçada. */
function normalizeTicket(ticket) {
  const safe = ticket || {};
  const gate_id = String(safe.gate_id || safe.gateId || '').trim();
  if (!gate_id) return null;
  return {
    gate_id,
    tier_min: int(safe.tier_min != null ? safe.tier_min : safe.tierMin),
    difficulty: String(safe.difficulty || '').trim()
  };
}

module.exports = {
  readHuntCatalog,
  hasHunts,
  gateOf,
  tiersOf,
  tierOf,
  difficultiesFor,
  requirementFor,
  blockReason,
  normalizeTicket
};

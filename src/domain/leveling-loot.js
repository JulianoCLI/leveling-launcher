/**
 * @file leveling-loot.js
 * O que caiu: lê `inventory_delta` como registro de drops.
 *
 * O serviço já recebia este pacote e guardava só `used_slots`/`capacity` — o
 * resto ia para o lixo com o comentário de que "os itens ficam na WebView".
 * Isso vale para equipamento, que é uma lista longa e sem leitura rápida, mas
 * não vale para chave, baú e material: são poucos, são os que o usuário espera
 * e são exatamente o que ele abre a WebView para conferir.
 *
 * Este módulo é puro: recebe o pacote, o catálogo e o mapa de pilhas, devolve
 * o acumulado. Quem guarda estado é o serviço.
 *
 * Duas leituras diferentes saem daqui:
 *
 *   `session`  quanto de cada item caiu nesta caçada, com o saldo em bolsa;
 *   `log`      os últimos eventos em ordem, com horário — "o que caiu agora".
 *
 * Equipamento não entra em nenhuma das duas. Não é censura: uma caçada derruba
 * dezenas de peças por minuto e elas afogariam a chave que caiu uma vez na
 * hora, que é a informação pela qual o painel existe.
 */

'use strict';

/** Eventos do log guardados. Além disso é rolagem que ninguém lê. */
const LOG_MAX = 30;

/** Itens distintos acumulados por caçada. */
const SESSION_MAX = 40;

/**
 * Motivos de delta que são ganho de caçada.
 *
 * Lista fechada de propósito: `DELTA_REASON` tem trinta valores e a maioria é
 * movimentação (depósito, equipar, destrancar) ou gasto (loja, fusão, venda).
 * Contá-los como drop faria "+1 poção" aparecer toda vez que o auto-refill
 * comprasse, e o painel diria que a caçada rende poção.
 */
const LOOT_REASONS = new Map([
  ['DROP', 'drop'],
  ['CHEST', 'baú'],
  ['BOSS_KEY', 'boss'],
  ['SHADOW', 'sombra'],
  ['MAIL', 'correio'],
  ['MISSION_REWARD', 'missão'],
  ['OFFLINE_REWARD', 'offline'],
  ['EXPEDITION', 'expedição'],
  ['COLLECTION', 'coleção'],
  ['INSIGNIA_EXCHANGE', 'troca']
]);

/** Categorias que são equipamento, e por isso ficam de fora. */
const GEAR_CATEGORIES = new Set(['weapons', 'armor', 'accessories']);

/**
 * O que sobe para o topo da lista.
 *
 * Chave de portal e bilhete de boss são consumo com dono: cada um abre uma
 * entrada que não volta, e o usuário conta quantos tem antes de decidir o
 * próximo passo. Um material qualquer não tem essa urgência, mesmo caindo mil
 * vezes mais. O casamento é por id **e** por nome porque o catálogo nem sempre
 * traduz: `chave-portal-vermelho` e `Chave do Portal` são o mesmo item.
 */
const KEY_PATTERN = /(^|[^a-z])(chave|chaves|key|keys|bilhete|ticket|passe|convite|insignia|ins[ií]gnia)([^a-z]|$)/i;

const str = v => (typeof v === 'string' ? v : '');
const int = v => Math.max(0, Math.round(Number(v) || 0));

/** `red_portal_tier_3` → `Red Portal Tier 3`: id de servidor não é rótulo. */
function titleize(id) {
  return str(id)
    .replace(/[_-]+/g, ' ')
    .trim()
    .replace(/\b\p{Ll}/gu, c => c.toUpperCase());
}

/** Estado inicial, no formato que o painel consome. */
function initialLoot() {
  return { session: {}, log: [], events: 0, startedAtMs: 0 };
}

/**
 * `DELTA_REASON_DROP` → `DROP`.
 *
 * O codec desserializa enums como string (`enums: String`), mas o servidor
 * pode omitir o campo quando ele é zero — proto3 não escreve o default. Sem
 * motivo declarado o pacote é tratado como drop: é o motivo de longe mais
 * comum e o único que chega sem o launcher ter pedido nada.
 */
function reasonKey(value) {
  const v = value && value.reason;
  if (v == null || v === '') return 'DROP';
  const s = str(v);
  if (!s) return '';
  if (s.endsWith('_UNSPECIFIED')) return 'DROP';
  return s.startsWith('DELTA_REASON_') ? s.slice('DELTA_REASON_'.length) : s;
}

/**
 * O delta é da bolsa?
 *
 * Depósito e forja também emitem `inventory_delta`, e um item movido para o
 * depósito chegaria aqui como se tivesse acabado de cair. Ausente é bolsa: é
 * o escopo 1 e proto3 omite... não, o escopo 1 é escrito. Mas o servidor já
 * mandou o pacote sem escopo em delta de drop puro, e recusá-lo perderia o
 * caso principal.
 */
function scopeIsBag(value) {
  const v = value && value.scope;
  if (v == null || v === '') return true;
  const s = str(v);
  if (!s) return Number(v) === 1;
  return s === 'INVENTORY_SCOPE_BAG' || s === 'INVENTORY_SCOPE_UNSPECIFIED';
}

/**
 * Aparência e classificação de um item, do catálogo quando ele conhece.
 *
 * Sem catálogo ainda assim devolve linha: o id vira nome legível e o item
 * aparece sem cor. O contrário — esperar o catálogo — deixaria o painel vazio
 * no primeiro minuto de cada login, que é quando o usuário está olhando.
 */
function describe(defId, item, catalog) {
  const id = str(defId);
  const def = (catalog && catalog.items && catalog.items[id]) || {};
  const rarityId = str(item && item.rarity) || str(def.rarity);
  const rarity = (catalog && catalog.rarities && catalog.rarities[rarityId]) || null;
  const name = str(def.name) || titleize(id);
  const category = str(def.category);
  return {
    defId: id,
    name,
    category,
    icon: str(def.icon),
    rarity: rarityId,
    rarityName: rarity ? rarity.name : '',
    color: rarity ? str(rarity.color) : '',
    order: rarity ? Number(rarity.order) || 0 : 0,
    key: KEY_PATTERN.test(id) || KEY_PATTERN.test(name),
    gearish: looksLikeGear(item)
  };
}

/**
 * A peça parece equipamento pelo que ela própria carrega?
 *
 * O catálogo é a resposta certa, mas ele chega uma vez por login e os drops
 * começam antes dele. Sem uma segunda opinião, o primeiro minuto de cada
 * sessão — que é quando o usuário está olhando — despeja dezenas de armaduras
 * no painel e empurra para fora a chave, que é o motivo de o painel existir.
 *
 * Os campos usados só existem em equipamento: `ItemInstance.stats`, `power`,
 * `enchant`, `sockets`, `durability` e `equipped_slot`. Material empilhável
 * não traz nenhum deles. O custo de errar é assimétrico e aponta para cá: uma
 * armadura escondida não faz falta, uma chave afogada faz.
 */
function looksLikeGear(item) {
  if (!item || typeof item !== 'object') return false;

  if (Number(item.power) > 0) return true;
  if (Number(item.enchant) > 0) return true;
  if (Number(item.durability) > 0) return true;

  const slot = item.equipped_slot != null ? item.equipped_slot : item.equippedSlot;
  // Zero e `_UNSPECIFIED` são "não equipado", que é o normal de uma peça que
  // acabou de cair — só um valor real conta.
  if (slot != null && slot !== 0 && slot !== '' && !String(slot).endsWith('_UNSPECIFIED')) return true;

  if (Array.isArray(item.sockets) && item.sockets.length) return true;
  if (Array.isArray(item.affixes) && item.affixes.length) return true;

  const stats = item.stats && typeof item.stats === 'object' ? item.stats : null;
  if (stats && Object.values(stats).some(v => Number(v) > 0)) return true;

  return false;
}

/** Equipamento fica de fora, pelo catálogo ou pela cara da peça. */
function isGear(info) {
  if (GEAR_CATEGORIES.has(info.category)) return true;
  // Categoria conhecida e não é equipamento: o catálogo decidiu, e ele vence
  // a heurística — um material com `power` não deixa de ser material.
  if (info.category) return false;
  return info.gearish;
}

/**
 * Os ganhos de um `inventory_delta`, item a item.
 *
 * `added` é direto: a pilha é nova e a quantidade inteira caiu agora.
 * `updated` não é — o pacote traz a pilha **depois** do ganho, sem dizer de
 * quanto ela veio. Daí o mapa `stacks`: ele guarda o tamanho visto por último
 * de cada `uid`, e a diferença é o que caiu.
 *
 * Pilha nunca vista antes não gera linha. É o caso do primeiro delta depois do
 * login, em que `stacks` está vazio: contar a pilha inteira diria que 4.000
 * essências caíram de uma vez porque o usuário já as tinha. A pilha é apenas
 * registrada, e o próximo ganho dela já é medido certo.
 *
 * @param {object} value pacote `inventory_delta` desserializado
 * @param {Map<string,number>} stacks `uid` → tamanho da pilha (mutado aqui)
 * @param {object|null} catalog recorte de `leveling-market-catalog`
 */
function readDelta(value, stacks, catalog) {
  const out = [];
  if (!value || !scopeIsBag(value)) return out;

  // A contabilidade de pilhas vem antes do filtro de motivo, e não depois.
  //
  // Era o contrário, e uma venda saía por cima: o `uid` vendido ficava no mapa
  // para sempre, e o servidor reaproveita `uid`. A pilha seguinte com aquele
  // número seria medida contra o tamanho da que já não existe — um drop
  // inventado, ou um drop real engolido. O que `removed` diz é verdade sobre a
  // bolsa independentemente do que causou a mudança.
  for (const uid of Array.isArray(value.removed) ? value.removed : []) {
    stacks.delete(str(uid));
  }

  const motivo = LOOT_REASONS.get(reasonKey(value));
  if (!motivo) {
    // Mesma razão: comprar ou mover muda a pilha, e não registrar o tamanho
    // novo faria a próxima queda ser medida contra o tamanho de antes.
    for (const item of []
      .concat(Array.isArray(value.added) ? value.added : [])
      .concat(Array.isArray(value.updated) ? value.updated : [])) {
      const uid = str(item && item.uid);
      if (uid) stacks.set(uid, int(item && item.qty) || 1);
    }
    return out;
  }

  const registrar = (item, qty, bag) => {
    const info = describe(item && (item.def_id || item.defId), item, catalog);
    if (!info.defId || isGear(info)) return;
    if (qty <= 0) return;
    out.push({ ...info, qty, bag, reason: motivo });
  };

  for (const item of Array.isArray(value.added) ? value.added : []) {
    const uid = str(item && item.uid);
    const qty = int(item && item.qty) || 1;
    if (uid) stacks.set(uid, qty);
    registrar(item, qty, qty);
  }

  for (const item of Array.isArray(value.updated) ? value.updated : []) {
    const uid = str(item && item.uid);
    const qty = int(item && item.qty);
    const antes = uid && stacks.has(uid) ? stacks.get(uid) : null;
    if (uid) stacks.set(uid, qty);
    if (antes == null) continue;
    registrar(item, qty - antes, qty);
  }

  return out;
}

/**
 * Incorpora um `inventory_delta` ao acumulado. Devolve `true` se algo mudou.
 *
 * O log é o que caiu, em ordem de chegada. Ganhos seguidos do mesmo item são
 * fundidos na linha do topo quando chegam dentro de `MERGE_MS`: numa caçada
 * boa a mesma essência cai três vezes em dois segundos, e três linhas iguais
 * com horários idênticos empurram para fora do painel o que caiu antes.
 */
const MERGE_MS = 15000;

function apply(loot, value, { stacks, catalog, nowMs = Date.now() } = {}) {
  const ganhos = readDelta(value, stacks || new Map(), catalog);
  if (!ganhos.length) return false;

  for (const ganho of ganhos) {
    loot.events += ganho.qty;

    const atual = loot.session[ganho.defId];
    if (atual) {
      atual.qty += ganho.qty;
      atual.bag = ganho.bag;
      atual.lastAtMs = nowMs;
      // A cor pode ter chegado depois do item: o catálogo é lido uma vez por
      // execução e o primeiro drop costuma vir antes dele.
      if (!atual.color && ganho.color) {
        atual.color = ganho.color;
        atual.rarity = ganho.rarity;
        atual.order = ganho.order;
        atual.name = ganho.name;
      }
    } else {
      loot.session[ganho.defId] = {
        defId: ganho.defId,
        name: ganho.name,
        icon: ganho.icon,
        rarity: ganho.rarity,
        color: ganho.color,
        order: ganho.order,
        key: ganho.key,
        qty: ganho.qty,
        bag: ganho.bag,
        firstAtMs: nowMs,
        lastAtMs: nowMs
      };
      podar(loot.session);
    }

    const topo = loot.log[0];
    if (topo && topo.defId === ganho.defId && nowMs - topo.atMs < MERGE_MS) {
      topo.qty += ganho.qty;
      topo.bag = ganho.bag;
      topo.atMs = nowMs;
    } else {
      loot.log.unshift({
        defId: ganho.defId,
        name: ganho.name,
        rarity: ganho.rarity,
        color: ganho.color,
        key: ganho.key,
        qty: ganho.qty,
        bag: ganho.bag,
        reason: ganho.reason,
        atMs: nowMs
      });
      if (loot.log.length > LOG_MAX) loot.log.length = LOG_MAX;
    }
  }

  return true;
}

/**
 * Mantém `session` no teto, descartando o item mais antigo e mais comum.
 *
 * Sem isso uma caçada longa acumularia centenas de ids e o estado inteiro vai
 * por IPC a cada segundo. O descarte olha a raridade antes da idade: a chave
 * que caiu há uma hora importa mais que o material que caiu agora.
 */
function podar(session) {
  const ids = Object.keys(session);
  if (ids.length <= SESSION_MAX) return;
  let pior = null;
  for (const id of ids) {
    const linha = session[id];
    if (linha.key) continue;
    if (!pior
      || linha.order < pior.order
      || (linha.order === pior.order && linha.lastAtMs < pior.lastAtMs)) {
      pior = linha;
    }
  }
  if (pior) delete session[pior.defId];
}

/** Caçada nova: o acumulado é da caçada, o log é do dia e sobrevive. */
function resetSession(loot, startedAtMs) {
  loot.session = {};
  loot.events = 0;
  loot.startedAtMs = Number(startedAtMs) || 0;
}

module.exports = {
  initialLoot,
  apply,
  readDelta,
  describe,
  resetSession,
  titleize,
  LOOT_REASONS,
  GEAR_CATEGORIES,
  LOG_MAX,
  SESSION_MAX,
  MERGE_MS
};

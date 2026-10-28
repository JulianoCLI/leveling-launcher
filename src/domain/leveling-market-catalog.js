/**
 * @file leveling-market-catalog.js
 * Aparência dos itens: ícone, cor de raridade, nível e as fichas de sombra.
 *
 * O feed de vendas é econômico de propósito — `MarketSale` traz `def_id`,
 * `name`, `category`, `rarity` e pouco mais. Nada de ícone, nada de cor, nada
 * de nível. Quem tem isso é o `content_catalog`, o pacote de 1 MB que chega
 * uma vez por login e que o launcher descartava inteiro.
 *
 * Este arquivo extrai dele só o que a tela de preços precisa para parecer com
 * o jogo, e joga fora o resto na mesma passada. O recorte final tem cerca de
 * 30 KB: cabe num arquivo JSON ao lado do banco e é carregado antes de
 * qualquer login, para a tabela abrir já com os ícones em vez de piscar.
 *
 * Três mapas:
 *
 *   items     `def_id` → ícone, raridade base, categoria, slot, empilhável
 *   rarities  `comum`/`raro`/... → a cor exata que o jogo usa
 *   monsters  `monster_id` → nome e pasta do sprite, para as sombras
 *
 * Sombras não têm `def_id`: o feed manda o nome do monstro nesse campo
 * (medido: `def_id: "Slime Corrosivo"`). O casamento com `MonsterDef` é por
 * nome, não por id, e é por isso que `monsters` guarda os dois.
 */

'use strict';

/** De onde saem as imagens. O jogo é servido daqui. */
const ASSET_ORIGIN = 'https://levelingidle2d.com.br';

/**
 * Prefixo dos ícones que o catálogo escreve em forma curta.
 *
 * Medido: `ItemDef.icon` vem em dois formatos. Equipamento traz caminho
 * absoluto pronto (`/assets/paperdoll/gear/arco-arqueiro/icon.png`); material
 * e consumível trazem só o talo (`imbuimento/membrana-sombria`), que o jogo
 * completa com este prefixo e a extensão. Verificado contra o servidor: com o
 * prefixo responde 200 image/png, sem ele 404.
 */
const ITEM_ICON_BASE = '/assets/items/mmorpg-v1/';

/** Sprite do monstro, para a ficha da sombra. Verificado: 200 image/png. */
const MONSTER_ICON = dir => `/assets/monsters/${dir}/idle.png`;

const str = v => (typeof v === 'string' ? v : '');

/**
 * Caminho completo de um ícone, ou `''` se não há.
 *
 * Devolve caminho absoluto no servidor do jogo, não URL completa: a origem é
 * concatenada na interface, onde é possível trocá-la sem reescrever o banco.
 */
function iconPath(icon) {
  const i = str(icon).trim();
  if (!i) return '';
  if (i.startsWith('http://') || i.startsWith('https://')) return i;
  if (i.startsWith('/')) return i;
  // Forma curta: sem barra inicial e normalmente sem extensão.
  return ITEM_ICON_BASE + (i.endsWith('.png') || i.endsWith('.webp') ? i : `${i}.png`);
}

/**
 * Nome legível a partir do enum do protobuf.
 * `EQUIP_SLOT_PEITORAL` → `peitoral`, `ITEM_CATEGORY_WEAPONS` → `weapons`.
 * Os `_UNSPECIFIED` viram vazio: proto3 omite o zero, e o nome do zero não é
 * informação nenhuma.
 */
function enumTail(value, prefix) {
  const v = str(value);
  if (!v || v.endsWith('_UNSPECIFIED')) return '';
  return (v.startsWith(prefix) ? v.slice(prefix.length) : v).toLowerCase();
}

/**
 * Recorta o `content_catalog` para o que a tela de preços mostra.
 *
 * Nada do objeto de entrada fica retido: cada campo é copiado para um literal
 * novo. O catálogo inteiro sai de escopo quando esta função retorna, que é a
 * razão de ela existir em vez de guardar a referência.
 */
function readMarketCatalog(value) {
  const safe = value || {};
  const items = {};
  for (const def of Array.isArray(safe.items) ? safe.items : []) {
    const id = str(def && def.id);
    if (!id) continue;
    const linha = { name: str(def.name) || id };
    const icon = iconPath(def.icon);
    if (icon) linha.icon = icon;
    if (str(def.base_rarity)) linha.rarity = str(def.base_rarity);
    const cat = enumTail(def.category, 'ITEM_CATEGORY_');
    if (cat) linha.category = cat;
    const slot = enumTail(def.slot, 'EQUIP_SLOT_');
    if (slot) linha.slot = slot;
    if (def.stackable) linha.stackable = true;
    if (def.levelless) linha.levelless = true;
    // Atributos base: é o que responde "esta armadura serve para quê".
    const base = def.base && typeof def.base === 'object' ? def.base : null;
    if (base) {
      const stats = {};
      for (const [k, v] of Object.entries(base)) {
        const n = Number(v);
        if (Number.isFinite(n) && n !== 0) stats[k] = n;
      }
      if (Object.keys(stats).length) linha.stats = stats;
    }
    items[id] = linha;
  }

  const rarities = {};
  for (const r of Array.isArray(safe.rarities) ? safe.rarities : []) {
    const id = str(r && r.id);
    if (!id) continue;
    rarities[id] = {
      name: str(r.name) || id,
      color: str(r.color),
      order: Number(r.order) || 0
    };
  }

  /**
   * Ranks de sombra. `ShadowRankDef.color` é um inteiro de 24 bits, não uma
   * string CSS como em `RarityDef` — converter aqui evita que a interface
   * tenha de saber dessa inconsistência do servidor.
   */
  const shadowRanks = {};
  for (const r of Array.isArray(safe.shadow_ranks) ? safe.shadow_ranks : []) {
    const id = str(r && r.id);
    if (!id) continue;
    const n = Number(r.color);
    shadowRanks[id] = {
      name: str(r.name) || id,
      color: Number.isFinite(n) && n > 0 ? '#' + (n & 0xffffff).toString(16).padStart(6, '0') : '',
      order: Number(r.order) || 0
    };
  }

  /**
   * Monstros, indexados pelo nome além do id: o feed de vendas de sombra
   * manda o nome no campo `def_id` (medido: `def_id: "Slime Corrosivo"`), e
   * sem o índice por nome não haveria como achar o sprite.
   */
  const monsters = {};
  for (const m of Array.isArray(safe.monsters) ? safe.monsters : []) {
    const id = str(m && m.id);
    const nome = str(m && m.name);
    if (!id) continue;
    const linha = { name: nome || id, icon: MONSTER_ICON(str(m.sprite_dir) || id) };
    monsters[id] = linha;
    if (nome && nome !== id) monsters[nome] = linha;
  }

  return {
    items,
    rarities,
    shadowRanks,
    monsters,
    origin: ASSET_ORIGIN,
    version: str(safe.version),
    readAtMs: Date.now()
  };
}

/** Tem conteúdo suficiente para valer a pena guardar? */
function hasCatalog(cat) {
  return !!(cat && cat.items && Object.keys(cat.items).length);
}

module.exports = {
  readMarketCatalog,
  hasCatalog,
  iconPath,
  ASSET_ORIGIN,
  ITEM_ICON_BASE
};

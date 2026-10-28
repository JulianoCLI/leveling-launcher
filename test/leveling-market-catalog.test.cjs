'use strict';

/**
 * @file leveling-market-catalog.test.cjs
 * O recorte de aparência do catálogo.
 *
 * O que estes testes protegem é a tradução entre o formato do servidor e o
 * que a tela consegue usar: dois formatos de ícone que resolvem para
 * caminhos diferentes, uma cor que vem como inteiro onde a outra vem como
 * string, e sombras que chegam identificadas por nome em vez de id.
 */

const test = require('node:test');
const assert = require('node:assert');

const {
  readMarketCatalog, hasCatalog, iconPath, ITEM_ICON_BASE, ASSET_ORIGIN
} = require('../src/domain/leveling-market-catalog');

test('ícone absoluto do catálogo passa intacto', () => {
  const p = '/assets/paperdoll/gear/arco-arqueiro/icon.png';
  assert.strictEqual(iconPath(p), p);
});

test('ícone em forma curta ganha o prefixo e a extensão', () => {
  // Medido contra o servidor: só com este prefixo a imagem responde 200.
  assert.strictEqual(
    iconPath('imbuimento/membrana-sombria'),
    ITEM_ICON_BASE + 'imbuimento/membrana-sombria.png'
  );
});

test('forma curta que já traz extensão não ganha outra', () => {
  assert.strictEqual(
    iconPath('gems/gema-ametista.png'),
    ITEM_ICON_BASE + 'gems/gema-ametista.png'
  );
});

test('ícone ausente vira string vazia, não caminho quebrado', () => {
  for (const v of [undefined, null, '', '   ', 42]) {
    assert.strictEqual(iconPath(v), '');
  }
});

test('URL completa é respeitada', () => {
  assert.strictEqual(iconPath('https://cdn/x.png'), 'https://cdn/x.png');
});

test('itens guardam ícone, raridade, slot e atributos base', () => {
  const cat = readMarketCatalog({
    items: [{
      id: 'arco-arqueiro',
      name: 'Arco de Arqueiro',
      icon: '/assets/paperdoll/gear/arco-arqueiro/icon.png',
      slot: 'EQUIP_SLOT_ARMA',
      category: 'ITEM_CATEGORY_WEAPONS',
      base_rarity: 'raro',
      base: { atk: 9, def: 0 }
    }]
  });
  const i = cat.items['arco-arqueiro'];
  assert.strictEqual(i.name, 'Arco de Arqueiro');
  assert.strictEqual(i.icon, '/assets/paperdoll/gear/arco-arqueiro/icon.png');
  assert.strictEqual(i.rarity, 'raro');
  assert.strictEqual(i.slot, 'arma');
  assert.strictEqual(i.category, 'weapons');
  // Zero não é informação: proto3 omite o campo ausente e o zero explícito
  // apareceria como "DEF 0" na ficha, sugerindo um atributo que não existe.
  assert.deepStrictEqual(i.stats, { atk: 9 });
});

test('enum não especificado não vira rótulo', () => {
  const cat = readMarketCatalog({
    items: [{ id: 'x', name: 'X', slot: 'EQUIP_SLOT_UNSPECIFIED' }]
  });
  assert.strictEqual(cat.items.x.slot, undefined);
});

test('item sem id é descartado', () => {
  const cat = readMarketCatalog({ items: [{ name: 'sem id' }, { id: 'ok' }] });
  assert.deepStrictEqual(Object.keys(cat.items), ['ok']);
});

test('cores de raridade saem como o jogo as escreve', () => {
  const cat = readMarketCatalog({
    rarities: [{ id: 'lendario', name: 'Lendário', color: '#fbbf24', order: 4 }]
  });
  assert.deepStrictEqual(cat.rarities.lendario, {
    name: 'Lendário', color: '#fbbf24', order: 4
  });
});

test('cor de rank de sombra vira hexadecimal CSS', () => {
  // `ShadowRankDef.color` é inteiro de 24 bits, ao contrário de `RarityDef`.
  const cat = readMarketCatalog({
    shadow_ranks: [
      { id: 'normal', name: 'Normal', color: 9402073 },
      { id: 'preto', name: 'Preto', color: 255 }
    ]
  });
  assert.strictEqual(cat.shadowRanks.normal.color, '#8f76d9');
  // Padding: sem ele `255` viraria `#ff`, que o navegador ignora.
  assert.strictEqual(cat.shadowRanks.preto.color, '#0000ff');
});

test('rank sem cor não inventa uma', () => {
  const cat = readMarketCatalog({ shadow_ranks: [{ id: 'x', name: 'X' }] });
  assert.strictEqual(cat.shadowRanks.x.color, '');
});

test('monstro é achável por id e por nome', () => {
  // O feed de vendas de sombra manda o nome em `def_id`; sem o índice por
  // nome não haveria como achar o sprite.
  const cat = readMarketCatalog({
    monsters: [{ id: 'slime-corrosivo', name: 'Slime Corrosivo', sprite_dir: 'slime-corrosivo' }]
  });
  const esperado = '/assets/monsters/slime-corrosivo/idle.png';
  assert.strictEqual(cat.monsters['slime-corrosivo'].icon, esperado);
  assert.strictEqual(cat.monsters['Slime Corrosivo'].icon, esperado);
});

test('monstro sem sprite_dir cai no id', () => {
  const cat = readMarketCatalog({ monsters: [{ id: 'orc', name: 'Orc' }] });
  assert.strictEqual(cat.monsters.orc.icon, '/assets/monsters/orc/idle.png');
});

test('catálogo vazio não quebra nem é considerado útil', () => {
  for (const v of [undefined, null, {}, { items: 'não é lista' }]) {
    const cat = readMarketCatalog(v);
    assert.deepStrictEqual(cat.items, {});
    assert.strictEqual(hasCatalog(cat), false);
  }
});

test('catálogo com itens é considerado útil', () => {
  assert.strictEqual(hasCatalog(readMarketCatalog({ items: [{ id: 'a' }] })), true);
});

test('a origem viaja junto, para a interface montar a URL', () => {
  assert.strictEqual(readMarketCatalog({}).origin, ASSET_ORIGIN);
});

test('nada do catálogo original fica retido', () => {
  // O catálogo cru tem mais de 1 MB. Se o recorte guardasse referência a
  // qualquer sub-objeto dele, o pacote inteiro ficaria vivo na memória.
  const base = { atk: 9 };
  const cru = { items: [{ id: 'a', name: 'A', base }] };
  const cat = readMarketCatalog(cru);
  base.atk = 999;
  assert.strictEqual(cat.items.a.stats.atk, 9);
});

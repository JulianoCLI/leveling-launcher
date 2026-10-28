/**
 * @file market-probe.js
 * Sonda do mercado: o que dá para saber sobre preços de itens vendidos?
 *
 * O launcher ignora `market_push` e nunca fala `market_request`. Toda a
 * informação de mercado vem do schema, que é ambíguo nos pontos que importam:
 *
 *   - `MarketHistory` é mensagem VAZIA. Sem página, sem filtro, sem seller_id.
 *     Isso é histórico pessoal ou global? Quantas linhas o servidor devolve?
 *     Que janela de tempo cobre?
 *   - `MarketPriceHint{def_id, rarity, currency, days}` tem `days` como pedido
 *     E como resposta. O servidor respeita o que se pede ou impõe um teto?
 *   - `MarketSale.seller_name` existe. Se vier preenchido com nomes de outros
 *     jogadores, `history` é global e a aba de preços sai de graça.
 *
 * Cada passo é um experimento numerado, com o resultado logado cru. Nada é
 * inferido: o que o servidor responde é o que vale.
 *
 *   node tools/market-probe.js --user U --pass P
 *
 * Somente leitura: nenhum passo cria, compra ou cancela anúncio.
 *
 * ACHADOS (execução de 2026-10-27, conta samaleiko):
 *
 *   1. `history` é GLOBAL, não pessoal. A conta tinha ZERO anúncios (`mine`
 *      devolveu lista vazia) e ainda assim vieram 100 vendas de itens variados.
 *      É o feed de vendas recentes do mercado inteiro.
 *   2. `history` devolve exatamente 100 linhas, estável entre chamadas, e
 *      cobre apenas ~30 MINUTOS de mercado. O volume é altíssimo. Sem acúmulo
 *      local não existe histórico: a cada meia hora a janela inteira rola.
 *   3. `seller_name` e `buyer_name` vêm VAZIOS em `history` (anonimizado).
 *      Em `search`/`MarketListing` o `seller_name` vem preenchido.
 *   4. `overview` é restrito a GM: `error{admin.forbidden, required:GM}`.
 *      Não dá para saber o total global de vendas.
 *   5. `price_hint` funciona para qualquer `def_id` e é a fonte boa de preço
 *      histórico. O `days` pedido é ENCAIXADO em degraus fixos: 1 -> 7,
 *      7 -> 7, 30 -> 30, 365 -> 90. Degraus observados: 7, 30, 90.
 *   6. `price_hint.rarity` NÃO filtra nada (mesma resposta com e sem).
 *      def_id inexistente devolve `{days:30}` sem erro.
 *   7. `price_hint.lowest_now` veio ausente; quem traz preço ativo de verdade
 *      é `get{id}` -> `MarketDetail.prices` (`MarketPriceStats`), que é mais
 *      rico: sales, lowest/highest/average_sold, active_listings,
 *      units_on_sale, lowest_now, highest_now. Custa um listing_id.
 *   8. `market_push` não chegou em 15s — provavelmente só dispara em venda
 *      PRÓPRIA (`MarketSold` tem `fee`/`net`, campos de vendedor).
 *   9. `config`: sale_fee 0.1, page_size 24, listing_limit 20.
 *      categorias: todos, equipamentos, armas, armadura, acessorios,
 *      consumiveis, materiais, especiais, sombra.
 *      sorts: recentes, antigos, preco-asc, preco-desc, quantidade,
 *      raridade, poder, rank.  (NÃO são PRICE_ASC/NEWEST do enum LookSort.)
 *  10. `MarketGet.id` é uint64: o encode exige Number/Long, mas o decode
 *      entrega string. Converter antes de mandar.
 *  11. Escala: `search{category:'todos'}` -> 4046 anúncios ativos em 169
 *      páginas. `arco-arqueiro` sozinho: 4055 vendas em 30 dias.
 *
 * Ferramenta de investigação, não parte do launcher.
 */

'use strict';

const { getCodec } = require('../src/domain/leveling-codec');

const WS_URL = 'wss://game.levelingidle2d.com.br:8443/ws';
const ORIGIN = 'https://levelingidle2d.com.br';

function args() {
  const out = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i].replace(/^--/, '');
    out[key] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
  }
  return out;
}

const opts = args();
if (!opts.user || !opts.pass) {
  console.error('uso: node tools/market-probe.js --user U --pass P [--def ID] [--cat CATEGORIA]');
  process.exit(1);
}

const codec = getCodec();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(...a);
const brief = (v, n = 700) => {
  const t = JSON.stringify(v);
  return t && t.length > n ? t.slice(0, n) + `…(${t.length}b)` : t;
};
const when = ms => {
  const n = Number(ms);
  return Number.isFinite(n) && n > 0 ? new Date(n).toISOString().replace('T', ' ').slice(0, 19) : '?';
};

let nextId = 1;
const pending = new Map();
let ws = null;

const pushes = [];
let myName = null;

function send(caseName, value, timeoutMs = 12000) {
  const id = nextId++;
  let payload;
  try {
    payload = codec.encode(id, caseName, value);
  } catch (e) {
    return Promise.resolve({ caseName: 'ENCODE_FAIL', value: { message: e.message } });
  }
  ws.send(payload);
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      pending.delete(id);
      resolve({ caseName: 'TIMEOUT', value: {} });
    }, timeoutMs);
    pending.set(id, { resolve: r => { clearTimeout(timer); resolve(r); } });
  });
}

/**
 * Um experimento de mercado. Toda operação viaja dentro de `market_request`,
 * então o case da resposta é sempre `market_response` — o que interessa é a
 * chave do oneof `result` lá dentro.
 */
async function market(n, title, op, value = {}) {
  log(`\n[${n}] ${title}`);
  log(`    → market_request{${op}} ${JSON.stringify(value)}`);
  const res = await send('market_request', { [op]: value });
  if (res.caseName !== 'market_response') {
    log(`    ← ${res.caseName} ${brief(res.value)}`);
    return { result: null, value: res.value, caseName: res.caseName };
  }
  const body = res.value || {};
  const result = Object.keys(body)[0] || null;
  log(`    ← market_response{${result}} ${brief(body[result])}`);
  return { result, value: body[result] || {}, caseName: res.caseName };
}

function onPacket(data) {
  const buf = Buffer.from(data);
  const head = codec.peek(buf);
  if (!head.caseName) return;
  if (head.caseName === 'world_snapshot' || head.caseName === 'world_delta') return;
  if (head.caseName === 'world_events') return;

  let packet;
  try { packet = codec.decode(buf); } catch { return; }
  const value = packet.value || {};

  if (packet.requestId && pending.has(packet.requestId)) {
    const entry = pending.get(packet.requestId);
    pending.delete(packet.requestId);
    entry.resolve({ caseName: packet.caseName, value });
    return;
  }

  // O push que o launcher descarta hoje. Se ele chegar, dá notificação de
  // venda em tempo real sem polling.
  if (packet.caseName === 'market_push') {
    pushes.push({ at: Date.now(), value });
    log(`    [push] market_push ${brief(value, 400)}`);
  }

  if (packet.caseName === 'auth_ok' || packet.caseName === 'player_state') {
    const p = value.player || value.character || value;
    if (p && p.name && !myName) myName = p.name;
  }
}

/** Tabela compacta de MarketSale — o formato que a aba de Vendas mostraria. */
function tableSales(sales) {
  if (!sales || !sales.length) { log('   (vazio)'); return; }
  log('   data                | item                           | qtd | unit      | total     | taxa    | liq.      | vendedor      -> comprador');
  for (const s of sales.slice(0, 40)) {
    const nome = `${s.name || s.def_id || '?'}${s.enchant ? ' +' + s.enchant : ''}`;
    log([
      when(s.sold_at_ms).padEnd(19),
      nome.slice(0, 30).padEnd(30),
      String(s.quantity || 1).padStart(3),
      String(s.unit_price || 0).padStart(9),
      String(s.total || 0).padStart(9),
      String(s.fee || 0).padStart(7),
      String(s.net || 0).padStart(9),
      `${s.seller_name || '?'} -> ${s.buyer_name || '?'}`
    ].join(' | '));
  }
  if (sales.length > 40) log(`   …mais ${sales.length - 40} linhas`);
}

(async () => {
  ws = new WebSocket(WS_URL, { headers: { Origin: ORIGIN } });
  ws.binaryType = 'arraybuffer';
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error('conexão falhou'));
    setTimeout(() => reject(new Error('timeout ao conectar')), 20000);
  });
  ws.onmessage = e => onPacket(e.data);
  ws.onclose = e => log('== socket fechado, code', e && e.code);

  const auth = await send('login', { username: opts.user, password: opts.pass });
  if (auth.caseName !== 'auth_ok') {
    log('!! login recusado:', auth.caseName, brief(auth.value));
    ws.close();
    return;
  }
  const authPlayer = (auth.value && (auth.value.player || auth.value.character)) || {};
  myName = authPlayer.name || myName;
  log('== login ok | personagem:', myName || '(nome não veio no auth_ok)');
  await sleep(4000);

  // ------------------------------------------------------------- 1. config
  // Define o vocabulário de tudo o que vem depois: categorias válidas para
  // `search`, nomes de `sort`, page_size e a taxa de venda (que permite
  // conferir se `fee` em MarketSale bate com `total * sale_fee`).
  const cfg = await market(1, 'config — vocabulário do mercado', 'config');
  const config = cfg.value || {};
  log('   categorias :', (config.categories || []).join(', ') || '(nenhuma)');
  log('   sorts      :', (config.sorts || []).join(', ') || '(nenhum)');
  log('   sale_fee   :', config.sale_fee, '| page_size:', config.page_size,
    '| listing_limit:', config.listing_limit);

  // ----------------------------------------------------------- 2. overview
  // Números globais. Se `total_sales` for muito maior que o nº de linhas que
  // `history` devolver no passo 3, então `history` é pessoal ou truncado.
  const ov = await market(2, 'overview — volume global do mercado', 'overview');
  log('   anúncios ativos:', ov.value.active_listings,
    '| vendas totais:', ov.value.total_sales,
    '| ouro movido:', ov.value.gold_moved,
    '| diamantes:', ov.value.diamonds_moved);

  // ------------------------------------------------------------ 3. history
  // A PERGUNTA CENTRAL. Mensagem vazia, sem paginação. Três coisas a medir:
  //   a) quantas linhas vêm;
  //   b) os `seller_name` são só o meu personagem (pessoal) ou variados (global);
  //   c) qual a janela de tempo entre a venda mais antiga e a mais nova.
  const hist = await market(3, 'history — HISTÓRICO DE VENDAS (pessoal ou global?)', 'history');
  const sales = hist.value.sales || [];
  log(`\n   linhas devolvidas: ${sales.length}`);
  if (sales.length) {
    const vendedores = new Set(sales.map(s => s.seller_name).filter(Boolean));
    const compradores = new Set(sales.map(s => s.buyer_name).filter(Boolean));
    const datas = sales.map(s => Number(s.sold_at_ms)).filter(n => Number.isFinite(n) && n > 0);
    const min = Math.min(...datas);
    const max = Math.max(...datas);
    log(`   vendedores distintos: ${vendedores.size} -> ${[...vendedores].slice(0, 10).join(', ')}`);
    log(`   compradores distintos: ${compradores.size} -> ${[...compradores].slice(0, 10).join(', ')}`);
    log(`   janela: ${when(min)} .. ${when(max)}  (${((max - min) / 86400000).toFixed(1)} dias)`);
    log(`   meu personagem: ${myName || '?'}`);
    log('   VEREDITO: ' + (
      vendedores.size > 1 || (myName && !vendedores.has(myName))
        ? 'GLOBAL (aparecem outros vendedores)'
        : 'PESSOAL (só eu vendo nessas linhas) — ou simplesmente só eu tenho vendas'
    ));
    log(`   truncado? overview.total_sales=${ov.value.total_sales} vs linhas=${sales.length}`);
    log('');
    tableSales(sales);
  } else {
    log('   NENHUMA VENDA. Se esta conta nunca vendeu nada, isto já é indício de');
    log('   que `history` é PESSOAL — overview acusa vendas globais mas a lista veio vazia.');
  }

  // Idempotência: a mesma chamada devolve o mesmo conjunto? Se mudar, há
  // ordenação instável ou janela deslizante e o merge local precisa de cuidado.
  const hist2 = await market('3b', 'history de novo (resposta é estável?)', 'history');
  const sales2 = hist2.value.sales || [];
  log(`   ${sales.length} -> ${sales2.length} linhas | mesmos ids: ${
    sales.length === sales2.length &&
    sales.every((s, i) => String(s.id) === String((sales2[i] || {}).id))}`);

  // --------------------------------------------------------- 4. mine/ativos
  // Serve de controle para o passo 3: `mine` é inequivocamente pessoal.
  // Comparar os formatos diz se `history` mora do mesmo lado da cerca.
  const mine = await market(4, 'mine — meus anúncios ativos (controle do que é "pessoal")', 'mine');
  const listings = mine.value.listings || mine.value.active || [];
  log('   meus anúncios:', Array.isArray(listings) ? listings.length : brief(mine.value));

  // --------------------------------------------------------- 5. search real
  // Preços do que está À VENDA agora. Diferente de preço vendido, mas é a
  // única visão global garantida — e fornece `def_id`s reais para o passo 6.
  const categoria = typeof opts.cat === 'string' ? opts.cat : (config.categories || [])[0] || '';
  const sorted = (config.sorts || []).includes('PRICE_ASC') ? 'PRICE_ASC' : (config.sorts || [])[0] || '';
  const page = await market(5, `search — anúncios ativos (categoria "${categoria}", sort "${sorted}")`,
    'search', { category: categoria, sort: sorted, page: 1 });
  const ativos = page.value.listings || [];
  log(`   total: ${page.value.total} em ${page.value.pages} páginas | nesta página: ${ativos.length}`);
  for (const l of ativos.slice(0, 15)) {
    log(`     ${String(l.unit_price).padStart(10)} ${String(l.currency || '').padEnd(16)} x${String(l.quantity).padEnd(4)} ${(l.name || l.def_id || '?').slice(0, 30).padEnd(30)} ${l.rarity || ''} ${l.def_id ? '[' + l.def_id + ']' : ''} ${l.seller_name || ''}`);
  }

  // ------------------------------------------------------- 6. price_hint
  // A fonte de preço histórico GLOBAL por item. Se funcionar, é ela que
  // alimenta a aba "Preços". `def_id` vem do search, ou de --def.
  const alvo = typeof opts.def === 'string' ? opts.def
    : (ativos.find(l => l.def_id) || {}).def_id || '';
  if (!alvo) {
    log('\n[6] nenhum def_id disponível (search vazio). Use --def ID para forçar.');
  } else {
    const h = await market(6, `price_hint para "${alvo}" (sem days — qual o padrão?)`,
      'price_hint', { def_id: alvo });
    log('   vendas:', h.value.sales, '| média:', h.value.average, '| mediana:', h.value.median);
    log('   menor vendido:', h.value.lowest_sold, '| maior vendido:', h.value.highest_sold);
    log('   menor ativo agora:', h.value.lowest_now, '| JANELA days:', h.value.days);

    // `days` é pedido e devolvido. O servidor obedece ou tem teto?
    for (const d of [1, 7, 30, 365]) {
      const r = await market(`6.${d}d`, `price_hint days=${d} (o servidor respeita a janela?)`,
        'price_hint', { def_id: alvo, days: d });
      log(`   pedido days=${d} -> devolvido days=${r.value.days} | vendas=${r.value.sales} média=${r.value.average}`);
    }

    // Filtro por raridade importa? Para equipamento, o mesmo def_id com
    // raridades diferentes não deveria compartilhar preço.
    const comRaridade = (ativos.find(l => l.def_id === alvo) || {}).rarity;
    if (comRaridade) {
      await market('6r', `price_hint com rarity="${comRaridade}" (o filtro muda algo?)`,
        'price_hint', { def_id: alvo, rarity: comRaridade });
    }

    await market('6x', 'price_hint com def_id inexistente (como erra um id ruim)',
      'price_hint', { def_id: 'nao-existe-mesmo' });
  }

  // ----------------------------------------------------------- 7. get/detail
  // `MarketDetail` carrega `MarketPriceStats`, que é mais rico que o
  // price_hint (traz active_listings e units_on_sale). Vale saber se dá para
  // obter estatística sem precisar de um listing_id.
  // `id` chega como string (longs:String no decode) e o encode exige Long.
  const algum = ativos[0];
  if (algum && algum.id) {
    const det = await market(7, `get id=${algum.id} — MarketDetail traz MarketPriceStats?`,
      'get', { id: Number(algum.id) });
    log('   prices:', brief(det.value.prices, 400));
  } else {
    log('\n[7] nenhum anúncio ativo para inspecionar, pulado');
  }

  // --------------------------------------------------------------- 8. pushes
  // Espera passiva: se alguma venda acontecer agora, `market_push` chega?
  log('\n[8] aguardando 15s por market_push (venda em tempo real)…');
  await sleep(15000);
  log(`   pushes recebidos: ${pushes.length}`);
  for (const p of pushes) log('   ', brief(p.value, 400));

  log('\n== fim');
  ws.close();
  setTimeout(() => process.exit(0), 500);
})().catch(e => {
  log('!! erro fatal:', e.message);
  process.exit(1);
});

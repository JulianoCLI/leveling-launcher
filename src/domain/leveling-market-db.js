/**
 * @file leveling-market-db.js
 * Banco local do histórico de vendas do mercado.
 *
 * O servidor devolve `market_request{history}` como um feed GLOBAL de vendas
 * recentes — medido: 100 linhas fixas cobrindo cerca de 30 minutos, sem
 * paginação e sem filtro. Não existe "ver o mês passado": a janela rola e o
 * que saiu dela está perdido para sempre.
 *
 * Por isso este arquivo existe. O launcher lê o feed de minuto em minuto e
 * acumula tudo aqui; a janela de 30 minutos do servidor vira histórico
 * permanente do lado do cliente. O valor do banco cresce com o tempo de uso, e
 * nada que ele guarda pode ser reconstruído depois.
 *
 * `node:sqlite` é embutido no Node 24 / Electron 43 — nenhuma dependência nova,
 * nenhum binário nativo para compilar por plataforma.
 *
 * A deduplicação é `INSERT OR IGNORE` na chave primária `sales.id`, que é o id
 * da venda no servidor. O feed de 30 minutos lido a cada minuto repete ~97% das
 * linhas de propósito: a sobreposição é o que garante que nada se perca se uma
 * leitura falhar, e o banco descarta a repetição sozinho.
 *
 * Os preços cabem em double sem perda (`price_max` do servidor é
 * 999.999.999.999, bem abaixo de 2^53), então ficam como INTEGER comum.
 */

'use strict';

const path = require('path');
const fs = require('fs');

/** Nome do arquivo dentro de `userData`. */
const DB_FILE = 'market.db';

/**
 * Vendas de câmbio (`cambio:diamante`, `cambio:ouro`) têm preço unitário que
 * não é comparável com o de um item: 10 de "preço" por 2.800.000 de ouro. Elas
 * entram no banco — são parte do mercado — mas as agregações de preço as
 * separam, senão a média de qualquer listagem geral vira ruído.
 */
const CAMBIO_PREFIX = 'cambio:';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sales (
  id          INTEGER PRIMARY KEY,
  listing_id  INTEGER,
  kind        TEXT,
  def_id      TEXT NOT NULL,
  name        TEXT,
  category    TEXT,
  rarity      TEXT,
  enchant     INTEGER NOT NULL DEFAULT 0,
  currency    TEXT,
  quantity    INTEGER NOT NULL DEFAULT 1,
  unit_price  INTEGER NOT NULL DEFAULT 0,
  total       INTEGER NOT NULL DEFAULT 0,
  fee         INTEGER NOT NULL DEFAULT 0,
  net         INTEGER NOT NULL DEFAULT 0,
  sold_at_ms  INTEGER NOT NULL,
  seller_name TEXT,
  buyer_name  TEXT,
  seen_at_ms  INTEGER NOT NULL,
  -- Nível e slot do item vendido. NÃO vêm no feed: MarketSale não tem esses
  -- campos, e por isso o histórico mostrava "Topázio" sem dizer se era o de
  -- nível 1 ou o de nível 4 — que são itens diferentes com o mesmo nome e
  -- preços de ordens de grandeza distintas.
  --
  -- Quem tem o nível é MarketListing, e medido: market_request{get} num
  -- anúncio JÁ VENDIDO ainda responde, com status MARKET_STATUS_SOLD e o
  -- level intacto. O listing_id que o feed traz é a chave.
  --
  -- NULL significa "ainda não perguntei"; 0 significa "perguntei e o item não
  -- tem nível" (câmbio, consumível). Confundir os dois faria o enriquecedor
  -- perguntar de novo, para sempre, sobre o que não tem resposta.
  level       INTEGER,
  slot        TEXT,
  -- Quando a consulta de nível foi feita. Existe para o enriquecedor saber o
  -- que já tentou: o anúncio expira do servidor e a pergunta passa a falhar,
  -- e sem isto ele reinsistiria em cada tique.
  level_at_ms INTEGER
);

-- A consulta dominante é "este item, nos últimos N dias", nesta ordem.
CREATE INDEX IF NOT EXISTS idx_sales_def_time  ON sales(def_id, sold_at_ms DESC);
CREATE INDEX IF NOT EXISTS idx_sales_time      ON sales(sold_at_ms DESC);
CREATE INDEX IF NOT EXISTS idx_sales_cat_time  ON sales(category, sold_at_ms DESC);

-- A mediana precisa das vendas de um item ordenadas por preço. Sem este índice
-- o SQLite materializa e ordena o conjunto inteiro a cada consulta; com ele a
-- função de janela lê em ordem e não ordena nada. Medido em 150 mil linhas:
-- 849 ms sem, 61 ms com.
CREATE INDEX IF NOT EXISTS idx_sales_def_price ON sales(def_id, unit_price);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);
`;

/**
 * Enum de moeda do protobuf. `MARKET_CURRENCY_GOLD` é o 1, e proto3 omite o
 * zero: venda em ouro chega com o campo **ausente**, virando `''` na coluna.
 * Por isso ouro é "não é diamante nem token", e não "é igual a GOLD" — essa
 * segunda forma deixaria de fora quase todas as vendas reais.
 */
const CURRENCY_DIAMOND = 'MARKET_CURRENCY_DIAMOND';
const CURRENCY_TOKEN = 'MARKET_CURRENCY_TOKEN';
const SQL_DIAMANTE = `currency = '${CURRENCY_DIAMOND}'`;
const SQL_OURO = `currency NOT IN ('${CURRENCY_DIAMOND}', '${CURRENCY_TOKEN}')`;

const num = v => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
};
const str = v => (typeof v === 'string' ? v : v == null ? '' : String(v));

/**
 * Converte uma `MarketSale` crua do protobuf numa linha do banco.
 *
 * `history` chega com `seller_name`/`buyer_name` vazios (o servidor anonimiza
 * o feed público), mas as colunas ficam: `MarketSold`, o push da venda própria,
 * traz o comprador, e a mesma tabela recebe os dois.
 */
function normalizeSale(sale) {
  if (!sale || sale.id == null) return null;
  const id = num(sale.id);
  if (!id) return null;
  const defId = str(sale.def_id) || str(sale.name);
  if (!defId) return null;
  return {
    id,
    listing_id: num(sale.listing_id),
    kind: str(sale.kind),
    def_id: defId,
    name: str(sale.name) || defId,
    category: str(sale.category),
    rarity: str(sale.rarity),
    enchant: num(sale.enchant),
    currency: str(sale.currency),
    quantity: num(sale.quantity) || 1,
    unit_price: num(sale.unit_price),
    total: num(sale.total),
    fee: num(sale.fee),
    net: num(sale.net),
    sold_at_ms: num(sale.sold_at_ms),
    seller_name: str(sale.seller_name),
    buyer_name: str(sale.buyer_name)
  };
}

/** Recorte de tempo comum a todas as consultas. `days` 0 ou ausente = tudo. */
function sinceOf(days) {
  const d = Number(days);
  if (!Number.isFinite(d) || d <= 0) return 0;
  return Date.now() - d * 86400000;
}

class MarketDatabase {
  /**
   * @param {string} file Caminho do arquivo. `:memory:` serve aos testes.
   */
  constructor(file) {
    this.file = file || ':memory:';
    this.db = null;
    this.ready = false;
    this.error = null;
    this.inserted = 0;

    /**
     * Resultados de `summary` já calculados, por combinação de filtros.
     *
     * Vale a pena porque as duas pontas são lentas de formas diferentes: a
     * consulta custa dezenas de milissegundos, mas o banco só muda uma vez
     * por minuto — todas as outras leituras, que são as do usuário mexendo
     * nos filtros e voltando do detalhe, respondem sobre dados idênticos.
     *
     * A invalidação é por escrita, não por tempo: `insertSales` limpa tudo
     * quando grava algo novo. Assim o cache nunca mostra um número velho, e
     * entre duas coletas as trocas de filtro são instantâneas.
     *
     * `sinceOf` arredonda para o milissegundo, então a chave inclui o período
     * em dias (estável), não o instante calculado (sempre diferente).
     */
    this.cache = new Map();
  }

  /** Esquece o que estava calculado. Chamado por qualquer escrita. */
  invalidate() {
    this.cache.clear();
  }

  open() {
    if (this.ready) return true;
    try {
      // Exigido tarde de propósito: quem não abre a aba do mercado não paga
      // o carregamento do módulo nem a criação do arquivo.
      const { DatabaseSync } = require('node:sqlite');
      if (this.file !== ':memory:') {
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
      }
      this.db = new DatabaseSync(this.file);
      // WAL: a escrita do poller não bloqueia a leitura da interface.
      this.db.exec('PRAGMA journal_mode = WAL');
      this.db.exec('PRAGMA synchronous = NORMAL');
      this.db.exec(SCHEMA);
      this.migrate();
      this.ready = true;
      this.error = null;
    } catch (err) {
      this.error = err && err.message || String(err);
      this.ready = false;
    }
    return this.ready;
  }

  /**
   * Colunas que nasceram depois do banco.
   *
   * `CREATE TABLE IF NOT EXISTS` não altera uma tabela existente, e o banco
   * do usuário já acumulou meses de vendas que não podem ser recriadas: o
   * servidor só lembra os últimos 30 minutos. Recriar a tabela destruiria o
   * único lugar onde esse histórico existe, então as colunas entram por
   * `ALTER TABLE` e os dados antigos ficam com `NULL` — que é a verdade:
   * ninguém perguntou o nível deles ainda.
   */
  migrate() {
    let colunas;
    try {
      colunas = new Set(this.db.prepare('PRAGMA table_info(sales)').all().map(c => c.name));
    } catch { return; }
    const novas = [
      ['level', 'INTEGER'],
      ['slot', 'TEXT'],
      ['level_at_ms', 'INTEGER']
    ];
    for (const [nome, tipo] of novas) {
      if (colunas.has(nome)) continue;
      try { this.db.exec(`ALTER TABLE sales ADD COLUMN ${nome} ${tipo}`); } catch {}
    }
    // Índice da fila do enriquecedor: "vendas sem nível, da mais recente
    // para a mais velha". Parcial de propósito — assim ele encolhe conforme
    // as vendas são enriquecidas, em vez de crescer com o banco.
    try {
      this.db.exec(`
        CREATE INDEX IF NOT EXISTS idx_sales_sem_nivel
        ON sales(sold_at_ms DESC) WHERE level IS NULL
      `);
    } catch {}
  }

  close() {
    if (this.db) { try { this.db.close(); } catch {} }
    this.db = null;
    this.ready = false;
  }

  /**
   * Grava um lote de `MarketSale`. Devolve quantas eram inéditas.
   *
   * O lote inteiro vai numa transação: 100 inserções soltas custariam 100
   * fsyncs, e o poller roda a cada minuto para sempre.
   */
  insertSales(sales) {
    if (!this.open() || !Array.isArray(sales) || !sales.length) return 0;
    const linhas = sales.map(normalizeSale).filter(Boolean);
    if (!linhas.length) return 0;

    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO sales
        (id, listing_id, kind, def_id, name, category, rarity, enchant, currency,
         quantity, unit_price, total, fee, net, sold_at_ms, seller_name, buyer_name, seen_at_ms)
      VALUES
        (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const agora = Date.now();
    let novas = 0;
    this.db.exec('BEGIN');
    try {
      for (const l of linhas) {
        const r = stmt.run(
          l.id, l.listing_id, l.kind, l.def_id, l.name, l.category, l.rarity,
          l.enchant, l.currency, l.quantity, l.unit_price, l.total, l.fee,
          l.net, l.sold_at_ms, l.seller_name, l.buyer_name, agora
        );
        if (r && r.changes) novas++;
      }
      this.db.exec('COMMIT');
    } catch (err) {
      try { this.db.exec('ROLLBACK'); } catch {}
      this.error = err && err.message || String(err);
      return 0;
    }
    this.inserted += novas;
    // Só invalida se algo mudou. A coleta relê a mesma janela trinta vezes
    // por meia hora; na maioria dos tiques `novas` é zero e o cache
    // sobrevive, que é exatamente quando ele serve.
    if (novas) this.invalidate();
    return novas;
  }

  /**
   * Vendas que ainda não têm nível, da mais recente para a mais velha.
   *
   * A ordem importa: o anúncio expira do servidor depois de um tempo, e
   * `get` passa a falhar. Perguntar primeiro pelas vendas novas é perguntar
   * enquanto a resposta ainda existe — as velhas provavelmente já não têm.
   *
   * Agrupa por `listing_id` porque é a chave do servidor: duas linhas do
   * mesmo anúncio (venda parcial) custariam duas perguntas para a mesma
   * resposta.
   */
  pendingLevels(limit = 20, listingIds = null) {
    if (!this.open()) return [];
    // Lista explícita: é a aba "Ao vivo" pedindo o nível das linhas que o
    // usuário está olhando agora. A fila de fundo vai da venda mais nova para
    // a mais velha e chegaria nelas sozinha, mas "sozinha" pode ser meia
    // hora depois — e a pergunta é sobre a tela aberta.
    const alvos = Array.isArray(listingIds)
      ? [...new Set(listingIds.map(num).filter(Boolean))]
      : null;
    if (alvos && !alvos.length) return [];
    const teto = Math.min(Math.max(num(limit) || 20, 1), 200);
    try {
      return this.db.prepare(`
        SELECT listing_id, MIN(def_id) AS def_id, MIN(name) AS name
        FROM sales
        WHERE level IS NULL AND listing_id > 0 AND level_at_ms IS NULL
        ${alvos ? `AND listing_id IN (${alvos.map(() => '?').join(',')})` : ''}
        GROUP BY listing_id
        ORDER BY MAX(sold_at_ms) DESC
        LIMIT ?
      `).all(...(alvos || []), teto);
    } catch (err) {
      this.error = err && err.message || String(err);
      return [];
    }
  }

  /**
   * Grava o nível descoberto para um ou mais anúncios.
   *
   * `level_at_ms` é marcado sempre, mesmo quando o nível não veio: é o que
   * impede o enriquecedor de perguntar de novo, para sempre, sobre anúncios
   * que já expiraram do servidor ou sobre itens que não têm nível.
   *
   * @param {Array<{listing_id:number, level:number|null, slot?:string}>} linhas
   */
  setLevels(linhas) {
    if (!this.open() || !Array.isArray(linhas) || !linhas.length) return 0;
    const stmt = this.db.prepare(`
      UPDATE sales SET level = ?, slot = COALESCE(?, slot), level_at_ms = ?
      WHERE listing_id = ?
    `);
    const agora = Date.now();
    let mudou = 0;
    this.db.exec('BEGIN');
    try {
      for (const l of linhas) {
        const id = num(l && l.listing_id);
        if (!id) continue;
        // `null` viraria "não perguntei" outra vez; 0 é a resposta honesta
        // para um item sem nível, e é o que permite parar de perguntar.
        const nivel = l.level == null ? 0 : num(l.level);
        const r = stmt.run(nivel, str(l.slot) || null, agora, id);
        if (r && r.changes) mudou += r.changes;
      }
      this.db.exec('COMMIT');
    } catch (err) {
      try { this.db.exec('ROLLBACK'); } catch {}
      this.error = err && err.message || String(err);
      return 0;
    }
    if (mudou) this.invalidate();
    return mudou;
  }

  /**
   * O nível já conhecido de anúncios específicos, por `listing_id`.
   *
   * A aba "Ao vivo" lista vendas, não itens: ela precisa do nível de cada
   * linha, não da quebra agregada. Devolve só o que tem resposta — anúncio
   * ainda não perguntado fica fora do mapa, e a tela mostra isso como
   * ausência em vez de inventar um nível.
   */
  levelsOf(listingIds) {
    if (!this.open() || !Array.isArray(listingIds) || !listingIds.length) return {};
    const ids = [...new Set(listingIds.map(num).filter(Boolean))].slice(0, 500);
    if (!ids.length) return {};
    try {
      const linhas = this.db.prepare(`
        SELECT listing_id, level, slot FROM sales
        WHERE listing_id IN (${ids.map(() => '?').join(',')}) AND level IS NOT NULL
      `).all(...ids);
      const mapa = {};
      for (const l of linhas) mapa[String(l.listing_id)] = { level: l.level, slot: l.slot || '' };
      return mapa;
    } catch (err) {
      this.error = err && err.message || String(err);
      return {};
    }
  }

  /**
   * Preço por nível de um item.
   *
   * É a resposta para "Topázio de que nível?". Sem isto, as vendas de um
   * nome só apareciam somadas, e no caso das gemas isso juntava coisas que
   * variam 10 000x de preço — medido: `gema-ametista` entre 1 e 21 000 000.
   * A média de tudo junto não descreve nenhum dos níveis.
   */
  levelBreakdown(defId, opts = {}) {
    if (!this.open() || !defId) return [];
    const since = sinceOf(opts.days);
    try {
      return this.db.prepare(`
        SELECT level,
               COUNT(*) AS vendas,
               SUM(quantity) AS unidades,
               COUNT(CASE WHEN ${SQL_OURO} THEN 1 END) AS vendas_ouro,
               CAST(SUM(CASE WHEN ${SQL_OURO} THEN unit_price * quantity END) AS REAL)
                 / NULLIF(SUM(CASE WHEN ${SQL_OURO} THEN quantity END), 0) AS media,
               MIN(CASE WHEN ${SQL_OURO} THEN unit_price END) AS minimo,
               MAX(CASE WHEN ${SQL_OURO} THEN unit_price END) AS maximo,
               COUNT(CASE WHEN ${SQL_DIAMANTE} THEN 1 END) AS vendas_dia,
               CAST(SUM(CASE WHEN ${SQL_DIAMANTE} THEN unit_price * quantity END) AS REAL)
                 / NULLIF(SUM(CASE WHEN ${SQL_DIAMANTE} THEN quantity END), 0) AS media_dia,
               MAX(sold_at_ms) AS ultima_venda_ms
        FROM sales
        WHERE def_id = ? AND sold_at_ms >= ? AND level IS NOT NULL AND level > 0
        GROUP BY level
        ORDER BY level ASC
      `).all(String(defId), since);
    } catch (err) {
      this.error = err && err.message || String(err);
      return [];
    }
  }

  /**
   * Quantas vendas já têm nível descoberto.
   *
   * A tela precisa disto para ser honesta: uma quebra por nível feita sobre
   * 3 de 40 vendas não é a mesma coisa que uma feita sobre 38, e mostrar as
   * duas igual faria o usuário confiar num número que não merece confiança.
   */
  levelCoverage(defId, opts = {}) {
    if (!this.open()) return { total: 0, comNivel: 0 };
    const since = sinceOf(opts.days);
    const where = ['sold_at_ms >= ?'];
    const params = [since];
    if (defId) { where.push('def_id = ?'); params.push(String(defId)); }
    try {
      const r = this.db.prepare(`
        SELECT COUNT(*) AS total,
               COUNT(CASE WHEN level IS NOT NULL THEN 1 END) AS perguntadas,
               COUNT(CASE WHEN level > 0 THEN 1 END) AS comNivel
        FROM sales WHERE ${where.join(' AND ')}
      `).get(...params);
      return r || { total: 0, comNivel: 0 };
    } catch { return { total: 0, comNivel: 0 }; }
  }

  /**
   * Uma linha por item, com as estatísticas que respondem "quanto vale isto":
   * número de vendas, média ponderada por quantidade, mediana, mínimo, máximo,
   * e o último preço praticado com a data.
   *
   * Sai em duas consultas, de propósito. A versão de uma consulta só calculava
   * a mediana com `ROW_NUMBER() OVER (PARTITION BY def_id)` sobre o conjunto
   * filtrado inteiro — ordenar 150 mil linhas para devolver 150 medianas.
   * Medido nesse volume: 1950 ms, e a tela congelava a cada troca de filtro.
   *
   * Agora a primeira consulta é só agregação (`GROUP BY def_id`, que o índice
   * resolve) e já aplica `ORDER BY` e `LIMIT`; a segunda calcula mediana e
   * último preço apenas para os def_ids que de fato vão aparecer. O trabalho
   * deixa de crescer com o tamanho do banco e passa a crescer com o tamanho da
   * página. Medido depois: 95 ms no mesmo volume.
   */
  summary(opts = {}) {
    if (!this.open()) return { items: [], total: 0 };

    // `days` entra cru na chave, não o `since` calculado: o instante muda a
    // cada chamada e nenhuma leitura jamais acertaria o cache.
    const chave = JSON.stringify([
      'summary', opts.days || 0, opts.category || '', opts.currency || '',
      opts.search || '', opts.sort || '', opts.limit || 0, opts.offset || 0,
      !!opts.includeExchange
    ]);
    if (this.cache.has(chave)) return this.cache.get(chave);

    const since = sinceOf(opts.days);
    const limit = Math.min(Math.max(num(opts.limit) || 200, 1), 2000);
    const offset = Math.max(num(opts.offset), 0);

    const where = ['sold_at_ms >= ?'];
    const params = [since];
    if (opts.category && opts.category !== 'todos') {
      where.push('category = ?');
      params.push(String(opts.category));
    }
    if (opts.currency) {
      where.push('currency = ?');
      params.push(String(opts.currency));
    }
    if (opts.search) {
      where.push('(name LIKE ? COLLATE NOCASE OR def_id LIKE ? COLLATE NOCASE)');
      const like = `%${String(opts.search)}%`;
      params.push(like, like);
    }
    if (!opts.includeExchange) {
      where.push("def_id NOT LIKE ?");
      params.push(`${CAMBIO_PREFIX}%`);
    }

    const ORDENS = {
      vendas: 'vendas DESC',
      recente: 'ultima_venda_ms DESC',
      'preco-desc': 'media DESC',
      'preco-asc': 'media ASC',
      volume: 'volume DESC',
      nome: 'name COLLATE NOCASE ASC'
    };
    const order = ORDENS[opts.sort] || ORDENS.vendas;
    const filtro = where.join(' AND ');

    // Passo 1: agregação pura. `ultima_venda_ms` sai de `MAX(sold_at_ms)`, o
    // que permite ordenar por "vendidos agora" sem precisar da linha inteira.
    const sqlAg = `
      SELECT def_id,
             MAX(name)                                AS name,
             MAX(category)                            AS category,
             MAX(rarity)                              AS rarity,
             MAX(currency)                            AS currency,
             MAX(kind)                                AS kind,
             COUNT(*)                                 AS vendas,
             SUM(quantity)                            AS unidades,
             SUM(total)                               AS volume,
             -- Média, mínimo e máximo só das vendas em OURO. Misturar as duas
             -- moedas produzia um número que não existe: 50 000 de ouro e 80
             -- de diamante na mesma média não descrevem preço nenhum.
             COUNT(CASE WHEN ${SQL_OURO} THEN 1 END)  AS vendas_ouro,
             CAST(SUM(CASE WHEN ${SQL_OURO} THEN unit_price * quantity END) AS REAL)
               / NULLIF(SUM(CASE WHEN ${SQL_OURO} THEN quantity END), 0) AS media,
             MIN(CASE WHEN ${SQL_OURO} THEN unit_price END) AS minimo,
             MAX(CASE WHEN ${SQL_OURO} THEN unit_price END) AS maximo,
             -- E o espelho em DIAMANTE, que é moeda de verdade no jogo e tem
             -- ordem de grandeza própria.
             COUNT(CASE WHEN ${SQL_DIAMANTE} THEN 1 END) AS vendas_dia,
             SUM(CASE WHEN ${SQL_DIAMANTE} THEN quantity END) AS unidades_dia,
             CAST(SUM(CASE WHEN ${SQL_DIAMANTE} THEN unit_price * quantity END) AS REAL)
               / NULLIF(SUM(CASE WHEN ${SQL_DIAMANTE} THEN quantity END), 0) AS media_dia,
             MIN(CASE WHEN ${SQL_DIAMANTE} THEN unit_price END) AS minimo_dia,
             MAX(CASE WHEN ${SQL_DIAMANTE} THEN unit_price END) AS maximo_dia,
             MIN(sold_at_ms)                          AS primeira_venda_ms,
             MAX(sold_at_ms)                          AS ultima_venda_ms
      FROM sales WHERE ${filtro}
      GROUP BY def_id
      ORDER BY ${order}
      LIMIT ? OFFSET ?
    `;

    try {
      const items = this.db.prepare(sqlAg).all(...params, limit, offset);

      // Passo 2: mediana e último preço, só para os itens desta página. O
      // índice `(def_id, sold_at_ms DESC)` faz cada um custar um salto, e são
      // no máximo `limit` deles — não as 150 mil linhas do banco.
      if (items.length) {
        // Um statement por item, reaproveitado. A versão com `def_id IN (...)`
        // e função de janela parecia mais esperta mas era três vezes mais
        // lenta (medido: 922 ms contra 368 ms em 150 itens): o `PARTITION BY`
        // obriga o SQLite a materializar e reordenar tudo numa B-tree
        // temporária, enquanto a consulta por item só percorre o índice.
        // Uma mediana por moeda. O mesmo recorte de `LIMIT/OFFSET` com o
        // filtro de moeda trocado: juntar as duas daria o preço do meio de
        // uma lista que mistura milhares de ouro com dezenas de diamante.
        const medianaDe = cond => this.db.prepare(`
          SELECT AVG(unit_price) AS mediana FROM (
            SELECT unit_price FROM sales
            WHERE def_id = ?1 AND sold_at_ms >= ?2 AND ${cond}
            ORDER BY unit_price
            LIMIT 2 - (SELECT COUNT(*) FROM sales
                       WHERE def_id = ?1 AND sold_at_ms >= ?2 AND ${cond}) % 2
            OFFSET (SELECT (COUNT(*) - 1) / 2 FROM sales
                    WHERE def_id = ?1 AND sold_at_ms >= ?2 AND ${cond})
          )
        `);
        const stMediana = medianaDe(SQL_OURO);
        const stMedianaDia = medianaDe(SQL_DIAMANTE);
        const ultimoDe = cond => this.db.prepare(`
          SELECT unit_price AS ultimo_preco, enchant AS ultimo_enchant,
                 rarity, kind, currency, sold_at_ms
          FROM sales WHERE def_id = ? AND sold_at_ms >= ? AND ${cond}
          ORDER BY sold_at_ms DESC, id DESC LIMIT 1
        `);
        const stUltimo = ultimoDe(SQL_OURO);
        const stUltimoDia = ultimoDe(SQL_DIAMANTE);

        for (const item of items) {
          const m = stMediana.get(item.def_id, since);
          item.mediana = (m && m.mediana) || 0;
          const u = stUltimo.get(item.def_id, since);
          if (u) {
            item.ultimo_preco = u.ultimo_preco;
            item.ultimo_enchant = u.ultimo_enchant;
            // A raridade da venda mais recente vale mais que `MAX(rarity)`,
            // que escolheria por ordem alfabética e não por relevância.
            if (u.rarity) item.rarity = u.rarity;
          }
          // Diamante só aparece quando houve venda em diamante: zerar daria a
          // impressão de que o item vale nada nessa moeda, quando o certo é
          // que ele nunca foi vendido nela.
          if (item.vendas_dia) {
            const md = stMedianaDia.get(item.def_id, since);
            item.mediana_dia = (md && md.mediana) || 0;
            const ud = stUltimoDia.get(item.def_id, since);
            if (ud) item.ultimo_preco_dia = ud.ultimo_preco;
          }
        }
      }

      const total = this.db
        .prepare(`SELECT COUNT(DISTINCT def_id) AS n FROM sales WHERE ${filtro}`)
        .get(...params);
      const res = { items, total: (total && total.n) || 0 };
      this.cache.set(chave, res);
      return res;
    } catch (err) {
      this.error = err && err.message || String(err);
      return { items: [], total: 0, error: this.error };
    }
  }

  /** As vendas mais recentes, cruas — o feed que a aba "Ao vivo" mostra. */
  recent(opts = {}) {
    if (!this.open()) return [];
    const limit = Math.min(Math.max(num(opts.limit) || 100, 1), 1000);
    const where = [];
    const params = [];
    if (opts.defId) { where.push('def_id = ?'); params.push(String(opts.defId)); }
    if (opts.category && opts.category !== 'todos') {
      where.push('category = ?'); params.push(String(opts.category));
    }
    if (opts.search) {
      where.push('(name LIKE ? COLLATE NOCASE OR def_id LIKE ? COLLATE NOCASE)');
      const like = `%${String(opts.search)}%`;
      params.push(like, like);
    }
    const since = sinceOf(opts.days);
    if (since) { where.push('sold_at_ms >= ?'); params.push(since); }
    const filtro = where.length ? `WHERE ${where.join(' AND ')}` : '';
    try {
      return this.db
        .prepare(`SELECT * FROM sales ${filtro} ORDER BY sold_at_ms DESC, id DESC LIMIT ?`)
        .all(...params, limit);
    } catch (err) {
      this.error = err && err.message || String(err);
      return [];
    }
  }

  /**
   * Um item em detalhe: as vendas recentes dele e a série diária de preço
   * médio, que é o que permite ver tendência em vez de um número solto.
   */
  itemDetail(defId, opts = {}) {
    if (!this.open() || !defId) return null;
    const since = sinceOf(opts.days);
    const id = String(defId);
    try {
      const resumo = this.db.prepare(`
        SELECT def_id,
               MAX(name) AS name, MAX(category) AS category, MAX(rarity) AS rarity,
               COUNT(*) AS vendas, SUM(quantity) AS unidades, SUM(total) AS volume,
               COUNT(CASE WHEN ${SQL_OURO} THEN 1 END) AS vendas_ouro,
               CAST(SUM(CASE WHEN ${SQL_OURO} THEN unit_price * quantity END) AS REAL)
                 / NULLIF(SUM(CASE WHEN ${SQL_OURO} THEN quantity END), 0) AS media,
               MIN(CASE WHEN ${SQL_OURO} THEN unit_price END) AS minimo,
               MAX(CASE WHEN ${SQL_OURO} THEN unit_price END) AS maximo,
               COUNT(CASE WHEN ${SQL_DIAMANTE} THEN 1 END) AS vendas_dia,
               SUM(CASE WHEN ${SQL_DIAMANTE} THEN quantity END) AS unidades_dia,
               CAST(SUM(CASE WHEN ${SQL_DIAMANTE} THEN unit_price * quantity END) AS REAL)
                 / NULLIF(SUM(CASE WHEN ${SQL_DIAMANTE} THEN quantity END), 0) AS media_dia,
               MIN(CASE WHEN ${SQL_DIAMANTE} THEN unit_price END) AS minimo_dia,
               MAX(CASE WHEN ${SQL_DIAMANTE} THEN unit_price END) AS maximo_dia,
               MIN(sold_at_ms) AS primeira_venda_ms, MAX(sold_at_ms) AS ultima_venda_ms
        FROM sales WHERE def_id = ? AND sold_at_ms >= ?
      `).get(id, since);

      if (!resumo || !resumo.vendas) return null;

      // Uma mediana por moeda, pelo mesmo motivo do resumo: o preço do meio de
      // uma lista que mistura ouro e diamante não é preço de nada.
      const medianaDe = cond => this.db.prepare(`
        WITH r AS (
          SELECT unit_price,
                 ROW_NUMBER() OVER (ORDER BY unit_price) AS rn,
                 COUNT(*)     OVER ()                    AS c
          FROM sales WHERE def_id = ? AND sold_at_ms >= ? AND ${cond}
        )
        SELECT AVG(unit_price) AS mediana FROM r WHERE rn IN ((c + 1) / 2, (c + 2) / 2)
      `).get(id, since);
      const mediana = medianaDe(SQL_OURO);
      const medianaDia = resumo.vendas_dia ? medianaDe(SQL_DIAMANTE) : null;

      // Dias em UTC: o agrupamento tem de ser estável entre execuções, e o
      // fuso local do usuário não é.
      // O gráfico mostra uma moeda só. Ouro quando existe, diamante quando o
      // item só foi vendido em diamante: uma linha que alterna entre as duas
      // escalas pareceria um colapso de preço que nunca aconteceu.
      const moedaSerie = resumo.vendas_ouro ? SQL_OURO : SQL_DIAMANTE;
      const serie = this.db.prepare(`
        SELECT CAST(sold_at_ms / 86400000 AS INTEGER) * 86400000 AS dia_ms,
               COUNT(*) AS vendas, SUM(quantity) AS unidades,
               CAST(SUM(unit_price * quantity) AS REAL) / NULLIF(SUM(quantity), 0) AS media,
               MIN(unit_price) AS minimo, MAX(unit_price) AS maximo
        FROM sales WHERE def_id = ? AND sold_at_ms >= ? AND ${moedaSerie}
        GROUP BY dia_ms ORDER BY dia_ms ASC
      `).all(id, since);

      const vendas = this.db.prepare(`
        SELECT * FROM sales WHERE def_id = ? AND sold_at_ms >= ?
        ORDER BY sold_at_ms DESC, id DESC LIMIT ?
      `).all(id, since, Math.min(Math.max(num(opts.limit) || 100, 1), 1000));

      return {
        ...resumo,
        mediana: (mediana && mediana.mediana) || 0,
        mediana_dia: (medianaDia && medianaDia.mediana) || 0,
        series: serie,
        series_currency: resumo.vendas_ouro ? 'gold' : 'diamond',
        sales: vendas
      };
    } catch (err) {
      this.error = err && err.message || String(err);
      return null;
    }
  }

  /** Saúde do banco: quanto já foi acumulado e desde quando. */
  stats() {
    if (!this.open()) return { ready: false, error: this.error };
    try {
      const g = this.db.prepare(`
        SELECT COUNT(*) AS vendas, COUNT(DISTINCT def_id) AS itens,
               MIN(sold_at_ms) AS desde_ms, MAX(sold_at_ms) AS ate_ms
        FROM sales
      `).get();
      let bytes = 0;
      if (this.file !== ':memory:') {
        try { bytes = fs.statSync(this.file).size; } catch {}
      }
      return { ready: true, file: this.file, bytes, ...g };
    } catch (err) {
      return { ready: false, error: err && err.message || String(err) };
    }
  }

  /** Categorias realmente presentes, para preencher o filtro sem chutar. */
  categories() {
    if (!this.open()) return [];
    try {
      return this.db
        .prepare('SELECT DISTINCT category FROM sales WHERE category <> \'\' ORDER BY category')
        .all()
        .map(r => r.category);
    } catch { return []; }
  }
}

let instancia = null;

/** Banco único do processo principal. */
function getMarketDb(file) {
  if (!instancia) instancia = new MarketDatabase(file);
  return instancia;
}

module.exports = {
  MarketDatabase,
  getMarketDb,
  normalizeSale,
  DB_FILE,
  CAMBIO_PREFIX,
  CURRENCY_DIAMOND
};

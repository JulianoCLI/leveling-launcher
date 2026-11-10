/**
 * @file leveling-proxy-pool.js
 * Pool de proxies com limite de 2 contas por proxy.
 *
 * O servidor rejeita múltiplas contas do mesmo IP com erro `session.multi_account_ip`.
 * Este módulo gerencia um inventário de proxies, valida-os, e atribui até 2 contas
 * por proxy. Proxies são um recurso compartilhado e escasso, não um campo por conta.
 */

'use strict';

/*
 * As duas funções de proxy vivem em `leveling-credentials`, que por sua vez
 * carrega este arquivo — e é por isso que o `require` acontece na chamada, e
 * não no topo. No topo o ciclo se resolve com o módulo ainda pela metade: os
 * nomes chegam `undefined` e o Node avisa "Accessing non-existent property ...
 * inside circular dependency". Aqui a importação só roda quando alguém importa
 * um proxy, momento em que os dois módulos já terminaram de carregar.
 */
const proxyUtils = () => require('./leveling-credentials');

const CAPACITY_PER_PROXY = 2;
const DEFAULT_PROXY_CHECK_TIMEOUT_MS = 8000;

/**
 * Um proxy com seu histórico de validação.
 * @typedef {Object} ProxyEntry
 * @property {string} id - UUID ou hash; gerado na importação
 * @property {string} url - URL normalizada (http://... ou socks5://...)
 * @property {string} label - Descrição para exibir (senha mascarada)
 * @property {string} status - 'pending' | 'ok' | 'fail' | 'duplicate'
 * @property {string} ip - IP público visto via ipify.org, ou ''
 * @property {number} checkedAt - timestamp do último teste, ou 0
 * @property {string} error - Mensagem de erro do último teste, ou ''
 */

class LevelingProxyPool {
  constructor() {
    /** @type {ProxyEntry[]} */
    this.proxies = [];

    /** @type {Map<number, string>} accountIndex -> proxyId */
    this.assignments = new Map();

    /** Por IP: detecta duplicatas. */
    this.ipToProxyIds = new Map();
  }

  /**
   * Importa proxies a partir de um texto.
   * Aceita:
   *   - host:porta
   *   - host:porta:usuario:senha
   *   - URL completa (http://..., socks5://...)
   * Uma linha por proxy. Linhas vazias e comentários (#...) são ignorados.
   *
   * Deduplica por URL normalizada. Retorna { added, duplicates, invalid }.
   */
  importText(text) {
    const lines = (text || '').split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
    const added = [];
    const duplicates = [];
    const invalid = [];
    const { normalizeProxy, describeProxy } = proxyUtils();

    for (const line of lines) {
      try {
        const url = normalizeProxy(line);
        if (!url) {
          invalid.push(line);
          continue;
        }

        const id = hashUrl(url);
        if (this.proxies.some(p => p.id === id)) {
          duplicates.push(describeProxy(url));
          continue;
        }

        this.proxies.push({
          id,
          url,
          label: describeProxy(url),
          status: 'pending',
          ip: '',
          checkedAt: 0,
          error: ''
        });
        added.push(id);
      } catch (e) {
        invalid.push(line);
      }
    }

    return { added, duplicates, invalid };
  }

  /**
   * Gera um UUID simples ou usa hash da URL.
   * @private
   */
  generateId() {
    return 'px_' + Math.random().toString(36).substr(2, 9) + '_' + Date.now();
  }

  /**
   * Atribui um proxy a uma conta. Escolhe o primeiro proxy com vaga.
   * Retorna { proxyId, url } ou null se esgotado.
   *
   * Só proxies com status `ok` entram, isto é, os que *passaram* por um teste.
   * Antes `pending` também servia, e era o furo que fazia uma conta sair pelo
   * IP da máquina: um proxy recém-importado e nunca testado era atribuído como
   * se fosse bom, e a conta ou saía pelo IP local ou nem conectava.
   *
   * Ficar sem rota é o resultado correto aqui. Quem chama decide o que fazer, e
   * a decisão do launcher é não abrir a conta — não abri-la sem proxy.
   */
  assign(accountIndex) {
    if (this.assignments.has(accountIndex)) {
      return { proxyId: this.assignments.get(accountIndex), url: this.getProxyUrl(this.assignments.get(accountIndex)) };
    }

    for (const proxy of this.proxies) {
      if (proxy.status !== 'ok') continue;
      const count = Array.from(this.assignments.values()).filter(id => id === proxy.id).length;
      if (count < CAPACITY_PER_PROXY) {
        this.assignments.set(accountIndex, proxy.id);
        return { proxyId: proxy.id, url: proxy.url };
      }
    }

    return null;
  }

  /**
   * Quantas contas podem sair pelo IP da máquina sem o servidor reclamar.
   *
   * O servidor recusa duas contas no mesmo endereço (`session.multi_account_ip`),
   * e o IP local é um endereço como qualquer outro: ele comporta o mesmo que um
   * proxy comporta. Daí o número ser o mesmo `CAPACITY_PER_PROXY`.
   */
  static get LOCAL_IP_CAPACITY() {
    return CAPACITY_PER_PROXY;
  }

  /**
   * A conta pode abrir? Devolve `{ ok, motivo }`.
   *
   * As duas primeiras contas saem pelo IP da máquina, porque é o que o servidor
   * tolera. Da terceira em diante, sem proxy atribuído a conta não abre: deixá-la
   * abrir seria escolher entre `session.multi_account_ip` e, pior, duas contas
   * saindo pelo mesmo endereço sem ninguém perceber.
   */
  canOpen(accountIndex) {
    const i = Number(accountIndex);
    if (!Number.isInteger(i) || i < 0) return { ok: false, motivo: 'conta inválida' };

    const proxyId = this.assignments.get(i);
    if (proxyId) {
      const proxy = this.proxies.find(p => p.id === proxyId);
      if (!proxy) return { ok: false, motivo: 'o proxy atribuído não existe mais' };
      if (proxy.status !== 'ok') {
        return { ok: false, motivo: `o proxy ${proxy.label} não passou no teste (${proxy.status})` };
      }
      return { ok: true, motivo: '' };
    }

    if (i < LevelingProxyPool.LOCAL_IP_CAPACITY) return { ok: true, motivo: '' };

    return {
      ok: false,
      motivo: 'sem proxy funcional no pool; só as duas primeiras contas podem sair pelo IP da máquina'
    };
  }

  /**
   * Dá rota às contas que existem e ainda não têm uma.
   *
   * `assign` só era chamado no cadastro assistido, então quem já tinha conta
   * antes do pool existir ficava sem atribuição — e, com o portão novo, sem
   * poder abrir, mesmo com dezenas de proxies aprovados parados no inventário.
   * Esta função fecha essa lacuna, e é idempotente: conta com rota é ignorada.
   *
   * As duas primeiras ficam de fora de propósito: elas saem pelo IP da máquina,
   * que é o que o servidor tolera, e gastar proxy nelas seria desperdiçar vaga.
   *
   * @param {number[]} indices Índices das contas que existem.
   * @returns {{assigned: number[], unassigned: number[]}}
   */
  reconcile(indices) {
    const lista = Array.isArray(indices) ? indices : [];
    const assigned = [];
    const unassigned = [];

    for (const raw of lista) {
      const i = Number(raw);
      if (!Number.isInteger(i) || i < 0) continue;
      if (this.assignments.has(i)) continue;
      if (i < LevelingProxyPool.LOCAL_IP_CAPACITY) continue;

      if (this.assign(i)) assigned.push(i);
      else unassigned.push(i);
    }

    return { assigned, unassigned };
  }

  /** A rota pela qual a conta sai, já pronta para mostrar na tela. */
  describeRoute(accountIndex) {
    const i = Number(accountIndex);
    const proxyId = this.assignments.get(i);
    if (proxyId) {
      const proxy = this.proxies.find(p => p.id === proxyId);
      if (proxy) {
        return {
          kind: 'proxy',
          label: proxy.label,
          ip: proxy.ip || '',
          status: proxy.status,
          ok: proxy.status === 'ok'
        };
      }
    }
    const local = i >= 0 && i < LevelingProxyPool.LOCAL_IP_CAPACITY;
    return {
      kind: local ? 'local' : 'none',
      label: local ? 'meu IP' : 'sem rota',
      ip: '',
      status: local ? 'ok' : 'missing',
      ok: local
    };
  }

  /**
   * Desatribui uma conta do proxy.
   */
  release(accountIndex) {
    this.assignments.delete(accountIndex);
  }

  /**
   * Remove um proxy e desatribui todas as contas que o usam.
   */
  remove(proxyId) {
    this.proxies = this.proxies.filter(p => p.id !== proxyId);
    if (this.ipToProxyIds.has(proxyId)) {
      this.ipToProxyIds.delete(proxyId);
    }
    for (const [account, id] of Array.from(this.assignments.entries())) {
      if (id === proxyId) this.assignments.delete(account);
    }
  }

  /**
   * Marca um proxy como testado. Atualiza status, IP e detecta duplicatas.
   */
  setProxyStatus(proxyId, status, ip, error) {
    const proxy = this.proxies.find(p => p.id === proxyId);
    if (!proxy) return;

    proxy.status = status;
    proxy.error = error || '';
    proxy.checkedAt = Date.now();

    if (status === 'ok' && ip) {
      proxy.ip = ip;

      // Detecta IPs duplicados: se outro proxy tem o mesmo IP, marca ambos como duplicata.
      const others = this.proxies.filter(p => p.id !== proxyId && p.ip === ip);
      if (others.length > 0) {
        proxy.status = 'duplicate';
        others.forEach(o => { if (o.status === 'ok') o.status = 'duplicate'; });
      }
    }
  }

  /**
   * Obtém a URL de um proxy por ID.
   */
  getProxyUrl(proxyId) {
    const proxy = this.proxies.find(p => p.id === proxyId);
    return proxy ? proxy.url : '';
  }

  /**
   * Retorna todos os proxies.
   */
  getAll() {
    return this.proxies.map(p => ({ ...p }));
  }

  /**
   * Retorna o estado public-safe de um proxy (sem a URL completa com senha).
   */
  getPublicProxy(proxyId) {
    const proxy = this.proxies.find(p => p.id === proxyId);
    if (!proxy) return null;
    return {
      id: proxy.id,
      label: proxy.label,
      status: proxy.status,
      ip: proxy.ip,
      checkedAt: proxy.checkedAt,
      error: proxy.error,
      assignedCount: Array.from(this.assignments.values()).filter(id => id === proxyId).length
    };
  }

  /**
   * Vagas livres no pool.
   */
  freeSlots() {
    const total = this.proxies.length * CAPACITY_PER_PROXY;
    const used = this.assignments.size;
    return Math.max(0, total - used);
  }

  /**
   * Proxies necessários para N contas, assumindo melhor caso (2 por proxy).
   */
  needed(accountCount) {
    return Math.ceil(accountCount / CAPACITY_PER_PROXY);
  }

  /**
   * Retorna capacidade total e usada.
   */
  capacity() {
    const total = this.proxies.length * CAPACITY_PER_PROXY;
    const used = this.assignments.size;
    return { total, used, free: Math.max(0, total - used) };
  }

  /**
   * Serializa para persistência.
   */
  toJSON() {
    return {
      proxies: this.proxies.map(p => ({ ...p })),
      assignments: Array.from(this.assignments.entries())
    };
  }

  /**
   * Desserializa a partir de um save anterior.
   */
  static fromJSON(data) {
    const pool = new LevelingProxyPool();
    if (data && Array.isArray(data.proxies)) {
      pool.proxies = data.proxies.map(p => ({ ...p }));
    }
    if (data && Array.isArray(data.assignments)) {
      pool.assignments = new Map(data.assignments);
    }
    return pool;
  }
}

function hashUrl(url) {
  try {
    const u = new URL(url);
    // Normaliza: remove trailing slash, ignora query/fragment
    const key = u.protocol + '//' + (u.username ? u.username + '@' : '') + u.host + u.pathname;
    return 'px_' + hashString(key);
  } catch {
    return 'px_' + hashString(String(url));
  }
}

function hashString(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h) + s.charCodeAt(i);
    h = h & h; // Converte para 32-bit int
  }
  return Math.abs(h).toString(36);
}

const levelingProxyPool = new LevelingProxyPool();

module.exports = {
  LevelingProxyPool,
  levelingProxyPool,
  CAPACITY_PER_PROXY,
  DEFAULT_PROXY_CHECK_TIMEOUT_MS
};

/**
 * @file leveling-credentials.js
 * Guarda as credenciais e os tokens de sessão do Leveling Idle 2D.
 *
 * Mesmo esquema já usado pelas contas da Kick: um arquivo em `userData`
 * cifrado com `safeStorage` (DPAPI no Windows). O token de sessão vive junto,
 * porque reconectar por `resume` evita o limite de tentativas de login.
 */

'use strict';

const fs = require('fs');
const path = require('path');

let electronApp = null;
let electronSafeStorage = null;
try {
  const electron = require('electron');
  electronApp = electron.app || null;
  electronSafeStorage = electron.safeStorage || null;
} catch {
  // Fora do Electron (testes, ferramentas): grava em claro no diretório atual.
}

/**
 * Capacidade inicial, não teto: o launcher cresce em abas de quatro contas e
 * chama `ensureCapacity()` conforme o usuário adiciona abas.
 */
const MAX_ACCOUNTS = 4;
const FILE_NAME = 'leveling_creds.enc';

/**
 * `proxy` fica aqui junto das credenciais porque é parte de como a conta entra:
 * o servidor recusa várias contas no mesmo IP (`session.multi_account_ip`), e
 * trocar o proxy sem trocar a conta não faz sentido.
 */
function emptyAccount() {
  return { username: '', password: '', token: '', proxy: '' };
}

/**
 * Aceita a forma curta que os provedores de proxy entregam (`host:porta` ou
 * `host:porta:usuario:senha`) e devolve uma URL, que é o que tanto o Chromium
 * quanto o `undici` esperam. Sem esquema, assume HTTP: é o caso comum.
 */
function normalizeProxy(input) {
  const raw = String(input || '').trim();
  if (!raw) return '';
  if (/^[a-z0-9+.-]+:\/\//i.test(raw)) return raw;

  const parts = raw.split(':');
  if (parts.length === 2) return `http://${parts[0]}:${parts[1]}`;
  if (parts.length === 4) {
    const [host, port, user, pass] = parts;
    return `http://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}:${port}`;
  }
  return 'http://' + raw;
}

/** Visão do proxy sem a senha, para mostrar na interface. */
function describeProxy(proxy) {
  if (!proxy) return '';
  try {
    const url = new URL(proxy);
    const user = url.username ? decodeURIComponent(url.username) + '@' : '';
    return `${url.protocol.replace(':', '')}://${user}${url.host}`;
  } catch {
    return proxy;
  }
}

class LevelingCredentialStore {
  constructor(options = {}) {
    this.filePath = options.filePath || null;
    this.maxAccounts = options.maxAccounts || MAX_ACCOUNTS;
    this.safeStorage = options.safeStorage !== undefined ? options.safeStorage : electronSafeStorage;
    this.cache = null;
  }

  getFilePath() {
    if (this.filePath) return this.filePath;
    const baseDir = electronApp ? electronApp.getPath('userData') : process.cwd();
    return path.join(baseDir, FILE_NAME);
  }

  canEncrypt() {
    try {
      return !!(this.safeStorage && this.safeStorage.isEncryptionAvailable());
    } catch {
      return false;
    }
  }

  load() {
    if (this.cache) return this.cache;

    const accounts = Array.from({ length: this.maxAccounts }, emptyAccount);
    const file = this.getFilePath();

    try {
      if (fs.existsSync(file)) {
        const raw = fs.readFileSync(file);
        let json = '';
        if (this.canEncrypt()) {
          try {
            json = this.safeStorage.decryptString(raw);
          } catch {
            // Arquivo antigo em claro, ou cifrado por outro usuário do Windows.
            json = raw.toString('utf-8');
          }
        } else {
          json = raw.toString('utf-8');
        }
        const parsed = JSON.parse(json);
        if (Array.isArray(parsed.accounts)) {
          // O arquivo manda no tamanho: quem já tinha oito contas salvas não
          // pode perder quatro só porque o padrão em memória é quatro.
          if (parsed.accounts.length > this.maxAccounts) this.maxAccounts = parsed.accounts.length;
          while (accounts.length < this.maxAccounts) accounts.push(emptyAccount());
          parsed.accounts.forEach((acc, i) => {
            accounts[i] = {
              username: acc.username || '',
              password: acc.password || '',
              token: acc.token || '',
              proxy: acc.proxy || ''
            };
          });
        }
      }
    } catch {
      // Arquivo corrompido não deve impedir o launcher de abrir.
    }

    this.cache = { accounts };
    return this.cache;
  }

  save(data) {
    const accounts = Array.from({ length: this.maxAccounts }, (_, i) => {
      const acc = (data && data.accounts && data.accounts[i]) || {};
      return {
        username: acc.username || '',
        password: acc.password || '',
        token: acc.token || '',
        proxy: acc.proxy || ''
      };
    });

    const json = JSON.stringify({ accounts });
    const file = this.getFilePath();
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, this.canEncrypt()
        ? this.safeStorage.encryptString(json)
        : Buffer.from(json, 'utf-8'));
      this.cache = { accounts };
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Cresce o número de slots quando o usuário abre mais uma aba. Só cresce:
   * encolher aqui apagaria do disco credenciais de contas que voltariam a
   * aparecer assim que a aba fosse recriada.
   */
  ensureCapacity(total) {
    const wanted = Math.max(0, +total || 0);
    if (wanted <= this.maxAccounts) return this.maxAccounts;
    const data = this.load();
    while (data.accounts.length < wanted) data.accounts.push(emptyAccount());
    this.maxAccounts = wanted;
    this.save(data);
    return this.maxAccounts;
  }

  get(index) {
    const { accounts } = this.load();
    return accounts[index] ? { ...accounts[index] } : emptyAccount();
  }

  /** Grava usuário e senha, descartando o token: ele pertence ao login antigo. */
  setCredentials(index, username, password) {
    if (index < 0 || index >= this.maxAccounts) return false;
    const data = this.load();
    const acc = data.accounts[index] || emptyAccount();
    data.accounts[index] = {
      username: username || '',
      password: password || '',
      token: '',
      // O proxy descreve a rota, não a conta: trocar a senha não a muda.
      proxy: acc.proxy || ''
    };
    return this.save(data);
  }

  /**
   * Define a rota de saída da conta. Aceita `http://`, `https://`, `socks5://`
   * (com credenciais na URL, se o provedor pedir) ou vazio para o IP local.
   */
  setProxy(index, proxy) {
    if (index < 0 || index >= this.maxAccounts) return false;
    const data = this.load();
    const acc = data.accounts[index] || emptyAccount();
    data.accounts[index] = { ...acc, proxy: normalizeProxy(proxy) };
    return this.save(data);
  }

  /** Atualiza só o token de sessão, preservando as credenciais. */
  setToken(index, token) {
    if (index < 0 || index >= this.maxAccounts) return false;
    const data = this.load();
    const acc = data.accounts[index] || emptyAccount();
    if (acc.token === (token || '')) return true;
    data.accounts[index] = { ...acc, token: token || '' };
    return this.save(data);
  }

  /** Apaga a conta e mantém o proxy: o slot costuma receber outra conta na mesma rota. */
  clear(index) {
    return this.setCredentials(index, '', '');
  }

  /** Visão sem segredos, segura para mandar ao renderizador. */
  getPublicStatus() {
    const { accounts } = this.load();
    return {
      encrypted: this.canEncrypt(),
      accounts: accounts.map(acc => ({
        username: acc.username,
        hasPassword: !!acc.password,
        hasToken: !!acc.token,
        proxy: describeProxy(acc.proxy)
      }))
    };
  }
}

const levelingCredentials = new LevelingCredentialStore();

module.exports = {
  LevelingCredentialStore,
  levelingCredentials,
  MAX_ACCOUNTS,
  normalizeProxy,
  describeProxy
};

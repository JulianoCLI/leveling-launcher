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
const { LevelingProxyPool } = require('./leveling-proxy-pool');

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
 *
 * `email` e `signup` existem por causa do assistente de cadastro. O cadastro
 * exige email, e o token do Cloudflare Turnstile só nasce dentro da WebView —
 * então o launcher guarda a credencial *antes* de a conta existir e a WebView
 * preenche o formulário com ela. `signup` marca justamente esse intervalo: uma
 * credencial que ainda não passou pelo captcha não serve ao monitor, e sem a
 * marca ele tentaria logar numa conta inexistente.
 */
function emptyAccount() {
  // `classId` acompanha `signup`: é a classe que o assistente escolheu, e a
  // WebView a usa para marcar o cartão no modal que o jogo abre na conta nova.
  return { username: '', password: '', token: '', proxy: '', email: '', signup: false, classId: '' };
}

/**
 * Aceita a forma curta que os provedores de proxy entregam (`host:porta` ou
 * `host:porta:usuario:senha`) e devolve uma URL, que é o que tanto o Chromium
 * quanto o `undici` esperam. Sem esquema, assume HTTP: é o caso comum.
 *
 * Devolve `''` para o que não dá para converter com segurança. Antes o ramo
 * final era `'http://' + raw`, que transformava qualquer lixo numa string com
 * cara de URL: `host:porta:usuario` virava `http://host:porta:usuario`, que
 * passa por aqui sem reclamar e só estoura lá no fim, dentro do `undici`, como
 * `Invalid URL` — longe de quem digitou e sem dizer o quê. Vazio é recusa
 * honesta: `importText` já separa as linhas inválidas e as mostra ao usuário.
 */
function normalizeProxy(input) {
  const raw = String(input || '').trim();
  if (!raw) return '';

  const comEsquema = /^[a-z0-9+.-]+:\/\//i.test(raw) ? raw : (() => {
    const parts = raw.split(':');
    if (parts.length === 2) return `http://${parts[0]}:${parts[1]}`;
    if (parts.length === 4) {
      const [host, port, user, pass] = parts;
      return `http://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}:${port}`;
    }
    // Um pedaço só pode ser um host sem porta, que é uma rota utilizável.
    if (parts.length === 1) return `http://${raw}`;
    return '';
  })();

  if (!comEsquema) return '';

  // A última palavra é do mesmo parser que vai consumir isto depois. Validar
  // com outra regra significaria aprovar aqui o que falha adiante, que é
  // precisamente o defeito que esta função existe para não ter.
  try {
    const url = new URL(comEsquema);
    if (!url.hostname) return '';
    return comEsquema;
  } catch {
    return '';
  }
}

/**
 * Marca da senha omitida na visão do proxy.
 *
 * Existe para a tela poder **mostrar** que há senha sem revelá-la. Antes a
 * senha era simplesmente apagada, e o efeito era pior que o segredo exposto:
 * uma rota correta e uma rota sem senha ficavam idênticas na tela, e reenviar
 * o que estava à vista gravava um proxy quebrado — que o servidor recusa antes
 * de qualquer login, sem código de erro que explique.
 */
const PROXY_SECRET_MASK = '\u2022\u2022\u2022';

/** O texto veio da tela com a senha mascarada, em vez de uma senha de verdade? */
function isMaskedProxy(input) {
  return String(input || '').includes(PROXY_SECRET_MASK);
}

/** A URL tem usuário mas não tem senha? Quase sempre é colagem incompleta. */
function proxyMissingPassword(proxy) {
  if (!proxy) return false;
  try {
    const url = new URL(proxy);
    return !!url.username && !url.password;
  } catch {
    return false;
  }
}

/** Visão do proxy com a senha mascarada, para mostrar na interface. */
function describeProxy(proxy) {
  if (!proxy) return '';
  try {
    const url = new URL(proxy);
    if (!url.username) return `${url.protocol.replace(':', '')}://${url.host}`;
    const user = decodeURIComponent(url.username);
    // A senha vira marca, não some: é a diferença entre "tem senha" e "não
    // tem", que é justamente o que distingue a rota boa da quebrada.
    const secret = url.password ? ':' + PROXY_SECRET_MASK : '';
    return `${url.protocol.replace(':', '')}://${user}${secret}@${url.host}`;
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
    let proxyPool = new LevelingProxyPool();

    // O `sniper` sai do mesmo JSON das contas, então é lido no mesmo passo.
    // Reabrir o arquivo depois era o defeito: a segunda leitura o tratava como
    // UTF-8 puro e, num arquivo cifrado, estourava sempre — a conta do sniper
    // nunca carregava, mesmo estando salva.
    let sniper = emptyAccount();

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
        if (parsed.sniper) sniper = { ...emptyAccount(), ...parsed.sniper };
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
              proxy: acc.proxy || '',
              email: acc.email || '',
              // Arquivo anterior ao assistente não tem o campo: a conta já
              // existe, senão não teria sido gravada à mão.
              signup: acc.signup === true,
              classId: acc.classId || ''
            };
          });
        }
        // Carrega o pool de proxies do arquivo, ou migra proxies legados se houver.
        if (parsed.proxyPool) {
          proxyPool = LevelingProxyPool.fromJSON(parsed.proxyPool);
        } else {
          // Migração: se há proxies legados no formato antigo, importa para o pool.
          this._migrateProxiesToPool(accounts, proxyPool);
        }
      }
    } catch {
      // Arquivo corrompido não deve impedir o launcher de abrir.
    }

    this.cache = { accounts, sniper, proxyPool };
    return this.cache;
  }

  /** Migra proxies antigos (um por conta) para o novo pool (compartilhado). */
  _migrateProxiesToPool(accounts, pool) {
    const proxies = accounts
      .map((acc, i) => acc.proxy)
      .filter((p, i, arr) => p && arr.indexOf(p) === i); // Deduplica
    
    if (proxies.length > 0) {
      pool.importText(proxies.join('\n'));
      // Grava status ok por padrão (para não bloquear), virá testado depois.
      for (const proxy of pool.proxies) {
        proxy.status = 'pending';
      }
      // Atribui as contas aos proxies do pool.
      for (let i = 0; i < accounts.length; i++) {
        if (accounts[i].proxy) {
          const proxyUrl = accounts[i].proxy;
          const proxyEntry = pool.proxies.find(p => p.url === proxyUrl);
          if (proxyEntry) {
            pool.assignments.set(i, proxyEntry.id);
          }
        }
      }
    }
  }

  save(data) {
    const accounts = Array.from({ length: this.maxAccounts }, (_, i) => {
      const acc = (data && data.accounts && data.accounts[i]) || {};
      return {
        username: acc.username || '',
        password: acc.password || '',
        token: acc.token || '',
        proxy: acc.proxy || '',
        email: acc.email || '',
        signup: acc.signup === true,
        classId: acc.classId || ''
      };
    });

    const proxyPool = (data && data.proxyPool) || new LevelingProxyPool();
    const json = JSON.stringify({
      accounts,
      sniper: (data && data.sniper) || emptyAccount(),
      proxyPool: proxyPool.toJSON()
    });
    const file = this.getFilePath();
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, this.canEncrypt()
        ? this.safeStorage.encryptString(json)
        : Buffer.from(json, 'utf-8'));
      this.cache = { accounts, sniper: (data && data.sniper) || emptyAccount(), proxyPool };
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
      proxy: acc.proxy || '',
      email: acc.email || '',
      // Gravar credencial à mão é o caso de uma conta que já existe; só o
      // assistente de cadastro marca `signup`, e ele usa `setSignup`.
      signup: false,
      // A classe é do personagem, não do login: trocar a senha não o faz
      // renascer. Omitir o campo aqui apagava a escolha do assistente e a
      // WebView deixava de marcar o cartão no modal da conta nova.
      classId: acc.classId || ''
    };
    return this.save(data);
  }

  /**
   * Grava uma credencial que o assistente de cadastro acabou de inventar, para
   * uma conta que ainda **não existe** no servidor.
   *
   * Separado de `setCredentials` de propósito: lá a conta existe e a marca tem
   * de cair; aqui ela tem de subir. Um parâmetro a mais no mesmo método faria
   * o caso comum carregar a decisão do caso raro.
   */
  setPendingSignup(index, { username, password, email, classId }) {
    if (index < 0 || index >= this.maxAccounts) return false;
    const data = this.load();
    const acc = data.accounts[index] || emptyAccount();
    data.accounts[index] = {
      username: username || '',
      password: password || '',
      token: '',
      proxy: acc.proxy || '',
      email: email || '',
      signup: true,
      classId: classId || ''
    };
    return this.save(data);
  }

  /**
   * A conta saiu do limbo: o cadastro passou pelo captcha e ela existe.
   * Chamado quando a WebView captura um login bem-sucedido com esse nome.
   */
  clearSignupFlag(index) {
    if (index < 0 || index >= this.maxAccounts) return false;
    const data = this.load();
    const acc = data.accounts[index];
    if (!acc || !acc.signup) return false;
    data.accounts[index] = { ...acc, signup: false };
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
    data.accounts[index] = { ...acc, proxy: this.resolveProxy(acc.proxy, proxy) };
    return this.save(data);
  }

  /**
   * A rota a gravar, dado o que a tela mandou e o que já estava salvo.
   *
   * O campo mostra a senha mascarada, então reenviar o valor à vista — sem
   * tocar em nada — tem de **preservar** a senha guardada em vez de gravar a
   * marca como se fosse senha. Era esse o caminho que deixava uma conta sem
   * senha de proxy e sem nenhum aviso.
   *
   * A senha só é mantida se o resto da rota não mudou: trocar de host ou de
   * usuário é outra rota, e carregar a senha antiga para ela seria adivinhação.
   */
  resolveProxy(current, input) {
    const raw = String(input || '').trim();
    if (!raw) return '';
    if (!isMaskedProxy(raw)) return normalizeProxy(raw);

    // Veio mascarado: a senha real é a que está salva, e só vale se for a
    // mesma rota. Sem par, a marca é removida e a rota fica sem senha — o que
    // o aviso de `proxyMissingPassword` então denuncia.
    const semMarca = normalizeProxy(raw.split(PROXY_SECRET_MASK).join(''));
    try {
      const nova = new URL(semMarca);
      const velha = new URL(current || '');
      if (nova.host === velha.host && nova.username === velha.username && velha.password) {
        nova.password = velha.password;
        return nova.toString().replace(/\/$/, '');
      }
    } catch {}
    return semMarca.replace(/:@/, '@');
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

  getSniper() { return { ...this.load().sniper }; }

  setSniper(username, password, proxy) {
    const data = this.load();
    data.sniper = { username: username || '', password: password || '', token: '', proxy: normalizeProxy(proxy) };
    return this.save(data);
  }

  /** Apaga a conta e mantém o proxy: o slot costuma receber outra conta na mesma rota. */
  clear(index) {
    return this.setCredentials(index, '', '');
  }

  /**
   * Apaga o slot **inteiro**, inclusive proxy, email e classe.
   *
   * Diferente de `clear`, que guarda a rota porque o slot costuma receber outra
   * conta no mesmo lugar. Aqui o pedido é outro: o usuário mandou remover a
   * conta, e deixar o email do cadastro ou a rota antiga no disco significaria
   * que "removida" não era verdade. O slot continua existindo, vazio — a
   * partição é persistente e os índices das outras contas não podem andar.
   */
  wipe(index) {
    if (index < 0 || index >= this.maxAccounts) return false;
    const data = this.load();
    data.accounts[index] = emptyAccount();
    return this.save(data);
  }

  /**
   * Apaga o slot **inteiro**, inclusive proxy, email e classe.
   *
   * Diferente de `clear`, que guarda a rota porque o slot costuma receber outra
   * conta no mesmo lugar. Aqui o pedido é outro: o usuário mandou remover a
   * conta, e deixar o email do cadastro ou a rota antiga no disco significaria
   * que "removida" não era verdade. O slot continua existindo, vazio — a
   * partição é persistente e os índices das outras contas não podem andar.
   */
  wipe(index) {
    if (index < 0 || index >= this.maxAccounts) return false;
    const data = this.load();
    data.accounts[index] = emptyAccount();
    return this.save(data);
  }

  /** Visão sem segredos, segura para mandar ao renderizador. */
  getPublicStatus() {
    const { accounts, proxyPool } = this.load();
    const pool = proxyPool || new LevelingProxyPool();
    return {
      encrypted: this.canEncrypt(),
      accounts: accounts.map((acc, i) => ({
        username: acc.username,
        hasPassword: !!acc.password,
        hasToken: !!acc.token,
        proxy: describeProxy(acc.proxy),
        /*
         * A rota pela qual esta conta sai, do pool. Vai para a tela ao lado do
         * nome da conta: saber que a "Conta 3 desjunior" sai por tal IP é o que
         * permite notar duas contas no mesmo endereço antes do servidor
         * reclamar.
         */
        route: pool.describeRoute(i),
        // A conta pode abrir? Só as duas primeiras saem pelo IP da máquina; as
        // outras exigem um proxy que passou no teste.
        canOpen: pool.canOpen(i),
        // Rota com usuário e sem senha: o proxy recusa a conexão antes de
        // qualquer login, e a falha chega como erro de WebSocket, sem código
        // que a explique. A tela avisa em vez de deixar o usuário procurar.
        proxyIncomplete: proxyMissingPassword(acc.proxy),
        // A conta ainda não existe no servidor: o assistente reservou o nome,
        // mas o cadastro só termina quando o captcha for resolvido na aba.
        pendingSignup: acc.signup === true
      })),
      sniper: { username: this.getSniper().username, hasPassword: !!this.getSniper().password, proxy: describeProxy(this.getSniper().proxy) }
    };
  }
}

const levelingCredentials = new LevelingCredentialStore();

module.exports = {
  LevelingCredentialStore,
  levelingCredentials,
  MAX_ACCOUNTS,
  normalizeProxy,
  describeProxy,
  proxyMissingPassword,
  isMaskedProxy,
  PROXY_SECRET_MASK,
  LevelingProxyPool
};

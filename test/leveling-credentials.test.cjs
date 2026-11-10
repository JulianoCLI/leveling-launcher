const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { LevelingCredentialStore, normalizeProxy } = require('../src/domain/leveling-credentials');

function tmpFile() {
  return path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'lvcreds-')),
    'leveling_creds.enc'
  );
}

/** Imita o safeStorage do Electron sem depender de DPAPI. */
const fakeSafeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: s => Buffer.concat([Buffer.from('ENC:'), Buffer.from(s, 'utf-8')]),
  decryptString: b => {
    const buf = Buffer.from(b);
    if (buf.subarray(0, 4).toString() !== 'ENC:') throw new Error('não cifrado');
    return buf.subarray(4).toString('utf-8');
  }
};

test('normalizeProxy recusa o que não vira URL em vez de devolver lixo', () => {
  /*
   * O ramo final era `'http://' + raw`, e por isso `host:porta:usuario` saía
   * daqui como `http://host:porta:usuario` — com cara de URL, aceito pelo
   * armazenamento e recusado só no fim, dentro do `undici`, como `Invalid URL`.
   * Era esse o caminho da conta que abria no modo normal e deixava o monitor
   * reconectando para sempre.
   */
  assert.equal(normalizeProxy('1.2.3.4:8080:usuario'), '', 'três pedaços não são uma rota');
  assert.equal(normalizeProxy('http://'), '', 'esquema sem host não é uma rota');
  assert.equal(normalizeProxy('   '), '');
  assert.equal(normalizeProxy(null), '');

  // As formas que os provedores entregam continuam valendo.
  assert.equal(normalizeProxy('1.2.3.4:8080'), 'http://1.2.3.4:8080');
  assert.equal(normalizeProxy('1.2.3.4:8080:ana:s3nha'), 'http://ana:s3nha@1.2.3.4:8080');
  assert.equal(normalizeProxy('socks5://h:1080'), 'socks5://h:1080');

  /*
   * E o que sai daqui tem de passar pelo parser que vai consumi-lo depois.
   * Validar com outra regra seria aprovar aqui o que falha adiante, que é o
   * defeito que esta função existe para não ter.
   */
  const { ProxyAgent } = require('undici');
  for (const bruto of ['1.2.3.4:8080', '1.2.3.4:8080:ana:s3nha', '1.2.3.4', 'http://a:b@h:1']) {
    const url = normalizeProxy(bruto);
    assert.ok(url, `${bruto} deveria normalizar`);
    assert.doesNotThrow(() => new ProxyAgent(url), `undici recusou ${url}`);
  }
});

test('grava e lê credenciais pelas quatro contas', () => {
  const store = new LevelingCredentialStore({ filePath: tmpFile(), safeStorage: fakeSafeStorage });

  assert.deepEqual(store.get(0), {
    username: '', password: '', token: '', proxy: '', email: '', signup: false, classId: ''
  });

  store.setCredentials(0, 'desjunior', 'segredo');
  store.setCredentials(3, 'outro', 'senha2');

  const reaberto = new LevelingCredentialStore({ filePath: store.getFilePath(), safeStorage: fakeSafeStorage });
  assert.equal(reaberto.get(0).username, 'desjunior');
  assert.equal(reaberto.get(0).password, 'segredo');
  assert.equal(reaberto.get(3).username, 'outro');
  assert.equal(reaberto.get(1).username, '', 'contas não preenchidas ficam vazias');
});

test('o arquivo em disco não contém a senha em claro', () => {
  const file = tmpFile();
  const store = new LevelingCredentialStore({ filePath: file, safeStorage: fakeSafeStorage });
  store.setCredentials(0, 'cacador', 'senha-de-teste');

  const raw = fs.readFileSync(file);
  assert.equal(raw.subarray(0, 4).toString(), 'ENC:', 'deve passar pelo safeStorage');
  assert.ok(store.canEncrypt());
});

test('o token é atualizado sem perder as credenciais', () => {
  const store = new LevelingCredentialStore({ filePath: tmpFile(), safeStorage: fakeSafeStorage });
  store.setCredentials(1, 'cacador', 'senha');
  store.setToken(1, 'tok-abc');

  const acc = store.get(1);
  assert.equal(acc.username, 'cacador');
  assert.equal(acc.password, 'senha');
  assert.equal(acc.token, 'tok-abc');
});

test('trocar as credenciais descarta o token antigo', () => {
  const store = new LevelingCredentialStore({ filePath: tmpFile(), safeStorage: fakeSafeStorage });
  store.setCredentials(0, 'a', 'b');
  store.setToken(0, 'tok-velho');
  store.setCredentials(0, 'a', 'nova-senha');

  assert.equal(store.get(0).token, '', 'o token pertence ao login anterior');
});

test('o status público não expõe segredos', () => {
  const store = new LevelingCredentialStore({ filePath: tmpFile(), safeStorage: fakeSafeStorage });
  store.setCredentials(0, 'cacador', 'senha-de-teste');
  store.setToken(0, 'tok-secreto');

  const status = store.getPublicStatus();
  const serializado = JSON.stringify(status);

  assert.equal(status.accounts[0].username, 'cacador');
  assert.equal(status.accounts[0].hasPassword, true);
  assert.equal(status.accounts[0].hasToken, true);
  assert.ok(!serializado.includes('senha-de-teste'), 'senha não pode sair do processo principal');
  assert.ok(!serializado.includes('tok-secreto'), 'token não pode sair do processo principal');
});

test('credencial de cadastro nasce pendente e sai do limbo ao logar', () => {
  // O cadastro exige o captcha do Turnstile, que só existe na WebView. Então a
  // credencial é guardada antes de a conta existir, e a marca `signup` é o que
  // impede o monitor de tentar logar numa conta que ainda não foi criada.
  const store = new LevelingCredentialStore({ filePath: tmpFile(), safeStorage: fakeSafeStorage });

  store.setPendingSignup(0, {
    username: 'cacador1', password: 'Abcdef1!', email: 'cacador1@exemplo.com'
  });

  assert.equal(store.get(0).signup, true);
  assert.equal(store.get(0).email, 'cacador1@exemplo.com');

  store.clearSignupFlag(0);
  assert.equal(store.get(0).signup, false);
  // Limpar a marca não mexe no resto: a credencial é a mesma, só deixou de ser
  // uma promessa.
  assert.equal(store.get(0).username, 'cacador1');
  assert.equal(store.get(0).email, 'cacador1@exemplo.com');
});

test('um plano de duas contas guarda as duas, não só a primeira', () => {
  /*
   * A regressão que fazia o cadastro assistido criar só a primeira conta.
   *
   * `setPendingSignup` substitui o cache interno a cada chamada. Quem lia o
   * `data` antes do laço e salvava depois reescrevia um retrato velho, apagando
   * tudo menos a primeira conta — e a segunda janela abria sem credencial para
   * preencher. A gravação precisa ser uma só, com o `data` montado inteiro.
   */
  const store = new LevelingCredentialStore({ filePath: tmpFile(), safeStorage: fakeSafeStorage });
  const plano = [
    { username: 'conta_a', password: 'Abcdef1!', email: 'a@gmail.com', classId: 'mago' },
    { username: 'conta_b', password: 'Abcdef2!', email: 'b@gmail.com', classId: 'healer' }
  ];

  const data = store.load();
  plano.forEach((item, i) => {
    data.accounts[i] = {
      username: item.username, password: item.password, token: '',
      proxy: '', email: item.email, signup: true, classId: item.classId
    };
  });
  store.save(data);

  const relido = new LevelingCredentialStore({
    filePath: store.getFilePath(), safeStorage: fakeSafeStorage
  });
  assert.equal(relido.get(0).username, 'conta_a');
  assert.equal(relido.get(1).username, 'conta_b', 'a segunda conta do plano não pode sumir');
  assert.equal(relido.get(1).classId, 'healer', 'cada conta mantém a sua classe');
  assert.equal(relido.get(1).signup, true);
});

test('o status público diz por onde cada conta sai', () => {
  // É o dado que a tela mostra ao lado do nome da conta: sem ele não há como
  // notar duas contas no mesmo IP antes do servidor recusar.
  const store = new LevelingCredentialStore({ filePath: tmpFile(), safeStorage: fakeSafeStorage });
  const data = store.load();
  data.proxyPool.importText('203.0.113.7:8080');
  data.proxyPool.proxies[0].status = 'ok';
  data.proxyPool.proxies[0].ip = '203.0.113.7';
  data.proxyPool.assign(2);
  store.save(data);

  const { accounts } = store.getPublicStatus();

  assert.equal(accounts[0].route.kind, 'local', 'a conta 1 sai pelo IP da máquina');
  assert.equal(accounts[0].canOpen.ok, true);

  assert.equal(accounts[2].route.kind, 'proxy');
  assert.equal(accounts[2].route.ip, '203.0.113.7');
  assert.equal(accounts[2].canOpen.ok, true);

  // A conta 4 não tem proxy e não é uma das duas primeiras: está bloqueada.
  assert.equal(accounts[3].route.kind, 'none');
  assert.equal(accounts[3].canOpen.ok, false);
});

test('gravar credencial à mão não deixa a conta marcada como pendente', () => {
  const store = new LevelingCredentialStore({ filePath: tmpFile(), safeStorage: fakeSafeStorage });
  store.setPendingSignup(0, { username: 'a1', password: 'Abcdef1!', email: 'a@b.com' });

  // Quem digita usuário e senha está falando de uma conta que já existe.
  store.setCredentials(0, 'conta-real', 'outra');
  assert.equal(store.get(0).signup, false);
});

test('o proxy sobrevive à gravação da credencial de cadastro', () => {
  // O proxy descreve a rota, não a conta: reservar um nome novo não deve
  // devolver a conta ao IP local e furar o limite de duas por proxy.
  const store = new LevelingCredentialStore({ filePath: tmpFile(), safeStorage: fakeSafeStorage });
  store.setProxy(0, 'http://1.2.3.4:8080');
  store.setPendingSignup(0, { username: 'a1', password: 'Abcdef1!', email: 'a@b.com' });

  assert.equal(store.get(0).proxy, 'http://1.2.3.4:8080');
});

test('arquivo corrompido não derruba o launcher', () => {
  const file = tmpFile();
  fs.writeFileSync(file, Buffer.from('lixo que não é json nem cifra'));
  const store = new LevelingCredentialStore({ filePath: file, safeStorage: fakeSafeStorage });

  assert.deepEqual(store.get(0), {
    username: '', password: '', token: '', proxy: '', email: '', signup: false, classId: ''
  });
  assert.equal(store.getPublicStatus().accounts.length, 4);
});

test('abrir uma aba nova cresce os slots sem apagar as contas salvas', () => {
  const file = tmpFile();
  const store = new LevelingCredentialStore({ filePath: file, safeStorage: fakeSafeStorage });
  store.setCredentials(0, 'desjunior', 'senha');

  assert.equal(store.ensureCapacity(8), 8);
  store.setCredentials(7, 'oitava', 'outra');

  const relido = new LevelingCredentialStore({ filePath: file, safeStorage: fakeSafeStorage });
  assert.equal(relido.getPublicStatus().accounts.length, 8, 'o arquivo manda no tamanho');
  assert.equal(relido.get(0).username, 'desjunior');
  assert.equal(relido.get(7).username, 'oitava');
});

test('fechar uma aba não apaga as credenciais das contas dela', () => {
  const file = tmpFile();
  const store = new LevelingCredentialStore({ filePath: file, safeStorage: fakeSafeStorage });
  store.ensureCapacity(8);
  store.setCredentials(5, 'sexta', 'senha');

  // Menos abas do que o disco já tem: a capacidade só cresce.
  assert.equal(store.ensureCapacity(4), 8);
  assert.equal(store.get(5).username, 'sexta');
});

test('sem safeStorage, ainda funciona e avisa que não está cifrado', () => {
  const store = new LevelingCredentialStore({ filePath: tmpFile(), safeStorage: null });
  store.setCredentials(0, 'u', 'p');

  assert.equal(store.canEncrypt(), false);
  assert.equal(store.getPublicStatus().encrypted, false);
  assert.equal(store.get(0).username, 'u');
});

test('limpar a conta apaga a credencial e mantém a rota', () => {
  const store = new LevelingCredentialStore({ filePath: tmpFile(), safeStorage: fakeSafeStorage });
  store.setCredentials(2, 'u', 'p');
  store.setToken(2, 'tok');
  store.setProxy(2, '10.0.0.1:8080');
  store.clear(2);

  // O proxy descreve por onde o slot sai, não quem usa: trocar de conta no
  // mesmo slot normalmente mantém a rota.
  assert.deepEqual(store.get(2), {
    username: '', password: '', token: '', proxy: 'http://10.0.0.1:8080',
    email: '', signup: false, classId: ''
  });
});

test('o proxy aceita as formas curtas que os provedores entregam', () => {
  const store = new LevelingCredentialStore({ filePath: tmpFile(), safeStorage: fakeSafeStorage });

  store.setProxy(0, '1.2.3.4:9000');
  assert.equal(store.get(0).proxy, 'http://1.2.3.4:9000', 'host:porta assume HTTP');

  store.setProxy(1, '1.2.3.4:9000:zed:s3nha');
  assert.equal(store.get(1).proxy, 'http://zed:s3nha@1.2.3.4:9000', 'host:porta:usuario:senha');

  store.setProxy(2, 'socks5://1.2.3.4:1080');
  assert.equal(store.get(2).proxy, 'socks5://1.2.3.4:1080', 'URL completa passa intacta');

  store.setProxy(3, '   ');
  assert.equal(store.get(3).proxy, '', 'vazio significa sair pelo IP local');
});

test('trocar a senha preserva a rota, e o status público esconde a do proxy', () => {
  const store = new LevelingCredentialStore({ filePath: tmpFile(), safeStorage: fakeSafeStorage });
  store.setProxy(0, '1.2.3.4:9000:zed:s3nha');
  store.setCredentials(0, 'u', 'p');

  assert.equal(store.get(0).proxy, 'http://zed:s3nha@1.2.3.4:9000');

  const status = store.getPublicStatus();
  // A senha vira marca em vez de sumir: apagá-la fazia uma rota completa e uma
  // rota sem senha ficarem idênticas na tela.
  assert.equal(status.accounts[0].proxy, 'http://zed:•••@1.2.3.4:9000');
  assert.ok(!JSON.stringify(status).includes('s3nha'), 'senha do proxy não sai do principal');
});

test('reenviar o campo mascarado preserva a senha do proxy', () => {
  // O bug: o campo mostrava a rota sem a senha, e "Aplicar rota" sem mexer em
  // nada gravava essa versão truncada. O proxy então recusava o CONNECT e a
  // conta falhava com "erro de conexão no WebSocket", sem citar proxy.
  const store = new LevelingCredentialStore({ filePath: tmpFile(), safeStorage: fakeSafeStorage });
  store.setProxy(0, '1.2.3.4:9000:zed:s3nha');

  const visto = store.getPublicStatus().accounts[0].proxy;
  store.setProxy(0, visto);

  assert.equal(store.get(0).proxy, 'http://zed:s3nha@1.2.3.4:9000',
    'salvar o que estava à vista não pode esvaziar a senha');
});

test('a senha mascarada não é carregada para outra rota', () => {
  // Mudar o host é outra rota: levar a senha antiga para ela seria adivinhação,
  // e um proxy errado que "quase funciona" é pior que um que falha na hora.
  const store = new LevelingCredentialStore({ filePath: tmpFile(), safeStorage: fakeSafeStorage });
  store.setProxy(0, '1.2.3.4:9000:zed:s3nha');

  store.setProxy(0, 'http://zed:•••@9.9.9.9:9000');
  assert.equal(store.get(0).proxy, 'http://zed@9.9.9.9:9000');
  assert.equal(store.getPublicStatus().accounts[0].proxyIncomplete, true,
    'e a rota sem senha é denunciada, em vez de falhar calada');
});

test('rota com usuário e sem senha é sinalizada', () => {
  // Foi exatamente o estado em que uma conta ficou: mesma rota das outras, só
  // que sem a senha do proxy, e sem nada na tela que a distinguisse.
  const store = new LevelingCredentialStore({ filePath: tmpFile(), safeStorage: fakeSafeStorage });

  store.setProxy(0, 'http://zed@1.2.3.4:9000');
  store.setProxy(1, '1.2.3.4:9000:zed:s3nha');
  store.setProxy(2, '1.2.3.4:9000');

  const contas = store.getPublicStatus().accounts;
  assert.equal(contas[0].proxyIncomplete, true, 'usuário sem senha: o proxy recusa');
  assert.equal(contas[1].proxyIncomplete, false, 'rota completa');
  assert.equal(contas[2].proxyIncomplete, false, 'rota sem usuário nenhum não exige senha');
});

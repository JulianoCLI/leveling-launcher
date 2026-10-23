const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { LevelingCredentialStore } = require('../src/domain/leveling-credentials');

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

test('grava e lê credenciais pelas quatro contas', () => {
  const store = new LevelingCredentialStore({ filePath: tmpFile(), safeStorage: fakeSafeStorage });

  assert.deepEqual(store.get(0), { username: '', password: '', token: '', proxy: '' });

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

test('arquivo corrompido não derruba o launcher', () => {
  const file = tmpFile();
  fs.writeFileSync(file, Buffer.from('lixo que não é json nem cifra'));
  const store = new LevelingCredentialStore({ filePath: file, safeStorage: fakeSafeStorage });

  assert.deepEqual(store.get(0), { username: '', password: '', token: '', proxy: '' });
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
  assert.deepEqual(store.get(2),
    { username: '', password: '', token: '', proxy: 'http://10.0.0.1:8080' });
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
  assert.equal(status.accounts[0].proxy, 'http://zed@1.2.3.4:9000');
  assert.ok(!JSON.stringify(status).includes('s3nha'), 'senha do proxy não sai do principal');
});

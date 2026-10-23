const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const protobuf = require('protobufjs');
const descriptor = require('protobufjs/ext/descriptor');

const PROTO_DIR = path.join(__dirname, '..', 'proto');

function loadRoot() {
  const set = descriptor
    .lookupType('google.protobuf.FileDescriptorSet')
    .decode(fs.readFileSync(path.join(PROTO_DIR, 'descriptor-set.bin')));
  const root = protobuf.Root.fromDescriptor(set);
  root.resolveAll();
  return root;
}

test('descriptor-set carrega e expõe o envelope do Leveling Idle', () => {
  const root = loadRoot();
  const client = root.lookupType('leveling.v1.ClientMessage');
  const server = root.lookupType('leveling.v1.ServerMessage');

  assert.ok(client.fields.request_id, 'ClientMessage precisa de request_id para correlacionar respostas');
  assert.ok(server.fields.request_id, 'ServerMessage precisa de request_id');
  assert.ok(Object.keys(client.fields).length > 100);
  assert.ok(Object.keys(server.fields).length > 100);
});

test('o fluxo de caçada tem os cases que o headless precisa', () => {
  const root = loadRoot();
  const client = root.lookupType('leveling.v1.ClientMessage').fields;
  const server = root.lookupType('leveling.v1.ServerMessage').fields;

  for (const name of ['ping', 'login', 'resume', 'start_hunt', 'leave_hunt', 'set_automation', 'revive', 'give_up']) {
    assert.ok(client[name], `ClientMessage.${name} ausente`);
  }
  for (const name of ['pong', 'auth_ok', 'session_ended', 'error', 'hunt_session', 'character_state', 'character_patch', 'death_state', 'start_hunt_result']) {
    assert.ok(server[name], `ServerMessage.${name} ausente`);
  }
});

test('StartHunt e HuntSession sobrevivem a um round-trip', () => {
  const root = loadRoot();
  const ClientMessage = root.lookupType('leveling.v1.ClientMessage');

  const sent = { request_id: 42, start_hunt: { gate_id: 'portal-azul', tier_min: 7, difficulty: 'normal' } };
  const wire = ClientMessage.encode(ClientMessage.create(sent)).finish();
  assert.deepStrictEqual(ClientMessage.decode(wire).toJSON(), sent);

  const HuntSession = root.lookupType('leveling.v1.HuntSession');
  for (const field of ['gate_id', 'tier_min', 'difficulty', 'kills', 'xp', 'gold', 'streak', 'wave', 'red_portal_until_ms', 'drops']) {
    assert.ok(HuntSession.fields[field], `HuntSession.${field} ausente`);
  }
});

test('o token de sessão vem do AuthOk, nunca do nome de usuário', () => {
  const root = loadRoot();
  const AuthOk = root.lookupType('leveling.v1.AuthOk');
  assert.strictEqual(AuthOk.fields.token.type, 'string');
  assert.ok(AuthOk.fields.account_id, 'identidade da conta precisa vir do servidor');
  assert.ok(root.lookupType('leveling.v1.Resume').fields.token, 'Resume reconecta por token');
});

test('o índice do envelope acompanha o descriptor-set', () => {
  const index = JSON.parse(fs.readFileSync(path.join(PROTO_DIR, 'leveling-envelope.json'), 'utf8'));
  const root = loadRoot();

  for (const kind of ['ClientMessage', 'ServerMessage']) {
    const fields = root.lookupType('leveling.v1.' + kind).fields;
    assert.ok(index[kind].length > 0);
    for (const entry of index[kind]) {
      const field = fields[entry.field];
      assert.ok(field, `${kind}.${entry.field} listado no índice mas ausente no schema`);
      assert.strictEqual(field.id, entry.number);
    }
  }
});

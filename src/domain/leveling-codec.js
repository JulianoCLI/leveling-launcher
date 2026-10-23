/**
 * @file leveling-codec.js
 * Codec do envelope Protobuf do Leveling Idle 2D.
 *
 * O cliente web embute os descritores no bundle; `tools/leveling-extract-proto.js`
 * os extrai para `proto/descriptor-set.bin`, que é a fonte de verdade aqui.
 * Regenerar com `npm run proto:leveling` depois de cada deploy do jogo.
 *
 * Duas responsabilidades, nenhuma regra de jogo:
 *   1. codificar ClientMessage / decodificar ServerMessage;
 *   2. identificar o `case` de um pacote lendo apenas o cabeçalho, para que
 *      o chamador descarte o tráfego de mundo (20 Hz) sem desserializar nada.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const DESCRIPTOR_SET = path.join(__dirname, '..', '..', 'proto', 'descriptor-set.bin');

// Campo 1 de ClientMessage/ServerMessage; o corpo é um `oneof` a partir do 2.
const REQUEST_ID_FIELD = 1;

let cached = null;

function loadRoot(descriptorPath = DESCRIPTOR_SET) {
  const protobuf = require('protobufjs');
  const descriptor = require('protobufjs/ext/descriptor');
  const set = descriptor
    .lookupType('google.protobuf.FileDescriptorSet')
    .decode(fs.readFileSync(descriptorPath));
  const root = protobuf.Root.fromDescriptor(set);
  root.resolveAll();
  return root;
}

/**
 * Lê um varint sem alocar. Devolve `[valor, próximaPosição]`,
 * ou `null` se o buffer acabar no meio.
 */
function readVarint(buf, pos) {
  let result = 0;
  let shift = 0;
  while (pos < buf.length) {
    const byte = buf[pos++];
    result += (byte & 0x7f) * Math.pow(2, shift);
    if ((byte & 0x80) === 0) return [result, pos];
    shift += 7;
    if (shift > 56) return null;
  }
  return null;
}

class LevelingCodec {
  constructor(options = {}) {
    this.root = options.root || loadRoot(options.descriptorPath);
    this.ClientMessage = this.root.lookupType('leveling.v1.ClientMessage');
    this.ServerMessage = this.root.lookupType('leveling.v1.ServerMessage');

    // número do campo -> nome do case, para peek sem desserializar
    this.serverCases = new Map();
    for (const field of this.ServerMessage.fieldsArray) {
      if (field.id !== REQUEST_ID_FIELD) this.serverCases.set(field.id, field.name);
    }
    this.clientCases = new Set(
      this.ClientMessage.fieldsArray.filter(f => f.id !== REQUEST_ID_FIELD).map(f => f.name)
    );
  }

  /** Nomes de case válidos, para validar antes de enviar. */
  hasClientCase(name) {
    return this.clientCases.has(name);
  }

  encode(requestId, caseName, value = {}) {
    if (!this.hasClientCase(caseName)) {
      throw new Error(`case desconhecido em ClientMessage: ${caseName}`);
    }
    const payload = { [caseName]: value };
    if (requestId) payload.request_id = requestId;
    const err = this.ClientMessage.verify(payload);
    if (err) throw new Error(`payload inválido para ${caseName}: ${err}`);
    return Buffer.from(this.ClientMessage.encode(this.ClientMessage.create(payload)).finish());
  }

  /**
   * Descobre `requestId` e nome do case varrendo só os cabeçalhos dos campos.
   * Não desserializa o corpo — é o que permite ignorar `world_snapshot` barato.
   */
  peek(buf) {
    let pos = 0;
    let requestId = 0;
    let caseName = null;

    while (pos < buf.length) {
      const key = readVarint(buf, pos);
      if (!key) break;
      pos = key[1];
      const field = key[0] >>> 3;
      const wire = key[0] & 7;

      if (field === REQUEST_ID_FIELD && wire === 0) {
        const v = readVarint(buf, pos);
        if (!v) break;
        requestId = v[0];
        pos = v[1];
        continue;
      }

      if (wire === 2) {
        const len = readVarint(buf, pos);
        if (!len) break;
        if (!caseName) caseName = this.serverCases.get(field) || null;
        pos = len[1] + len[0];
        continue;
      }

      // Nenhum case do envelope usa outro wire type; nada mais a ler.
      break;
    }

    return { requestId, caseName };
  }

  /** Desserializa o pacote inteiro. Só vale a pena depois de aprovar no `peek`. */
  decode(buf) {
    const message = this.ServerMessage.decode(buf);
    const object = this.ServerMessage.toObject(message, {
      longs: String,
      enums: String,
      bytes: String,
      defaults: false,
      arrays: true,
      objects: true
    });
    const requestId = Number(object.request_id || 0);
    const caseName = Object.keys(object).find(k => k !== 'request_id') || null;
    return { requestId, caseName, value: caseName ? object[caseName] : null };
  }
}

/** Instância compartilhada: o descriptor-set tem alguns MB desserializados. */
function getCodec() {
  if (!cached) cached = new LevelingCodec();
  return cached;
}

module.exports = { LevelingCodec, getCodec, loadRoot, DESCRIPTOR_SET };

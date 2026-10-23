#!/usr/bin/env node
/**
 * @file leveling-extract-proto.js
 * Extrai o schema Protobuf do Leveling Idle 2D a partir do bundle publicado.
 *
 * O cliente web embute os FileDescriptorProto em base64 dentro do chunk de
 * rede (`Do(\`Ch...\`)`). Este script baixa a página do jogo, segue os chunks
 * JavaScript, decodifica cada descritor e escreve:
 *
 *   proto/leveling/v1/*.proto      — schema legível, regenerável a cada deploy
 *   proto/descriptor-set.bin       — FileDescriptorSet para geradores de código
 *   proto/leveling-envelope.json   — índice dos cases de ClientMessage/ServerMessage
 *
 * Uso: node tools/leveling-extract-proto.js [--base https://host] [--out proto]
 */

'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_BASE = 'https://levelingidle2d.com.br';
const ENTRY_PATHS = ['/jogar', '/'];

// ---------------------------------------------------------------- wire format

function readVarint(buf, pos) {
  let result = 0n;
  let shift = 0n;
  for (;;) {
    if (pos >= buf.length) throw new Error('varint truncado');
    const byte = buf[pos++];
    result |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) break;
    shift += 7n;
    if (shift > 63n) throw new Error('varint longo demais');
  }
  return [result, pos];
}

/** Decodifica uma mensagem em `Map<fieldNumber, value[]>`. */
function parseMessage(buf) {
  const fields = new Map();
  let pos = 0;
  while (pos < buf.length) {
    const [key, afterKey] = readVarint(buf, pos);
    pos = afterKey;
    const field = Number(key >> 3n);
    const wire = Number(key & 7n);
    let value;
    if (wire === 0) {
      const [v, next] = readVarint(buf, pos);
      pos = next;
      value = v;
    } else if (wire === 1) {
      value = buf.readBigUInt64LE(pos);
      pos += 8;
    } else if (wire === 2) {
      const [len, next] = readVarint(buf, pos);
      pos = next;
      const size = Number(len);
      value = buf.subarray(pos, pos + size);
      pos += size;
    } else if (wire === 5) {
      value = BigInt(buf.readUInt32LE(pos));
      pos += 4;
    } else {
      throw new Error('wire type não suportado: ' + wire);
    }
    let list = fields.get(field);
    if (!list) fields.set(field, (list = []));
    list.push(value);
  }
  return fields;
}

const all = (fields, n) => fields.get(n) || [];
const one = (fields, n) => all(fields, n)[0];
const str = (fields, n) => {
  const v = one(fields, n);
  return v === undefined ? undefined : Buffer.from(v).toString('utf8');
};
const int = (fields, n) => {
  const v = one(fields, n);
  return v === undefined ? undefined : Number(v);
};
const bool = (fields, n) => {
  const v = one(fields, n);
  return v === undefined ? undefined : v !== 0n;
};
const msg = (fields, n) => all(fields, n).map(b => parseMessage(b));

// ------------------------------------------------------ descriptor.proto model

const LABELS = { 1: 'optional', 2: 'required', 3: 'repeated' };
const TYPES = {
  1: 'double', 2: 'float', 3: 'int64', 4: 'uint64', 5: 'int32',
  6: 'fixed64', 7: 'fixed32', 8: 'bool', 9: 'string', 10: 'group',
  11: 'message', 12: 'bytes', 13: 'uint32', 14: 'enum',
  15: 'sfixed32', 16: 'sfixed64', 17: 'sint32', 18: 'sint64'
};

function parseField(f) {
  return {
    name: str(f, 1),
    number: int(f, 3),
    label: LABELS[int(f, 4)] || 'optional',
    type: TYPES[int(f, 5)] || 'unknown',
    typeName: str(f, 6),
    defaultValue: str(f, 7),
    oneofIndex: int(f, 9),
    jsonName: str(f, 10),
    // proto3_optional sintetiza um oneof de um só campo; é o campo 17.
    proto3Optional: bool(f, 17) === true
  };
}

function parseEnum(e) {
  return {
    name: str(e, 1),
    values: msg(e, 2).map(v => ({ name: str(v, 1), number: int(v, 2) ?? 0 }))
  };
}

function parseDescriptor(d) {
  const options = one(d, 7);
  return {
    name: str(d, 1),
    fields: msg(d, 2).map(parseField),
    nested: msg(d, 3).map(parseDescriptor),
    enums: msg(d, 4).map(parseEnum),
    oneofs: msg(d, 8).map(o => ({ name: str(o, 1) })),
    mapEntry: options ? bool(parseMessage(options), 7) === true : false
  };
}

function parseFile(buf) {
  const f = parseMessage(buf);
  const name = str(f, 1);
  if (!name || !name.endsWith('.proto')) return null;
  return {
    name,
    package: str(f, 2),
    dependencies: all(f, 3).map(b => Buffer.from(b).toString('utf8')),
    messages: msg(f, 4).map(parseDescriptor),
    enums: msg(f, 5).map(parseEnum),
    syntax: str(f, 12) || 'proto2',
    raw: buf
  };
}

// ---------------------------------------------------------- renderização .proto

function shortType(typeName, pkg) {
  if (!typeName) return typeName;
  const bare = typeName.replace(/^\./, '');
  if (pkg && bare.startsWith(pkg + '.')) return bare.slice(pkg.length + 1);
  return bare;
}

/** Mapas viram `map<k, v>`; devolve índice nome-do-entry -> {key, value}. */
function collectMapEntries(messages, pkg, prefix, out) {
  for (const m of messages) {
    const full = prefix ? prefix + '.' + m.name : m.name;
    if (m.mapEntry) {
      const key = m.fields.find(f => f.number === 1);
      const value = m.fields.find(f => f.number === 2);
      out.set((pkg ? pkg + '.' : '') + full, {
        key: key.type === 'message' || key.type === 'enum' ? shortType(key.typeName, pkg) : key.type,
        value: value.type === 'message' || value.type === 'enum' ? shortType(value.typeName, pkg) : value.type
      });
    }
    collectMapEntries(m.nested, pkg, full, out);
  }
}

function renderField(f, pkg, maps, indent) {
  const pad = ' '.repeat(indent);
  const typeName = f.type === 'message' || f.type === 'enum' ? shortType(f.typeName, pkg) : f.type;
  const mapInfo = f.type === 'message' && maps.get((f.typeName || '').replace(/^\./, ''));
  if (mapInfo && f.label === 'repeated') {
    return `${pad}map<${mapInfo.key}, ${mapInfo.value}> ${f.name} = ${f.number};`;
  }
  const parts = [];
  if (f.label === 'repeated') parts.push('repeated');
  else if (f.proto3Optional) parts.push('optional');
  parts.push(typeName, f.name, '=', String(f.number));
  return `${pad}${parts.join(' ')};`;
}

function renderEnum(e, indent) {
  const pad = ' '.repeat(indent);
  const lines = [`${pad}enum ${e.name} {`];
  for (const v of e.values) lines.push(`${pad}  ${v.name} = ${v.number};`);
  lines.push(`${pad}}`);
  return lines;
}

function renderMessage(m, pkg, maps, indent) {
  if (m.mapEntry) return [];
  const pad = ' '.repeat(indent);
  const lines = [`${pad}message ${m.name} {`];

  for (const e of m.enums) lines.push(...renderEnum(e, indent + 2), '');
  for (const nested of m.nested) {
    const rendered = renderMessage(nested, pkg, maps, indent + 2);
    if (rendered.length) lines.push(...rendered, '');
  }

  const inOneof = new Map();
  for (const f of m.fields) {
    if (f.oneofIndex === undefined || f.proto3Optional) continue;
    let list = inOneof.get(f.oneofIndex);
    if (!list) inOneof.set(f.oneofIndex, (list = []));
    list.push(f);
  }

  for (const f of m.fields) {
    if (f.oneofIndex !== undefined && !f.proto3Optional) continue;
    lines.push(renderField(f, pkg, maps, indent + 2));
  }

  for (const [idx, fields] of [...inOneof.entries()].sort((a, b) => a[0] - b[0])) {
    const name = m.oneofs[idx]?.name || `oneof_${idx}`;
    lines.push('', `${pad}  oneof ${name} {`);
    for (const f of fields) lines.push(renderField(f, pkg, maps, indent + 4));
    lines.push(`${pad}  }`);
  }

  lines.push(`${pad}}`);
  return lines;
}

function renderProto(file, maps) {
  const lines = [
    '// Gerado por tools/leveling-extract-proto.js — não editar à mão.',
    `syntax = "${file.syntax}";`,
    ''
  ];
  if (file.package) lines.push(`package ${file.package};`, '');
  for (const dep of file.dependencies) lines.push(`import "${dep}";`);
  if (file.dependencies.length) lines.push('');
  for (const e of file.enums) lines.push(...renderEnum(e, 0), '');
  for (const m of file.messages) {
    const rendered = renderMessage(m, file.package, maps, 0);
    if (rendered.length) lines.push(...rendered, '');
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n');
}

// ---------------------------------------------------------------- download

async function getText(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} em ${url}`);
  return res.text();
}

async function collectBundles(base) {
  const seen = new Set();
  const queue = [];

  for (const entry of ENTRY_PATHS) {
    let html;
    try {
      html = await getText(base + entry);
    } catch {
      continue;
    }
    for (const match of html.matchAll(/["'](\/assets\/[\w.\-]+\.js)["']/g)) {
      queue.push(base + match[1]);
    }
  }

  const sources = [];
  while (queue.length) {
    const url = queue.shift();
    if (seen.has(url)) continue;
    seen.add(url);
    let text;
    try {
      text = await getText(url);
    } catch {
      continue;
    }
    sources.push({ url, text });
    for (const match of text.matchAll(/["']\.\/([\w.\-]+\.js)["']/g)) {
      queue.push(new URL(match[1], url).href);
    }
  }
  return sources;
}

function extractDescriptors(sources) {
  const byName = new Map();
  for (const { text } of sources) {
    for (const match of text.matchAll(/["'`]([A-Za-z0-9+/]{150,}={0,2})["'`]/g)) {
      let file;
      try {
        file = parseFile(Buffer.from(match[1], 'base64'));
      } catch {
        continue;
      }
      if (file && !byName.has(file.name)) byName.set(file.name, file);
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function buildDescriptorSet(files) {
  const chunks = [];
  for (const file of files) {
    const len = file.raw.length;
    const varint = [];
    let n = len;
    do {
      let byte = n & 0x7f;
      n >>>= 7;
      if (n) byte |= 0x80;
      varint.push(byte);
    } while (n);
    chunks.push(Buffer.from([0x0a]), Buffer.from(varint), file.raw);
  }
  return Buffer.concat(chunks);
}

function envelopeIndex(files) {
  const envelope = files.find(f => f.name.endsWith('envelope.proto'));
  if (!envelope) return null;
  const out = {};
  for (const m of envelope.messages) {
    if (m.name !== 'ClientMessage' && m.name !== 'ServerMessage') continue;
    out[m.name] = m.fields
      .filter(f => f.oneofIndex !== undefined)
      .map(f => ({
        case: f.jsonName || f.name,
        field: f.name,
        number: f.number,
        type: shortType(f.typeName, envelope.package) || f.type
      }))
      .sort((a, b) => a.number - b.number);
  }
  return out;
}

// ---------------------------------------------------------------------- main

async function main() {
  const args = process.argv.slice(2);
  const argOf = name => {
    const i = args.indexOf(name);
    return i === -1 ? undefined : args[i + 1];
  };
  const base = (argOf('--base') || DEFAULT_BASE).replace(/\/$/, '');
  const outDir = path.resolve(argOf('--out') || 'proto');

  process.stdout.write(`Baixando chunks de ${base}...\n`);
  const sources = await collectBundles(base);
  if (!sources.length) throw new Error('nenhum chunk JavaScript encontrado');
  process.stdout.write(`  ${sources.length} chunk(s) baixado(s)\n`);

  const files = extractDescriptors(sources);
  if (!files.length) throw new Error('nenhum FileDescriptorProto encontrado no bundle');
  process.stdout.write(`  ${files.length} descritor(es) extraído(s)\n`);

  const maps = new Map();
  for (const file of files) collectMapEntries(file.messages, file.package, '', maps);

  for (const file of files) {
    const target = path.join(outDir, file.name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, renderProto(file, maps) + '\n', 'utf8');
    process.stdout.write(`  escrito ${file.name}\n`);
  }

  fs.writeFileSync(path.join(outDir, 'descriptor-set.bin'), buildDescriptorSet(files));

  const envelope = envelopeIndex(files);
  if (envelope) {
    fs.writeFileSync(
      path.join(outDir, 'leveling-envelope.json'),
      JSON.stringify(envelope, null, 2) + '\n',
      'utf8'
    );
    process.stdout.write(
      `  envelope: ${envelope.ClientMessage?.length || 0} cases cliente, ` +
      `${envelope.ServerMessage?.length || 0} cases servidor\n`
    );
  }

  process.stdout.write(`Pronto em ${outDir}\n`);
}

main().catch(err => {
  process.stderr.write(`erro: ${err.message}\n`);
  process.exitCode = 1;
});

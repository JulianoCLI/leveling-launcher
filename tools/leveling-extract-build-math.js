#!/usr/bin/env node
/**
 * @file leveling-extract-build-math.js
 * Acha no bundle publicado a função por trás de "Distribuir pela build".
 *
 * O auto-status precisa repetir exatamente a conta que o jogo faz ao clicar no
 * botão da build — alocar ponto é irreversível (respec custa token ou cristal),
 * então uma fórmula só parecida queima pontos de verdade. Este script baixa os
 * mesmos chunks de `leveling-extract-proto.js`, procura as âncoras de texto da
 * tela de atributos e imprime a vizinhança para leitura humana.
 *
 * Uso: node tools/leveling-extract-build-math.js [--base https://host]
 *                                                [--raio 1800] [--out arquivo]
 */

'use strict';

const fs = require('fs');

const DEFAULT_BASE = 'https://levelingidle2d.com.br';
const ENTRY_PATHS = ['/jogar', '/'];
const DEFAULT_RAIO = 1800;

/**
 * Âncoras em ordem de confiança. As de texto visível são as mais seguras: o
 * rótulo do botão só existe no componente que faz a distribuição. As de nome de
 * campo (`weights`, `initial_stats`) pegam o cálculo mesmo se a tradução mudar.
 */
const ANCORAS = [
  'Distribuir pela build',
  'DISTRIBUIR PELA BUILD',
  'distribuir pela build',
  'Pontos de atributo',
  'PONTOS DE ATRIBUTO',
  'pontos livres',
  'allocate_stats',
  'allocateStats',
  'remaining_points',
  'remainingPoints',
  'initial_stats',
  'initialStats',
  'class_base',
  'classBase',
  'statPoints',
  'stat_points_per_level',
  'statPointsPerLevel',
  'weights'
];

async function getText(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} em ${url}`);
  return res.text();
}

/** Mesma varredura de chunks do extrator de proto: HTML -> /assets/*.js -> ./*.js */
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

/**
 * O bundle é minificado numa linha só, então "contexto" é janela de caracteres,
 * não de linhas. Trechos que se sobrepõem viram um só para não imprimir a mesma
 * função cinco vezes — uma por âncora que caiu dentro dela.
 */
function janelas(text, ancora, raio) {
  const achados = [];
  let from = 0;
  for (;;) {
    const at = text.indexOf(ancora, from);
    if (at === -1) break;
    achados.push({ at, inicio: Math.max(0, at - raio), fim: Math.min(text.length, at + ancora.length + raio) });
    from = at + ancora.length;
    if (achados.length > 40) break;
  }
  return achados;
}

function fundir(janelasTodas) {
  const ordenadas = [...janelasTodas].sort((a, b) => a.inicio - b.inicio);
  const saida = [];
  for (const j of ordenadas) {
    const ultima = saida[saida.length - 1];
    if (ultima && j.inicio <= ultima.fim) {
      ultima.fim = Math.max(ultima.fim, j.fim);
      ultima.ancoras.push(...j.ancoras);
    } else {
      saida.push({ inicio: j.inicio, fim: j.fim, ancoras: [...j.ancoras] });
    }
  }
  return saida;
}

async function main() {
  const args = process.argv.slice(2);
  const argOf = name => {
    const i = args.indexOf(name);
    return i === -1 ? undefined : args[i + 1];
  };
  const base = (argOf('--base') || DEFAULT_BASE).replace(/\/$/, '');
  const raio = Number(argOf('--raio')) || DEFAULT_RAIO;
  const out = argOf('--out');

  process.stdout.write(`Baixando chunks de ${base}...\n`);
  const sources = await collectBundles(base);
  if (!sources.length) throw new Error('nenhum chunk JavaScript encontrado');
  process.stdout.write(`  ${sources.length} chunk(s) baixado(s)\n\n`);

  const partes = [];
  let total = 0;

  for (const { url, text } of sources) {
    const porChunk = [];
    for (const ancora of ANCORAS) {
      for (const j of janelas(text, ancora, raio)) {
        porChunk.push({ ...j, ancoras: [ancora] });
      }
    }
    if (!porChunk.length) continue;

    const fundidas = fundir(porChunk);
    total += fundidas.length;
    partes.push(`\n${'='.repeat(78)}\n${url}\n${'='.repeat(78)}`);
    for (const j of fundidas) {
      const unicas = [...new Set(j.ancoras)];
      partes.push(`\n--- offset ${j.inicio}..${j.fim} | âncoras: ${unicas.join(', ')} ---`);
      partes.push(text.slice(j.inicio, j.fim));
    }
  }

  if (!total) {
    process.stderr.write('nenhuma âncora encontrada; o bundle pode ter mudado os rótulos\n');
    process.exitCode = 1;
    return;
  }

  const texto = partes.join('\n');
  if (out) {
    fs.writeFileSync(out, texto + '\n', 'utf8');
    process.stdout.write(`${total} trecho(s) escrito(s) em ${out}\n`);
  } else {
    process.stdout.write(texto + '\n');
  }
}

main().catch(err => {
  process.stderr.write(`erro: ${err.message}\n`);
  process.exitCode = 1;
});

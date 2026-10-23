/**
 * @file account-preload.js
 * Preload da WebView de cada conta. Faz a sessão atravessar os dois modos.
 *
 * O cliente web guarda o token de sessão em `localStorage['leveling.session-token']`
 * e, se ele estiver lá, entra por `resume` em vez de pedir login. O monitor
 * headless recebe um token novo a cada `auth_ok` e o guarda cifrado no processo
 * principal — mas num armazenamento que a página não vê, porque o monitor nem
 * tem renderer.
 *
 * Este arquivo liga as duas pontas:
 *
 *   1. na entrada, grava o token conhecido antes de qualquer script do jogo
 *      rodar, para que sair do monitor devolva a conta já logada;
 *   2. na saída, avisa o principal quando a própria página troca o token
 *      (login manual, renovação), para que o monitor seguinte também entre por
 *      `resume`.
 *
 * Roda antes dos scripts da página, então o passo 1 chega a tempo. O principal
 * identifica a conta pela partição de sessão de quem chamou, não por um índice
 * vindo daqui.
 */

'use strict';

const { ipcRenderer } = require('electron');

const TOKEN_KEY = 'leveling.session-token';

/** Só a página do jogo; um iframe de anúncio ou de pagamento não recebe nada. */
function isGameOrigin() {
  try {
    return location.origin === 'https://levelingidle2d.com.br';
  } catch {
    return false;
  }
}

function seedToken() {
  let token = '';
  try {
    // Síncrono de propósito: assíncrono perderia a corrida com o bundle.
    token = ipcRenderer.sendSync('leveling:token:get') || '';
  } catch {
    return;
  }
  if (!token) return;

  try {
    // Sobrescreve sempre. O token do principal é o mais novo por construção: o
    // monitor o renova a cada `auth_ok` e o login da própria página é capturado
    // por `watchToken`. O que estiver no `localStorage` é de uma sessão que já
    // foi substituída, e tentar `resume` com ele só devolve a tela de login.
    window.localStorage.setItem(TOKEN_KEY, token);
  } catch {
    // localStorage bloqueado (modo restrito): a conta só pede login de novo.
  }
}

/**
 * Observa a chave em vez de pesquisar em intervalo: o `setItem` do jogo é o
 * único momento em que o token muda, e interceptá-lo não custa nada enquanto
 * nada acontece.
 */
function watchToken() {
  let storage;
  try {
    storage = window.localStorage;
    if (!storage) return;
  } catch {
    return;
  }

  const report = value => {
    try {
      ipcRenderer.send('leveling:token:set', value || '');
    } catch {}
  };

  const original = storage.setItem.bind(storage);
  const remove = storage.removeItem.bind(storage);

  try {
    storage.setItem = function (key, value) {
      original(key, value);
      if (key === TOKEN_KEY) report(value);
    };
    storage.removeItem = function (key) {
      remove(key);
      // Logout limpa a chave; o token guardado também não vale mais.
      if (key === TOKEN_KEY) report('');
    };
  } catch {
    // Storage congelado por alguma política: segue sem captura.
  }
}

if (isGameOrigin()) {
  seedToken();
  watchToken();
}

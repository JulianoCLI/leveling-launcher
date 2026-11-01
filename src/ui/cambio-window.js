/**
 * @file cambio-window.js
 * Liga o câmbio na sua janela própria.
 *
 * Mesma razão de `autosell-window.js`: `shell.js` monta painéis, WebViews,
 * bandeja e abas, e nada disso tem sentido numa janela que só mostra o ouro que
 * desceu pela cadeia. O que falta é entregar a API do preload ao módulo.
 */

(() => {
  'use strict';

  const api = window.pokeAPI;
  if (!api || !window.PioCambio) return;

  window.PioCambio.init(api).catch(() => {});

  // Esc fecha. O canal é o do mercado porque ele fecha a janela de quem pediu,
  // não a do mercado especificamente.
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && api.marketWindowClose) api.marketWindowClose();
  });
})();

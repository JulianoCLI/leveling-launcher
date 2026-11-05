/**
 * @file forge-window.js
 * Liga a auto-forja na sua janela própria.
 *
 * Mesma razão de `stats-window.js`: `shell.js` monta painéis, WebViews, bandeja
 * e abas, e nada disso tem sentido numa janela que só mostra a grade de slots e
 * o custo da próxima fusão. O que falta é entregar a API do preload ao módulo.
 */

(() => {
  'use strict';

  const api = window.pokeAPI;
  if (!api || !window.PioForge) return;

  window.PioForge.init(api).catch(() => {});

  // Esc fecha. O canal é o do mercado porque ele fecha a janela de quem pediu,
  // não a do mercado especificamente.
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && api.marketWindowClose) api.marketWindowClose();
  });
})();

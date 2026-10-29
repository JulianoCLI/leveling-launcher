/**
 * @file sniper-window.js
 * Liga o sniper na sua janela própria.
 *
 * Mesma razão de `market-window.js`: `shell.js` monta painéis, WebViews,
 * bandeja e abas, e nada disso tem sentido numa janela que só mostra regras e
 * log. O que falta é entregar a API do preload ao módulo e abrir.
 */

(() => {
  'use strict';

  const api = window.pokeAPI;
  if (!api || !window.PioSniper) return;

  window.PioSniper.init(api).catch(() => {});

  // Esc fecha. O canal é o mesmo do mercado porque ele fecha a janela de quem
  // pediu, não a do mercado especificamente.
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && api.marketWindowClose) api.marketWindowClose();
  });
})();

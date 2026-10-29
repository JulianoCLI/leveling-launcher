/**
 * @file expedition-window.js
 * Liga a auto-expedição na sua janela própria.
 *
 * Mesma razão de `sniper-window.js`: `shell.js` monta painéis, WebViews,
 * bandeja e abas, e nada disso tem sentido numa janela que só mostra prazos.
 * O que falta é entregar a API do preload ao módulo.
 */

(() => {
  'use strict';

  const api = window.pokeAPI;
  if (!api || !window.PioExpedition) return;

  window.PioExpedition.init(api).catch(() => {});

  // Esc fecha. O canal é o do mercado porque ele fecha a janela de quem pediu,
  // não a do mercado especificamente.
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && api.marketWindowClose) api.marketWindowClose();
  });
})();

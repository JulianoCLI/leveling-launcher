/**
 * @file market-window.js
 * Liga o mercado quando ele é a janela inteira, não um modal.
 *
 * `shell.js` não é carregado aqui de propósito: ele monta painéis, WebViews do
 * jogo, bandeja, abas e teclas globais — nada disso tem sentido numa janela que
 * só mostra preços, e carregá-lo criaria uma segunda cópia de tudo isso
 * disputando o mesmo estado com a janela principal.
 *
 * Então o que falta é só o que `shell.js` fazia pelo mercado: entregar a API
 * do preload ao módulo e abrir. O resto do comportamento — abas, filtros,
 * coletor, repintura — já está em `leveling-market-ui.js` e é o mesmo código
 * nos dois lugares.
 */

(() => {
  'use strict';

  const api = window.pokeAPI;
  if (!api || !window.PioMarket) return;

  window.PioMarket.init(api);
  window.PioMarket.open().catch(() => {});

  // Esc fecha a janela. Numa janela sem moldura é o único atalho que o usuário
  // já espera que exista, e aqui não há pilha de modais para desempilhar.
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && api.marketWindowClose) api.marketWindowClose();
  });
})();

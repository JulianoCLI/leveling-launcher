/**
 * @file proxies-window.js
 * O pool de proxies, na sua própria janela.
 *
 * Como `market-window.js`, não carrega `shell.js`: não há painel nem WebView
 * aqui. O trabalho de verdade — normalizar, deduplicar, atribuir vaga, testar
 * — vive em `src/domain/leveling-proxy-pool.js` e nos handlers do processo
 * principal. Esta janela só mostra e comanda.
 */

(() => {
  'use strict';

  const api = window.pokeAPI;
  if (!api) return;

  const $ = id => document.getElementById(id);

  const entrada = $('proxyInput');
  const lista = $('proxyList');
  const resumo = $('proxySummary');
  const status = $('proxyStatus');

  /** Evita que dois testes em massa rodem ao mesmo tempo. */
  let ocupado = false;

  const texto = (tag, className, conteudo) => {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (conteudo != null) el.textContent = conteudo;
    return el;
  };

  function mostrarStatus(msg, erro) {
    status.textContent = msg || '';
    status.classList.toggle('err', !!erro);
  }

  /** Trava os botões enquanto algo está em voo, para não empilhar pedidos. */
  function travar(v) {
    ocupado = v;
    $('proxyImport').disabled = v;
    $('proxyTestAll').disabled = v;
  }

  const ROTULO = {
    ok: 'ok',
    fail: 'falhou',
    pending: 'não testado',
    duplicate: 'IP repetido'
  };

  async function carregar() {
    let dados;
    try {
      dados = await api.levelingProxyPool();
    } catch (e) {
      mostrarStatus(`Não foi possível ler o pool: ${e.message}`, true);
      return;
    }
    pintar(dados);
  }

  function pintar(dados) {
    const proxies = (dados && dados.proxies) || [];
    const cap = (dados && dados.capacity) || { total: 0, used: 0, free: 0 };
    const falhas = proxies.filter(p => p.status === 'fail').length;
    const repetidos = proxies.filter(p => p.status === 'duplicate').length;

    // O resumo diz as três coisas que decidem se dá para ligar mais um monitor.
    const partes = [
      `${proxies.length} proxy(s)`,
      `${cap.used}/${cap.total} vagas usadas`,
      `${cap.free} livre(s)`
    ];
    if (falhas) partes.push(`${falhas} falhando`);
    if (repetidos) partes.push(`${repetidos} com IP repetido`);
    resumo.textContent = partes.join(' · ');

    lista.textContent = '';

    if (!proxies.length) {
      lista.append(texto('p', 'proxyEmpty', 'Nenhum proxy importado ainda.'));
      return;
    }

    for (const p of proxies) {
      const linha = texto('div', 'proxyRow');

      linha.append(texto('span', 'proxyRowLabel', p.label));
      linha.append(texto('span', `proxyRowState is-${p.status}`, ROTULO[p.status] || p.status));
      linha.append(texto('span', 'proxyRowIp', p.ip || '—'));
      linha.append(texto('span', 'proxyRowSlots', `${p.assignedCount}/2 contas`));

      if (p.error) linha.append(texto('span', 'proxyRowErr', p.error));

      const testar = texto('button', 'proxyRowBtn', 'Testar');
      testar.type = 'button';
      testar.addEventListener('click', () => testarUm(p.id));
      linha.append(testar);

      const remover = texto('button', 'proxyRowBtn danger', 'Remover');
      remover.type = 'button';
      remover.addEventListener('click', () => removerUm(p));
      linha.append(remover);

      lista.append(linha);
    }
  }

  /**
   * Importa e já testa o que entrou.
   *
   * Testar na importação não é zelo extra: um proxy sem status `ok` não recebe
   * conta nenhuma, então importar sem testar deixaria o pool parecendo cheio e
   * sem vaga utilizável.
   */
  async function importar() {
    const txt = entrada.value.trim();
    if (!txt) {
      mostrarStatus('Cole pelo menos um proxy.', true);
      return;
    }

    travar(true);
    try {
      const r = await api.levelingProxyImport(txt);
      const partes = [`${r.added.length} importado(s)`];
      if (r.duplicates.length) partes.push(`${r.duplicates.length} já estavam no pool`);
      if (r.invalid.length) partes.push(`${r.invalid.length} inválido(s)`);
      mostrarStatus(partes.join(' · '));
      entrada.value = '';
      await carregar();

      // Só os que acabaram de entrar: retestar o pool inteiro a cada
      // importação ficaria lento à medida que ele cresce.
      if (r.added.length) await testarVarios(r.added.map(p => p.id));
    } catch (e) {
      mostrarStatus(`Falha ao importar: ${e.message}`, true);
    } finally {
      travar(false);
    }
  }

  async function testarUm(id) {
    if (ocupado) return;
    travar(true);
    try {
      const r = await api.levelingProxyTest(id);
      mostrarStatus(r.status === 'ok' ? `Respondeu de ${r.ip}` : `Falhou: ${r.error}`, r.status !== 'ok');
      await carregar();
    } catch (e) {
      mostrarStatus(`Falha ao testar: ${e.message}`, true);
    } finally {
      travar(false);
    }
  }

  /** Em série de propósito: em paralelo os proxies disputam a banda e falham por timeout. */
  async function testarVarios(ids) {
    let feitos = 0;
    for (const id of ids) {
      mostrarStatus(`Testando ${++feitos} de ${ids.length}…`);
      try {
        await api.levelingProxyTest(id);
      } catch { /* o status do proxy já registra a falha */ }
      await carregar();
    }
    mostrarStatus(`${ids.length} proxy(s) testado(s).`);
  }

  async function testarTodos() {
    if (ocupado) return;
    travar(true);
    try {
      const dados = await api.levelingProxyPool();
      const ids = ((dados && dados.proxies) || []).map(p => p.id);
      if (!ids.length) {
        mostrarStatus('Nada para testar.', true);
        return;
      }
      await testarVarios(ids);
    } finally {
      travar(false);
    }
  }

  /**
   * Remove um proxy, avisando se isso vai desalojar contas.
   *
   * A confirmação só aparece quando há conta atribuída: pedir confirmação para
   * remover um proxy que nada usa é só mais um clique.
   */
  async function removerUm(p) {
    if (p.assignedCount > 0) {
      const ok = window.confirm(
        `${p.label} está com ${p.assignedCount} conta(s). `
        + 'Removê-lo deixa essas contas sem rota até que você as reatribua. Continuar?'
      );
      if (!ok) return;
    }

    try {
      await api.levelingProxyRemove(p.id);
      mostrarStatus('Proxy removido.');
      await carregar();
    } catch (e) {
      mostrarStatus(`Falha ao remover: ${e.message}`, true);
    }
  }

  $('proxyImport').addEventListener('click', importar);
  $('proxyTestAll').addEventListener('click', testarTodos);
  $('proxyClose').addEventListener('click', () => api.proxiesWindowClose && api.proxiesWindowClose());

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && api.proxiesWindowClose) api.proxiesWindowClose();
  });

  carregar();
})();

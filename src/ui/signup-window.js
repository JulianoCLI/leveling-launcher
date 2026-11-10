/**
 * @file signup-window.js
 * O assistente de cadastro, na sua própria janela.
 *
 * Como `market-window.js`, esta página não carrega `shell.js`: não há painel,
 * WebView nem bandeja aqui, e carregá-lo criaria uma segunda cópia do launcher
 * disputando o mesmo estado.
 *
 * Toda regra de nome, senha e email vive em `src/domain/leveling-signup.js` e
 * roda no processo principal. Esta janela não revalida nada por conta própria:
 * duplicar a regra em dois lugares é como elas passam a divergir. Ela pede o
 * plano, mostra o que voltou e deixa claro onde o cadastro realmente termina.
 */

(() => {
  'use strict';

  const api = window.pokeAPI;
  if (!api) return;

  const $ = id => document.getElementById(id);

  const campos = {
    prefix: $('signupPrefix'),
    count: $('signupCount'),
    start: $('signupStart'),
    email: $('signupEmail'),
    gender: $('signupGender'),
    classId: $('signupClass'),
    referral: $('signupReferral')
  };

  const resumo = $('signupPlanSummary');
  const problemas = $('signupPlanProblems');
  const fila = $('signupQueue');
  const status = $('signupStatus');

  /** O plano que está na tela, para o botão de guardar saber se há o que guardar. */
  let planoAtual = { items: [], invalid: [] };

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

  /**
   * Pede o plano ao processo principal e repinta.
   *
   * Roda a cada digitação: o custo é um IPC e a geração de algumas senhas, e
   * em troca o usuário vê o nome que vai sair antes de se comprometer.
   */
  async function montarPlano() {
    let r;
    try {
      r = await api.levelingSignupPlan({
        prefix: campos.prefix.value,
        count: Number(campos.count.value) || 0,
        start: Number(campos.start.value) || 0,
        gender: Number(campos.gender.value) || 1,
        classId: campos.classId.value,
        referral: campos.referral.value,
        emailTemplate: campos.email.value
      });
    } catch (e) {
      mostrarStatus(`Não foi possível montar o plano: ${e.message}`, true);
      return;
    }

    planoAtual = r;
    pintarResumo();
    pintarProblemas();
    pintarFila();
  }

  function pintarResumo() {
    const n = planoAtual.items.length;
    const maus = planoAtual.invalid.length;
    resumo.textContent = maus
      ? `${n} conta(s) prontas · ${maus} recusada(s)`
      : `${n} conta(s) prontas`;
  }

  /**
   * Mostra o motivo de cada recusa.
   *
   * Esconder a linha inválida seria pior que mostrá-la: o usuário pediria 20
   * contas, receberia 14 e não saberia o que mudar no prefixo.
   */
  function pintarProblemas() {
    problemas.textContent = '';
    if (!planoAtual.invalid.length) {
      problemas.hidden = true;
      return;
    }
    problemas.hidden = false;
    for (const mau of planoAtual.invalid) {
      const linha = texto('p', 'signupProblem');
      linha.append(texto('strong', null, mau.username || '(vazio)'));
      linha.append(texto('span', null, ` — ${mau.reasons.join('; ')}`));
      problemas.append(linha);
    }
  }

  function pintarFila() {
    fila.textContent = '';

    if (!planoAtual.items.length) {
      fila.append(texto('p', 'signupEmpty', 'Nada na fila. Ajuste o plano acima.'));
      return;
    }

    for (const item of planoAtual.items) {
      const linha = texto('div', 'signupRow');
      linha.append(texto('span', 'signupRowName', item.username));
      linha.append(texto('span', 'signupRowMail', item.email));
      linha.append(texto('span', 'signupRowState', 'abre em janela própria'));
      fila.append(linha);
    }
  }

  /**
   * Guarda o plano nas credenciais.
   *
   * Guardar não cria conta: é o passo que permite à aba do jogo preencher o
   * formulário depois. O texto do botão e do aviso dizem isso, porque um
   * "pronto!" aqui faria o usuário achar que as contas já existem.
   */
  async function guardar() {
    if (!planoAtual.items.length) {
      mostrarStatus('Monte um plano válido antes de guardar.', true);
      return;
    }

    let r;
    try {
      r = await api.levelingSignupSave();
    } catch (e) {
      mostrarStatus(`Não foi possível guardar: ${e.message}`, true);
      return;
    }

    if (!r || !r.ok) {
      mostrarStatus((r && r.error) || 'Não foi possível guardar o plano.', true);
      return;
    }

    const partes = [
      `${r.saved.length} credencial(is) guardada(s).`,
      `Abriu ${r.saved.length === 1 ? 'uma janela' : r.saved.length + ' janelas'} de cadastro,`
      + ' cada uma já na rota da conta e com o formulário preenchido.'
      + ' Resolva o captcha e envie: a janela fecha sozinha e a conta fica logada no painel.'
    ];
    if (r.semProxy && r.semProxy.length) {
      partes.push(
        `${r.semProxy.join(', ')} vai sair pelo IP da máquina — permitido só nas`
        + ' duas primeiras contas.'
      );
    }
    if (r.recusadas && r.recusadas.length) {
      partes.push(
        `Recusadas por falta de proxy funcional: ${r.recusadas.join(', ')}.`
        + ' Cada proxy aprovado no pool abre duas contas.'
      );
    }
    const alerta = !!((r.semProxy && r.semProxy.length) || (r.recusadas && r.recusadas.length));
    mostrarStatus(partes.join(' '), alerta);
    // O plano foi consumido; pedir outro evita guardar duas vezes o mesmo.
    montarPlano();
  }

  for (const campo of Object.values(campos)) {
    campo.addEventListener('input', montarPlano);
    campo.addEventListener('change', montarPlano);
  }

  /**
   * Preenche o seletor de classe com a lista do domínio.
   *
   * A lista não está no HTML porque ela tem uma fonte: os ids vieram do bundle
   * do jogo. Repeti-los na marcação criaria uma segunda cópia para divergir.
   */
  async function carregarClasses() {
    let classes = [];
    try {
      classes = await api.levelingSignupClasses();
    } catch { /* o seletor fica vazio; o plano segue sem classe */ }

    for (const c of classes) {
      const op = document.createElement('option');
      op.value = c.id;
      op.textContent = c.name;
      campos.classId.append(op);
    }
  }

  $('signupSave').addEventListener('click', guardar);
  $('signupClose').addEventListener('click', () => api.signupWindowClose && api.signupWindowClose());

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && api.signupWindowClose) api.signupWindowClose();
  });

  carregarClasses().then(montarPlano);
})();

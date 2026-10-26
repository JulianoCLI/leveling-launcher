/**
 * @file leveling-party.js
 * Monta um grupo com as contas de uma aba, numa ordem medida contra o servidor.
 *
 * Tudo aqui saiu de `tools/party-probe.js`, `tools/party-create-probe.js` e
 * `tools/party-hunt-probe.js`, rodados contra o servidor de verdade. O que foi
 * medido, e que explica cada passo da ordem abaixo:
 *
 *   1. `party_request{create}` responde `party_response` com o estado já
 *      pronto, inclusive `settings.code` — não é preciso pedir `new_code`.
 *   2. `create` falha com `party.exists` se a conta já está em grupo, então o
 *      grupo antigo tem de ser desfeito primeiro.
 *   3. `leave` tira o membro da caçada e o manda para a cidade: o servidor
 *      responde `notice{party.left.to_city}`. Entrar num grupo novo **não** o
 *      devolve à caçada.
 *   4. `invite` por nome funciona do líder para cada conta; o convidado recebe
 *      `party_push{invite}` e entra com `answer{from_account, accept}`. O
 *      caminho por `join_code` existe, mas convidar por nome dispensa carregar
 *      o código de uma conta para outra.
 *   5. `start_hunt` do líder arrasta o grupo inteiro para a caçada dele: cada
 *      membro recebe `notice{party.follow.pulled}` e um `scene_enter` de
 *      caçada em ~150 ms. É isto que repara o passo 3, e é por isso que o
 *      ciclo termina sempre com um `start_hunt` do líder.
 *   6. `ClientMessage.verify` recusa o **nome** do enum e aceita só o número:
 *      `privacy: 'PARTY_PRIVACY_OPEN'` dá `enum value expected`.
 *
 * Nenhum passo escolhe caçada: o `start_hunt` final devolve exatamente o
 * `gate_id`/`tier_min`/`difficulty` que o líder já estava fazendo.
 */

'use strict';

/** Medido: só o número passa pelo `verify` do codec. */
const PARTY_PRIVACY = {
  REQUEST: 0,
  OPEN: 1,
  CLOSED: 2
};

/**
 * Grupo de contas do mesmo dono, então fechado por padrão: aberto deixaria
 * desconhecidos entrarem e ocuparem a vaga de uma das quatro contas.
 */
function defaultSettings(capacity = 4) {
  return {
    privacy: PARTY_PRIVACY.CLOSED,
    capacity,
    objective: 'Launcher',
    auto_accept_friends: true,
    auto_accept_guild: true
  };
}

/**
 * O grupo tem id válido? `0` e vazio significam "sem grupo".
 *
 * Aceita as duas formas do mesmo dado: `party_id`, como o servidor manda, e
 * `id`, como `applyParty` guarda no estado do painel. Ler só uma delas faria
 * esta função dizer "sem grupo" para um grupo existente.
 */
function hasParty(state) {
  if (!state) return false;
  const raw = state.party_id != null ? state.party_id : state.id;
  const id = raw != null ? String(raw) : '';
  return !!id && id !== '0';
}

/**
 * A conta é a líder do grupo em que está? Só ela pode convidar e desfazer.
 *
 * Aceita as duas formas do mesmo dado, pelo mesmo motivo de `hasParty`:
 * `account_id`, como o servidor manda, e `accountId`, como `applyParty` guarda
 * no estado do painel. Ler só a primeira fazia esta função dizer "não é líder"
 * para a líder, sempre que recebia o estado reduzido.
 */
function isLeader(state, accountId) {
  if (!hasParty(state) || accountId == null) return false;
  const alvo = String(accountId);
  return (state.members || []).some(m => {
    if (!m || !m.leader) return false;
    const id = m.account_id != null ? m.account_id : m.accountId;
    return String(id) === alvo;
  });
}

/**
 * Monta o grupo. `clients` são monitores já conectados, em ordem de aba: o
 * primeiro vira líder, porque é o painel 1 da aba e é a referência que o
 * usuário vê.
 *
 * @param {object[]} clients  monitores conectados, com a API de grupo do
 *   `LevelingHeadlessClient`.
 * @param {function} [onStep] recebe cada passo, para a interface narrar.
 * @returns {Promise<object>} resultado com `ok`, `partyId`, `code`, `members`.
 */
async function assembleParty(clients, onStep = () => {}) {
  // `code` nomeia a etapa, e o código de convite do grupo vai em `partyCode`:
  // chamar os dois de `code` fazia o do grupo sobrescrever o da etapa, e a
  // interface mostrava o convite onde devia estar o nome do passo.
  const step = (code, data = {}) => onStep({ ...data, code });

  if (!Array.isArray(clients) || clients.length < 2) {
    return { ok: false, error: 'party.needTwo', members: [] };
  }

  const leader = clients[0];
  const members = clients.slice(1);

  // --------------------------------------------------- 1. ler o estado atual
  step('party.reading');
  for (const client of clients) {
    // Convites de uma montagem anterior não valem para esta: guardá-los faria
    // `waitForInvite` aceitar um convite velho e responder ao líder errado.
    if (client.forgetInvites) client.forgetInvites();
    await client.partyGet().catch(() => null);
  }

  // O bilhete de volta, lido **antes** de mexer no grupo: é o que devolve
  // todos à caçada no fim. Sem ele o grupo terminaria parado na cidade.
  const ticket = leader.getHuntTicket();

  // ------------------------------------------------- 2. desfazer o grupo atual
  // `create` é recusado com a conta já em grupo, e `leave` de cada membro
  // custa a ida à cidade — daí o passo 5 ser obrigatório.
  const antigo = [];
  for (const client of members) {
    if (!hasParty(client.state.party)) continue;
    step('party.leaving', { index: client.index, name: client.state.name });
    await client.partyLeave().catch(() => null);
    antigo.push(client.index);
  }
  if (hasParty(leader.state.party)) {
    step('party.disbanding', { index: leader.index, name: leader.state.name });
    // Desfazer em vez de sair: sair passaria a liderança a outra conta da aba,
    // que então recusaria o `create` do líder por já estar em grupo.
    const acao = isLeader(leader.state.party, leader.state.accountId)
      ? leader.partyDisband()
      : leader.partyLeave();
    await acao.catch(() => null);
  }

  // ------------------------------------------------------------- 3. criar
  step('party.creating', { index: leader.index, name: leader.state.name });
  const criado = await leader.partyCreate(defaultSettings(clients.length));
  if (!hasParty(criado)) {
    return {
      ok: false,
      error: (criado && criado.errorCode) || 'party.createFailed',
      members: [],
      movedToCity: antigo
    };
  }

  const partyId = String(criado.party_id);
  const code = (criado.settings && criado.settings.code) || '';
  step('party.created', { partyId, partyCode: code });

  // ------------------------------------------------------------ 4. convidar
  // Em série: o servidor confirma cada entrada com um `party_push`, e convidar
  // em paralelo misturaria as confirmações sem ganhar tempo mensurável.
  const entraram = [];
  const falharam = [];
  for (const client of members) {
    step('party.inviting', { index: client.index, name: client.state.name });

    let convite = await leader.partyInvite(client.state.name).catch(err => ({ errorCode: err.message }));

    // `party.invite.already`: o servidor guarda um convite pendente para esta
    // conta, de uma montagem anterior que não chegou ao `answer`. Ele não some
    // sozinho antes de expirar, e enquanto existir todo `invite` novo é
    // recusado — era isto que deixava as contas de fora da PT recém-criada.
    //
    // O convite velho é de um grupo que já não existe, então aceitá-lo não
    // serve: ele é descartado dos dois lados e o convite é refeito.
    if (convite && convite.errorCode === 'party.invite.already') {
      await leader.partyInviteCancel(client.state.accountId).catch(() => null);
      await client.partyDecline(leader.state.accountId).catch(() => null);
      if (client.forgetInvites) client.forgetInvites();
      convite = await leader.partyInvite(client.state.name).catch(err => ({ errorCode: err.message }));
    }

    if (convite && convite.errorCode) {
      falharam.push({ index: client.index, name: client.state.name, error: convite.errorCode });
      continue;
    }

    // O convidado só pode responder depois de o convite chegar nele.
    const recebido = await client.waitForInvite(leader.state.accountId, 8000);
    if (!recebido) {
      falharam.push({ index: client.index, name: client.state.name, error: 'party.inviteNotReceived' });
      continue;
    }

    const estado = await client.partyAnswer(leader.state.accountId, true).catch(err => ({ errorCode: err.message }));
    if (!hasParty(estado)) {
      falharam.push({
        index: client.index,
        name: client.state.name,
        error: (estado && estado.errorCode) || 'party.joinFailed'
      });
      continue;
    }
    entraram.push({ index: client.index, name: client.state.name });
    step('party.joined', { index: client.index, name: client.state.name });
  }

  // ------------------------------------------- 5. devolver todos à caçada
  // O passo que fecha o ciclo: `leave` mandou os membros para a cidade, e só
  // um `start_hunt` do líder os puxa de volta. Sem isto o grupo ficaria montado
  // e rendendo nada, que é pior do que não ter mexido.
  let huntError = '';
  if (ticket) {
    step('party.pulling', { gateId: ticket.gate_id });
    const puxou = await leader.startHunt(ticket).catch(err => ({ errorCode: err.message }));
    if (puxou && puxou.errorCode) huntError = puxou.errorCode;
  } else if (antigo.length) {
    // Tirou contas da caçada e não tem como devolvê-las: precisa aparecer.
    huntError = 'party.noHuntTicket';
  }

  const estadoFinal = await leader.partyGet().catch(() => null);

  return {
    ok: !falharam.length && !huntError,
    partyId,
    code,
    leader: { index: leader.index, name: leader.state.name },
    members: entraram,
    failed: falharam,
    huntError: huntError || undefined,
    gateId: ticket ? ticket.gate_id : '',
    size: hasParty(estadoFinal) ? (estadoFinal.members || []).length : entraram.length + 1
  };
}

module.exports = {
  PARTY_PRIVACY,
  defaultSettings,
  hasParty,
  isLeader,
  assembleParty
};

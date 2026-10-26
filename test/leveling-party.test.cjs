const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  PARTY_PRIVACY,
  defaultSettings,
  hasParty,
  isLeader,
  assembleParty
} = require('../src/domain/leveling-party');

/**
 * Dublê de monitor conectado. Reproduz só o que `assembleParty` usa, e registra
 * a ordem exata dos pacotes: a ordem é o que foi medido contra o servidor, e é
 * o que estes testes protegem.
 *
 * O comportamento imitado aqui é o observado em `tools/party-create-probe.js` e
 * `tools/party-hunt-probe.js`:
 *   - `leave` tira a conta da caçada (`party.left.to_city`);
 *   - `create` já devolve o estado com `settings.code`;
 *   - `invite` faz o convite chegar ao convidado, que entra com `answer`;
 *   - `start_hunt` do líder puxa o grupo todo de volta.
 */
class FakeClient {
  constructor(index, name, accountId, options = {}) {
    this.index = index;
    this.log = options.log || [];
    this.huntTicket = options.hunt !== undefined
      ? options.hunt
      : { gate_id: 'ilha-jeju', tier_min: 41, difficulty: 'normal' };
    this.failInvite = options.failInvite || null;
    this.failCreate = options.failCreate || null;
    this.failAnswer = options.failAnswer || null;
    this.failHunt = options.failHunt || null;
    this.noInvite = !!options.noInvite;
    this.inCity = false;
    this.party = options.party || null;
    this.state = {
      name,
      accountId: String(accountId),
      party: this.party || { id: '', maxMembers: 0, members: [] }
    };
    /** Grupo compartilhado entre os dublês, como o servidor faz. */
    this.shared = options.shared || null;
  }

  record(op, extra) {
    this.log.push(extra ? `${this.index}:${op}:${extra}` : `${this.index}:${op}`);
  }

  async partyGet() {
    this.record('get');
    // O servidor devolve o estado com os membros; o `shared` é esse estado.
    if (this.shared && String(this.shared.party_id) === String(this.state.party.id)) return this.shared;
    return this.state.party.id
      ? { party_id: this.state.party.id, members: this.state.party.members || [] }
      : {};
  }

  async partyLeave() {
    this.record('leave');
    // Medido: sair do grupo manda a conta para a cidade.
    this.inCity = true;
    this.state.party = { id: '', maxMembers: 0, members: [] };
    return {};
  }

  async partyDisband() {
    this.record('disband');
    this.state.party = { id: '', maxMembers: 0, members: [] };
    return {};
  }

  async partyCreate(settings) {
    this.record('create', `privacy=${settings.privacy},cap=${settings.capacity}`);
    if (this.failCreate) return { errorCode: this.failCreate };
    this.createdWith = settings;
    this.shared = {
      party_id: '11611',
      max_members: settings.capacity,
      members: [{ account_id: this.state.accountId, name: this.state.name, leader: true }],
      settings: { ...settings, code: '7J7FM3' }
    };
    this.state.party = { id: '11611', maxMembers: settings.capacity, members: [] };
    return this.shared;
  }

  async partyInvite(name) {
    this.record('invite', name);
    if (this.failInvite === name) return { errorCode: 'party.full' };
    const alvo = (this.peers || []).find(p => p.state.name === name);

    // Convite pendente de uma montagem anterior: o servidor recusa o novo até
    // ele ser cancelado. É o `party.invite.already` que deixava contas de fora.
    if (alvo && alvo.stuckInvite) return { errorCode: 'party.invite.already' };

    if (alvo && !alvo.noInvite) alvo.pendingInvite = { from_account: this.state.accountId };
    return {};
  }

  async partyInviteCancel(accountId) {
    this.record('inviteCancel', String(accountId));
    const alvo = (this.peers || []).find(p => String(p.state.accountId) === String(accountId));
    if (alvo) alvo.stuckInvite = false;
    return {};
  }

  async partyDecline(fromAccount) {
    this.record('decline', String(fromAccount));
    this.stuckInvite = false;
    this.pendingInvite = null;
    return {};
  }

  // Sem `record`: não é pacote, é limpeza local, e não entra na ordem medida.
  forgetInvites() {
    this.pendingInvite = null;
  }

  async waitForInvite(fromAccount, _timeoutMs) {
    this.record('waitInvite');
    const invite = this.pendingInvite;
    if (!invite || String(invite.from_account) !== String(fromAccount)) return null;
    this.pendingInvite = null;
    return invite;
  }

  async partyAnswer(fromAccount, accept) {
    this.record('answer', `from=${fromAccount},accept=${accept}`);
    if (this.failAnswer) return { errorCode: this.failAnswer };
    const leader = (this.peers || []).find(p => String(p.state.accountId) === String(fromAccount));
    if (leader && leader.shared) {
      leader.shared.members.push({
        account_id: this.state.accountId,
        name: this.state.name,
        leader: false
      });
      this.state.party = { id: leader.shared.party_id, maxMembers: 4, members: [] };
      return leader.shared;
    }
    return {};
  }

  async startHunt(ticket) {
    this.record('startHunt', `${ticket.gate_id}/${ticket.tier_min}/${ticket.difficulty}`);
    if (this.failHunt) return { errorCode: this.failHunt };
    // Medido: o start_hunt do líder arrasta o grupo inteiro.
    this.inCity = false;
    for (const p of this.peers || []) p.inCity = false;
    return { scene_id: ticket.gate_id };
  }

  getHuntTicket() {
    return this.huntTicket ? { ...this.huntTicket } : null;
  }
}

/** Quatro contas, a primeira já em caçada e todas já num grupo antigo. */
function quatro(options = {}) {
  const log = [];
  const nomes = ['desjunior', 'desjuli', 'muvinlax', 'sertralina20mg'];
  const ids = [12920, 12927, 13043, 13040];
  const clients = nomes.map((name, i) => new FakeClient(i, name, ids[i], {
    log,
    // O grupo antigo real tem membros, e a conta 0 é a líder dele: sem isso
    // `isLeader` diria não e o líder sairia em vez de desfazer.
    party: options.semGrupoAntigo ? null : {
      id: '11538',
      maxMembers: 4,
      members: ids.map((id, j) => ({ account_id: String(id), name: nomes[j], leader: j === 0 }))
    },
    ...(options.each ? options.each(i) : {})
  }));
  for (const c of clients) c.peers = clients;
  return { clients, log };
}

test('privacidade padrão é fechada, com o número do enum', () => {
  // Medido: `ClientMessage.verify` recusa o nome do enum. E o grupo é de contas
  // do mesmo dono, então aberto deixaria estranhos ocuparem a vaga.
  const settings = defaultSettings(4);
  assert.equal(settings.privacy, PARTY_PRIVACY.CLOSED);
  assert.equal(typeof settings.privacy, 'number');
  assert.equal(settings.capacity, 4);
});

test('hasParty trata id ausente e id zero como sem grupo', () => {
  assert.equal(hasParty(null), false);
  assert.equal(hasParty({}), false);
  assert.equal(hasParty({ party_id: '0' }), false);
  assert.equal(hasParty({ party_id: 0 }), false);
  assert.equal(hasParty({ party_id: '11611' }), true);
});

test('isLeader só aceita o membro marcado como líder', () => {
  const state = {
    party_id: '11611',
    members: [
      { account_id: '12920', leader: true },
      { account_id: '12927' }
    ]
  };
  assert.equal(isLeader(state, '12920'), true);
  assert.equal(isLeader(state, 12920), true);
  assert.equal(isLeader(state, '12927'), false);
  assert.equal(isLeader(state, null), false);
  assert.equal(isLeader({}, '12920'), false);
});

test('isLeader também lê o estado reduzido do painel', () => {
  // `applyParty` guarda `id`/`accountId`, não `party_id`/`account_id`. Ler só a
  // forma do servidor fazia esta função dizer "não é líder" para a líder, e a
  // troca de caçada em grupo então mandava `start_hunt` para cada membro.
  const painel = {
    id: '11611',
    members: [
      { accountId: '12920', leader: true },
      { accountId: '12927', leader: false }
    ]
  };
  assert.equal(isLeader(painel, '12920'), true);
  assert.equal(isLeader(painel, '12927'), false);
});

test('menos de duas contas não monta grupo', async () => {
  const { clients } = quatro();
  const result = await assembleParty(clients.slice(0, 1));
  assert.equal(result.ok, false);
  assert.equal(result.error, 'party.needTwo');
});

test('monta o grupo das quatro contas e devolve id e código', async () => {
  const { clients } = quatro();
  const result = await assembleParty(clients);

  assert.equal(result.ok, true);
  assert.equal(result.partyId, '11611');
  assert.equal(result.code, '7J7FM3');
  assert.equal(result.size, 4);
  assert.equal(result.leader.name, 'desjunior');
  assert.deepEqual(result.members.map(m => m.name), ['desjuli', 'muvinlax', 'sertralina20mg']);
  assert.deepEqual(result.failed, []);
  assert.equal(result.huntError, undefined);
});

test('a ordem dos pacotes é a medida: ler, desfazer, criar, convidar, puxar', async () => {
  const { clients, log } = quatro();
  await assembleParty(clients);

  assert.deepEqual(log, [
    // 1. ler o estado de cada conta
    '0:get', '1:get', '2:get', '3:get',
    // 2. desfazer o grupo antigo: membros saem, líder desfaz
    '1:leave', '2:leave', '3:leave', '0:disband',
    // 3. criar já com a privacidade fechada
    '0:create:privacy=2,cap=4',
    // 4. convidar em série, cada convidado esperando o convite chegar
    '0:invite:desjuli', '1:waitInvite', '1:answer:from=12920,accept=true',
    '0:invite:muvinlax', '2:waitInvite', '2:answer:from=12920,accept=true',
    '0:invite:sertralina20mg', '3:waitInvite', '3:answer:from=12920,accept=true',
    // 5. o start_hunt do líder puxa todos de volta à caçada
    '0:startHunt:ilha-jeju/41/normal',
    // conferência final
    '0:get'
  ]);
});

test('convite pendente antigo é cancelado e refeito, não vira conta de fora', async () => {
  // O erro que o usuário via: `party.invite.already` em três contas de uma vez,
  // porque uma montagem anterior deixou convites pendentes no servidor. Eles
  // não expiram na hora, e enquanto existirem todo `invite` novo é recusado —
  // a PT era criada vazia.
  const { clients, log } = quatro();
  for (const c of clients.slice(1)) c.stuckInvite = true;

  const result = await assembleParty(clients);

  assert.equal(result.ok, true);
  assert.deepEqual(result.failed, []);
  assert.equal(result.size, 4);
  assert.deepEqual(result.members.map(m => m.name), ['desjuli', 'muvinlax', 'sertralina20mg']);

  // Cancelado dos dois lados antes de reconvidar: só do lado do líder o
  // servidor ainda guardaria o convite no inbox do convidado.
  const desjuli = ['0:invite:desjuli', '0:inviteCancel:12927', '1:decline:12920'];
  assert.deepEqual(log.filter(l => desjuli.includes(l)), [
    '0:invite:desjuli', '0:inviteCancel:12927', '1:decline:12920', '0:invite:desjuli'
  ]);
});

test('convite que segue recusado depois do cancelamento vira falha reportada', async () => {
  // O cancelamento é uma tentativa, não uma garantia: se o servidor continuar
  // recusando, a conta tem de aparecer em `failed` em vez de sumir.
  const { clients } = quatro();
  clients[1].stuckInvite = true;
  // O cancelamento não solta este convite: simula o servidor insistindo.
  clients[0].partyInviteCancel = async () => ({});
  clients[1].partyDecline = async () => ({});

  const result = await assembleParty(clients);

  assert.deepEqual(result.failed.map(f => [f.name, f.error]), [
    ['desjuli', 'party.invite.already']
  ]);
  // As outras duas entram normalmente: uma recusa não derruba a montagem.
  assert.deepEqual(result.members.map(m => m.name), ['muvinlax', 'sertralina20mg']);
});

test('o bilhete é lido antes de desfazer o grupo, e devolve a caçada original', async () => {
  const { clients } = quatro();
  const result = await assembleParty(clients);

  // Nunca escolhe caçada: devolve exatamente a do líder.
  assert.equal(result.gateId, 'ilha-jeju');
  assert.equal(clients[0].log.some(l => l === '0:startHunt:ilha-jeju/41/normal'), true);
});

test('as contas que saíram para a cidade voltam à caçada no fim', async () => {
  // A falha mais cara deste recurso: montar o grupo e deixar as contas paradas
  // na cidade rendendo nada.
  const { clients } = quatro();
  await assembleParty(clients);
  for (const client of clients) {
    assert.equal(client.inCity, false, `${client.state.name} ficou na cidade`);
  }
});

test('sem bilhete, o grupo é montado mas a ida à cidade é reportada', async () => {
  // O líder não estava caçando: nada pode puxar o grupo de volta, e isso tem de
  // aparecer em vez de ficar silencioso.
  const { clients } = quatro({ each: i => (i === 0 ? { hunt: null } : {}) });
  const result = await assembleParty(clients);

  assert.equal(result.partyId, '11611');
  assert.equal(result.ok, false);
  assert.equal(result.huntError, 'party.noHuntTicket');
});

test('sem grupo antigo não manda leave nem disband', async () => {
  const { clients, log } = quatro({ semGrupoAntigo: true });
  const result = await assembleParty(clients);

  assert.equal(result.ok, true);
  assert.equal(log.some(l => l.includes('leave')), false);
  assert.equal(log.some(l => l.includes('disband')), false);
});

test('create recusado aborta sem convidar ninguém', async () => {
  const { clients, log } = quatro({ each: i => (i === 0 ? { failCreate: 'party.exists' } : {}) });
  const result = await assembleParty(clients);

  assert.equal(result.ok, false);
  assert.equal(result.error, 'party.exists');
  assert.equal(log.some(l => l.includes('invite')), false);
});

test('uma conta que não entra não impede as outras, e é reportada', async () => {
  const { clients } = quatro({ each: i => (i === 2 ? { noInvite: true } : {}) });
  const result = await assembleParty(clients);

  assert.equal(result.ok, false);
  assert.equal(result.partyId, '11611');
  assert.deepEqual(result.members.map(m => m.name), ['desjuli', 'sertralina20mg']);
  assert.deepEqual(result.failed, [
    { index: 2, name: 'muvinlax', error: 'party.inviteNotReceived' }
  ]);
  // Mesmo com uma falha, quem entrou volta à caçada.
  assert.equal(clients[1].inCity, false);
  assert.equal(clients[3].inCity, false);
});

test('convite recusado pelo servidor entra em failed com o código dele', async () => {
  const { clients } = quatro({ each: i => (i === 0 ? { failInvite: 'muvinlax' } : {}) });
  const result = await assembleParty(clients);

  assert.deepEqual(result.failed, [
    { index: 2, name: 'muvinlax', error: 'party.full' }
  ]);
});

test('answer recusado entra em failed sem derrubar o grupo', async () => {
  const { clients } = quatro({ each: i => (i === 3 ? { failAnswer: 'party.full' } : {}) });
  const result = await assembleParty(clients);

  assert.equal(result.partyId, '11611');
  assert.deepEqual(result.failed, [
    { index: 3, name: 'sertralina20mg', error: 'party.full' }
  ]);
});

test('falha no start_hunt final é reportada, não engolida', async () => {
  const { clients } = quatro({ each: i => (i === 0 ? { failHunt: 'hunt.cooldown' } : {}) });
  const result = await assembleParty(clients);

  assert.equal(result.partyId, '11611');
  assert.equal(result.ok, false);
  assert.equal(result.huntError, 'hunt.cooldown');
});

test('as etapas são narradas na ordem, para a interface mostrar', async () => {
  const { clients } = quatro();
  const steps = [];
  await assembleParty(clients, step => steps.push(step.code));

  assert.deepEqual(steps, [
    'party.reading',
    'party.leaving', 'party.leaving', 'party.leaving',
    'party.disbanding',
    'party.creating',
    'party.created',
    'party.inviting', 'party.joined',
    'party.inviting', 'party.joined',
    'party.inviting', 'party.joined',
    'party.pulling'
  ]);
});

test('o passo de criação informa id e código para a interface', async () => {
  const { clients } = quatro();
  const steps = [];
  await assembleParty(clients, step => steps.push(step));

  // `code` é o nome da etapa; o código de convite vai em `partyCode`, para um
  // não sobrescrever o outro.
  const criado = steps.find(s => s.code === 'party.created');
  assert.equal(criado.partyId, '11611');
  assert.equal(criado.partyCode, '7J7FM3');
});

test('monta grupo de duas contas, não só de quatro', async () => {
  const { clients } = quatro();
  const result = await assembleParty(clients.slice(0, 2));

  assert.equal(result.ok, true);
  assert.equal(clients[0].createdWith.capacity, 2);
  assert.deepEqual(result.members.map(m => m.name), ['desjuli']);
});

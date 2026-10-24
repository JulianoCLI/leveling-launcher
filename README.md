# Leveling Launcher

Launcher multi-conta para **Leveling Idle 2D**. Contas organizadas em abas de
quatro painéis, cada uma com sessão isolada, alternando entre duas formas de
rodar a mesma conta:

- **WebView** — o jogo normal, para configurar a caçada e mexer no personagem;
- **Monitor headless** — sem Chromium: só WebSocket e telemetria.

## O que o monitor pode mandar

O monitor observa a caçada que **já está rodando**. A lista de pacotes que podem
sair dele é fechada:

| Pacote | Para quê |
| --- | --- |
| `login` / `resume` | autenticar |
| `ping` | manter o elo vivo |
| `party_request{get}` | leitura inicial do grupo |
| `buy_consumable` | repor poções e revives (auto-refill) |
| `buy_essence` | repor essência (auto-refill) |
| `travel` | ir à cidade onde a loja existe (auto-refill) |
| `move_to` | chegar ao balcão (auto-refill) |
| `interact` | abrir a loja no NPC (auto-refill) |
| `start_hunt` | voltar à caçada que a conta já estava fazendo (auto-refill), ou trocar de caçada quando o usuário escolhe outra (🗺️ Caçada) |

Os quatro últimos existem porque o servidor **não vende à distância**: medido
contra ele, `buy_consumable` numa cena de caçada responde `shop.npcRequired`, e
`interact` sem o personagem ter andado até o NPC é ignorado em silêncio. Repor
obriga a viagem completa.

Ele **nunca** manda `leave_hunt`, `set_automation`, `use_consumable` nem
`revive`. O monitor também **não escolhe caçada por conta própria**: o
`start_hunt` do refill devolve a conta exatamente à caçada que ela já estava
fazendo, e a única escolha de mapa que sai daqui é a do botão 🗺️ **Caçada**, por
clique do usuário. Comprar reabastece o que a automação do servidor gasta
sozinha; o resto significa desligar o monitor e voltar para a WebView.

Morte na caçada aparece no HUD como aviso. O `auto_revive` do servidor resolve.

## Reposição automática

Em **⚗️ Refill** há uma configuração **única, válida para todas as contas**: o
que varia entre contas é o ouro, não o mínimo de poção que se quer manter.

Cada item tem `mín` e `alvo` próprios. Quando o estoque cai **abaixo do mínimo**,
o monitor compra até o alvo. As três tiers (pequena, média, grande) de vida,
mana e revive são independentes, mais a essência — dez itens.

- **Desligado por padrão.** Marcar só a caixa mestre não compra nada: todo item
  precisa de um `mín` maior que zero.
- **Reserva de ouro** nunca é tocada. Sem ouro para o lote inteiro, compra o que
  cabe.
- Compras saem **em série**, com intervalo entre refills e recuo longo quando o
  servidor recusa (ouro, nível, limite).

### A conta sai da caçada para comprar

O servidor só vende na loja da cidade. O ciclo é `travel` → `move_to` →
`interact` → compras → `start_hunt` de volta, orientado a evento e sem espera
fixa: **~2,5 s medidos** contra o servidor real, independente de quantos itens,
e só quando falta estoque.

Nada fica preso se algo falhar no meio:

- A conta volta à caçada mesmo que a compra dê erro.
- Sem **bilhete de volta** (`gate_id`/`tier_min`/`difficulty`, lidos na entrada
  da cena) o monitor **se recusa a viajar**: deixar a conta parada na cidade é
  pior do que não repor.
- Se o launcher fechar entre a ida e a volta, o próximo login devolve a conta à
  caçada.

### O preço do catálogo não é o preço cobrado

Medido no nível 46: a poção pequena de vida tem base **2** no catálogo e custou
**11**; a de mana, mesma base 2, custou **8**. O fator não sai de
`consumable_price_per_level` nem da fórmula do cliente web — o servidor forma o
preço a partir do efeito da poção.

Então o catálogo serve só para saber que o item existe e qual é o `min_level`. O
preço real é **aprendido**: a primeira compra de um item é de **uma unidade**, e
o `gold_cost` que volta é o que orça o lote seguinte, no mesmo balcão. Sem isso
a reserva de ouro seria furada por um fator de cinco.

## Trocar de caçada

**🗺️ Caçada** troca o mapa **sem desligar o monitor** — antes era a única coisa
que obrigava a voltar para a WebView: desligar, esperar o renderer subir, trocar
no jogo e ligar de novo.

O botão existe em dois lugares, e abre a mesma tela: o 🗺️ do cabeçalho de um
painel traz **só aquela conta** na lista; o da barra de título traz **a aba
inteira**, com caixa de seleção por conta. Trocar uma ou trocar oito é a mesma
operação; o que muda é a lista marcada.

A lista de portais vem do `content_catalog` do **servidor**, não de uma tabela
do launcher: portal novo no jogo aparece aqui sem alterar nada. Ele é lido uma
vez e compartilhado por todas as contas (é conteúdo do jogo, não da conta), então
só o primeiro login paga a leitura de mais de 1 MB; do objeto inteiro sobram
alguns kilobytes.

O catálogo chega **uma vez, no login**, e não dá para pedir de novo. Por isso os
poucos kilobytes ficam salvos em `hunts.json`: sem eles, um monitor que já estava
conectado quando o launcher abriu deixaria o seletor vazio até a conta relogar —
exatamente o que o botão existe para evitar. A cópia salva abre a tela cheia; a
primeira conta a logar a substitui pela lista do servidor, que pode ter portal
novo. Na primeiríssima vez, sem nenhum login anterior, a tela diz que a lista
ainda não existe em vez de mostrar um seletor vazio.

### Uma lista, um filtro

A tela é uma **lista** de caçadas — uma linha por faixa de cada portal, em ordem
de progressão, com o nível exigido e o recomendado de **todas** à vista. Escolher
exige comparar, e comparar exige ver junto: três seletores em cascata (portal,
faixa, dificuldade) obrigavam a abrir uma combinação por vez só para descobrir o
nível dela.

O **único filtro** é a dificuldade, e ela é filtro por um motivo: recalcula o
nível de toda a lista e esconde as faixas que não a oferecem. Repetir cada caçada
uma vez por dificuldade triplicaria a lista sem acrescentar escolha nenhuma.

Linha acima do nível da conta mais baixa marcada fica avisada (`precisa de 45`),
nunca escondida — quem decide é o servidor. Marcar outra conta recalcula os
avisos, porque o nível de referência é o da conta mais baixa: é ela que vai ser
recusada primeiro.

### Os níveis

Três coisas barram uma caçada **ao mesmo tempo**, e o servidor cobra as três:

| Campo | O que exige |
| --- | --- |
| `GateDef.min_level` | nível para o portal existir |
| `DifficultyDef.req_level` | nível para aquela dificuldade |
| `TierDef.Area.required_level` | nível para a faixa **naquela** dificuldade |

Então o **nível exigido** mostrado é o **maior dos três** — mostrar só o do
portal faria a tela prometer entrada em um mapa que o servidor recusa. O **nível
recomendado** é o dos monstros da área (`TierDef.Area.level`): é ele que diz se
a conta sobrevive lá, não a permissão de entrar. Sem área declarada, o topo da
faixa é a aproximação.

A tela mostra também a faixa de tier, os multiplicadores de recompensa e drop da
dificuldade, e o chefe. Cada conta aparece com o **nível dela** e o mapa atual, e
é marcada quando está abaixo do exigido — marcada, não escondida: quem decide é o
servidor, e o catálogo pode estar atrasado em relação a ele. Faixa `coming_soon`
fica visível e avisada, porque saber que ela existe é informação.

### Em grupo, só o líder recebe

Medido: `start_hunt` do líder **puxa o grupo inteiro** (`party.follow.pulled`).
Mandar a troca também para cada membro seria redundante e, chegando antes do
arrasto, poderia espalhar o grupo por cenas diferentes. Então para cada grupo
representado na seleção só o líder recebe o pedido, e os membros aparecem no
resultado como puxados. Um grupo cujo líder ficou **fora** da seleção é a
exceção: aí cada membro pede por si, senão ninguém sairia do mapa antigo.

### O que a troca garante

- `leave_hunt` continua proibido: medido, `start_hunt` numa conta já caçando
  troca de mapa direto, e o servidor tira a conta da cena anterior sozinho.
  `leave_hunt` só a mandaria para a cidade no meio da troca.
- O **bilhete de volta** passa a ser o mapa novo, e só **depois** de o servidor
  aceitar. Sem isso o refill seguinte devolveria a conta ao mapa antigo; com uma
  troca recusada, o bilhete antigo é o certo — a conta não saiu do lugar.
- Conta comprando na cidade recusa a troca (`hunt.refillBusy`): o `start_hunt`
  de volta do refill a desfaria segundos depois, sem explicação.
- Conta sem monitor fica na lista, desabilitada. O launcher não tem socket dela;
  a troca se faz no próprio jogo.

## Criar PT

**👥 Criar PT** monta um grupo com as contas da aba atual que estão **em modo
monitor**. A conta aberta na WebView do jogo fica de fora: o launcher não tem
socket dela, porque o servidor aceita uma sessão por conta.

O primeiro painel da aba vira líder. O grupo nasce **fechado**
(`PARTY_PRIVACY_CLOSED`), já que são contas do mesmo dono — aberto deixaria
estranhos ocuparem uma das quatro vagas.

A ordem é medida contra o servidor, não suposta:

1. lê o grupo atual de cada conta, e guarda o **bilhete de caçada do líder**
   antes de mexer em qualquer coisa;
2. os membros saem do grupo antigo, o líder desfaz o dele — `create` é recusado
   com a conta já em grupo;
3. o líder cria o grupo; a resposta já traz o código de convite;
4. convida uma conta por vez, e cada convidada responde só depois de o convite
   chegar nela;
5. o líder manda `start_hunt` com o bilhete do passo 1, e **o grupo inteiro é
   puxado** para a caçada dele (`party.follow.pulled`, ~150 ms).

O passo 5 não é enfeite: sair do grupo **tira a conta da caçada e a manda para a
cidade** (`party.left.to_city`), e entrar num grupo novo não a devolve. Se o
líder não estava caçando, não há bilhete, e o launcher **avisa** em vez de
deixar as contas paradas na cidade em silêncio.

O botão narra cada etapa enquanto corre, e uma montagem roda por vez.

## Sessão única

O servidor aceita uma sessão por conta e substitui a anterior. Então as duas
formas nunca coexistem na mesma conta: ligar o monitor tira a WebView do jogo, e
abrir o jogo derruba o monitor (`session.replaced`). O launcher trata isso como
handoff normal, não como erro, e nunca reconecta por cima.

## Uso

No Windows, dois cliques em **`iniciar.bat`**. Ele instala as dependências na
primeira vez e abre o launcher nas seguintes.

Pela linha de comando, em qualquer sistema:

```
npm install
npm start
```

O repositório **não traz** o `node_modules`: é o `npm install` que baixa tudo.

O pacote `electron` do npm é só um invólucro — o programa de verdade são ~100 MB
baixados à parte. As versões recentes **deixaram de fazer isso sozinhas** no
`npm install`, então o `postinstall` deste projeto chama
`node_modules/electron/install.js` na mão. Sem ele, a instalação termina sem
erro nenhum e mesmo assim não há o que executar.

Se o download for bloqueado (antivírus, proxy, firewall de empresa), o
`iniciar.bat` detecta a falta e explica, em vez de deixar o Windows reclamar de
um `.exe` inexistente.

Em **👤 Contas**, salve usuário e senha de cada painel. As senhas ficam
criptografadas com o `safeStorage` do sistema, em `userData`, e nunca voltam para
a interface — o renderer só recebe `hasPassword`/`hasToken`. O token de sessão é
guardado junto porque reconectar por `resume` não gasta tentativa de login.

Depois, o botão **Monitor** no cabeçalho de cada painel liga e desliga.

## Abas

A grade mostra sempre quatro painéis. Para passar de quatro contas, use **+ Aba**:
cada aba acrescenta mais quatro contas, com partição e credenciais próprias.
Manter quatro painéis fixos é proposital — o custo de memória vem dos renderers
do jogo, não do número de contas cadastradas.

A contagem de painéis e o **🔋 Monitor no início** valem **por aba**: um grupo
pode estar jogando em quatro painéis enquanto outro sobe só como monitor. A
escolha volta ao trocar de aba.

Trocar de aba descarta as WebViews da aba anterior, mas **não** desliga os
monitores headless: uma conta em aba escondida continua farmando e o HUD dela
reaparece com o estado atualizado ao voltar.

Remover uma aba com **− Aba** desliga os monitores das contas dela — senão
ficariam rodando sem nenhum botão para pará-los. As credenciais continuam
salvas e voltam intactas se a aba for recriada.

## Testes

```
npm test         # 154 testes: proto, codec, headless, refill, caçadas, grupo,
                 #             credenciais, HUD, modal
npm run test:ui  # shell no DOM real do Electron
```

## Protobuf

O schema vem do bundle publicado do jogo, não escrito à mão:

```
npm run proto
```

O carregamento usa `proto/descriptor-set.bin`; os `.proto` em
`proto/leveling/v1/` são para leitura humana e não compilam isolados, porque o
bundle serializa sem o campo `dependency`.

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
| `daily_boss{info}` | ler o estado dos bosses diários (👑 Boss) |
| `daily_boss{start}` | entrar no boss diário elegível (👑 Boss) |
| `market_request{create}` | criar o anúncio (💰 Mercado · Anunciar, 🏷️ Anunciar) |
| `market_request{cancel}` | retirar um anúncio escolhido na tela (💰 Mercado · Meus anúncios) |
| `market_request{buy}` | comprar o item abaixo do teto (🎯 Sniper) |
| `lock_item` | tirar o cadeado da peça antes de anunciar |
| `mail_request{list}` | ver o que está no correio (🏷️ Anunciar) |
| `mail_request{claim}` | recolher o ouro da venda, **uma entrada por pacote** (🏷️ Anunciar) |

Os pacotes de loja existem porque o servidor **não vende à distância**: medido
contra ele, `buy_consumable` numa cena de caçada responde `shop.npcRequired`, e
`interact` sem o personagem ter andado até o NPC é ignorado em silêncio. Repor
obriga a viagem completa.

Ele **nunca** manda `leave_hunt`, `set_automation`, `use_consumable` nem
`revive`. Nem `mail_request{claim_all}`: recolher tudo de uma vez levaria também
recompensa de evento e item de outra automação, e a bolsa enche no meio sem dizer
o que ficou pela metade. O resgate é **por entrada, por id**, e para na primeira
recusa por bolsa cheia. As **ofertas** de mercado também ficam de fora — elas
prendem saldo até alguém responder, e isso é compromisso, não leitura. O monitor também **não escolhe caçada por conta própria**: o
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

## Boss diário

**👑 Boss** faz, uma vez por dia, **todos os bosses diários disponíveis** de cada
conta, e devolve cada uma à caçada em que estava — o jogo manda para a cidade ao
terminar o boss.

Todas as contas participam por padrão; a tela permite **excluir conta por conta**.

- A fila sai **do mais fraco para o mais forte** (`boss_level` crescente): quem
  não passa do primeiro ainda gasta a tentativa nos que daria conta.
- Boss acima do nível (`min_level`) ou já feito hoje (`done_today`) sai da fila
  **sem gastar pacote**, e o relatório diz qual dos dois foi.
- **Derrota não é retentada**: a tentativa do dia já foi gasta. Ela vira linha de
  falha (`boss.defeat`) no relatório.
- Um `start_hunt` só, **no fim da fila**. A conta volta à cidade entre dois bosses
  de qualquer forma, e devolvê-la à caçada no meio pagaria duas trocas de cena.
- Sem **bilhete de volta** o launcher não escolhe caçada por conta própria, igual
  ao refill.
- Trocar de caçada durante a rodada é recusado (`hunt.bossBusy`): a restauração
  do fim desfaria a troca sem explicação.

O dia é o do **servidor**: a virada é o `reset_at_ms` do estado, e o relógio local
de 00:01 só manda **reler** o estado — rede de segurança, não a verdade.

O relatório mostra, por conta, quais bosses deram certo e quais não, com tempo,
recorde novo e posição quando o servidor os manda.

## Auto-anunciar

**🏷️ Anunciar** mantém as **vagas de anúncio** de cada conta ocupadas com o
tesouro mais valioso da bolsa, e recolhe do correio o ouro das vendas.

É a única automação que **vende item das contas**, e um anúncio comprado não
volta. Por isso tudo aqui é fechado por padrão:

- **Equipamento nunca é anunciado.** Só `materials` e `imbue_materials`, pela
  **categoria do catálogo** — não por `def_id` adivinhado. Sem catálogo lido,
  **nada** é anunciado.
- **Só a bolsa.** O depósito não é tocado: lá está o que foi guardado de
  propósito.
- **Até `maxPerRound` itens por rodada** (padrão 2, teto 10), o que limita o
  estrago de um erro de preço ao que caiba no relatório.

### Nunca vender

Lista de bloqueio por item, válida em **todas as contas**, que vence todas as
outras regras — inclusive categoria e preço.

Existe porque categoria e preço decidem bem no geral e erram no particular: o
material de imbuição que você está juntando para forjar é, pelas regras abaixo,
exatamente o melhor candidato a anunciar — tesouro, caro, com mercado. Não há
sinal no item que separe "estoque" de "reserva"; isso é intenção, e intenção só
o usuário tem.

O botão **Escolher da bolsa…** lista o que as contas em modo monitor têm agora
e que o auto-anunciar venderia, agregado por item, com quantidade somada e em
quantas contas aparece. Equipamento não entra na lista: bloquear o que já nunca
seria anunciado só encheria a tela de linhas sem efeito.

**Por item inteiro, não por nível.** Bloquear o citrino nv. 2 e deixar o nv. 1
vendável é a forma de descobrir, tarde, que o que você guardava era o conjunto —
e uma lista que precisa de manutenção a cada nível novo não protege nada.

O relatório mostra o item barrado como `na sua lista de bloqueio`, e o bloqueio
é checado **antes** da consulta de preço: o item não custa nem uma busca de
mercado.

### O preço, e o nível

Dois critérios, e a escolha é do usuário porque o objetivo é dele:

- **abaixo do rival mais barato** (`priceMode: 'rival'`, padrão). Duas
  referências: a **mediana das vendas daquele item naquele nível** e o
  **anúncio rival mais barato** ativo. Anuncia um ouro abaixo do rival, nunca
  abaixo do **piso** — `floorPct` da mediana, padrão 70%. É o que de fato
  vende: quem compra olha a primeira página ordenada por preço.
- **pela média do item** (`priceMode: 'average'`). A **média ponderada pela
  quantidade** das vendas daquele nível, ignorando a concorrência por completo.
  Afirma um preço e espera. `floorPct` e `undercut` não se aplicam — os dois
  existem para negociar com o rival, e este modo não negocia — e nenhuma busca
  de mercado é feita, o que torna a rodada mais barata.

A média é **ponderada**: uma venda de 3.000 unidades diz muito mais sobre o
preço corrente que uma de 1. O descarte de vendas anormais vale nos dois modos
e importa mais na média, onde um zero digitado a mais contamina o resultado
inteiro em vez de ser só cortado.

O **nível é decisivo**: um citrino nv. 2 vale perto de três vezes um nv. 1.
Preço por `def_id` sozinho erra por 3×, então:

- a mediana é pedida **com o nível exato**, e sem ela (menos de duas vendas
  registradas desse nível) o item é **pulado** — `price.noLevelData`;
- o **encanto** também entra, em dois degraus: primeiro `nível + encanto`
  exatos e, só quando aquela amostra não alcança duas vendas, o nível sozinho —
  marcado como `encanto aproximado` no relatório. **Nunca** cai para "qualquer
  nível";
- `market_price_hint` **não** serve de reserva: ele ignora o nível, e usá-lo
  reintroduziria exatamente o erro de 3×;
- a busca de rival sai com `level_min == level_max`.

Rival abaixo do piso **não** define o preço: o item fica, e o relatório diz
`price.marketDumped`. Alguém liquidando estoque num dia não liquida o seu.

### A moeda

Ouro (padrão) ou **diamante**. Em diamante o preço tem duas origens:

- **direta** — o item já foi vendido em diamante naquele nível, e o preço sai
  daquelas vendas. Nenhuma conversão;
- **convertida** — não foi, e o preço em ouro é dividido pela **cotação do
  câmbio**: a mediana de `cambio:diamante` dos últimos 7 dias, do banco local.
  Sem cotação o item é recusado com `price.noRate`, em vez de converter por um
  palpite.

A taxa de venda do jogo é 10% nas duas moedas e o teto de preço é o mesmo, então
a conversão é proporcional. O que ela não resolve é a **granularidade**: o
diamante é grosso, e um lote que valha menos de **3 diamantes** não tem preço
inteiro que o represente — arredondar distorceria mais que a margem. Esses são
recusados com `price.tooCheapForDiamond`.

Tudo é decidido **em ouro** primeiro e convertido por último, porque o preço do
NPC é em ouro: comparar "4 diamantes" com "900 de ouro" aprovaria como ótimo um
anúncio que vale um décimo do que o balcão dá. `minGold` é sempre em ouro, pelo
mesmo motivo — em diamante nenhum lote chegaria perto daquele número na própria
moeda. O relatório mostra a taxa usada e o equivalente em ouro de cada anúncio
convertido.

**Não há reprecificação.** O auto-anunciar só preenche vaga vazia; anúncio
parado fica onde está, e quem decide retirar é o usuário.

### A rodada

Correio primeiro, depois as vagas, depois a bolsa. Sem recolher a venda a vaga
continua ocupada e o ouro não entra; sem vaga, a bolsa **nem é lida** — são oito
contas por rodada.

Vaga é contada por **status**, não pelo tamanho de `mine`: a lista mistura
vendido e expirado, e contá-los diria "sem vagas" com dez anúncios que já
saíram.

**Bolsa cheia interrompe a rodada** (`autosell.bagFull`): anunciar exige
destrancar a peça, e o resgate do correio já saiu pela metade.

O que recolher é escolhido por **`subject_key`**, não por `kind`. Medido no
cliente do jogo: `kind` é só a **categoria** da correspondência (`market`,
`return`, `reward`, `payment`, `system`) e `subject_key` é o que ela é de fato
(`market_sale`, `return`, `market_offer_refund`, `look_sale`). Casar por `kind`
com nome de evento nunca dava verdadeiro, e o ouro das vendas ficava parado no
correio com a vaga do anúncio ocupada. `market_purchase` e
`market_offer_accepted` ficam **de fora**: são item comprado entrando na bolsa,
que não é trabalho desta automação e gastaria o espaço de que ela precisa para
anunciar. Correspondência **em análise** (`held_until_ms` no futuro) espera o
prazo — o servidor recusa o resgate antes dele, e insistir só gastaria um pedido
por rodada, por conta, para a mesma recusa.

O relatório guarda, linha a linha, **mediana, rival, piso e número de vendas**
de cada anúncio criado — é o que permite auditar o preço na manhã seguinte — e
também o resumo das **recusas**, porque o motivo mais comum de uma rodada vazia
é falta de mediana do nível exato, que parece defeito e é a decisão certa.

## Câmbio

Junta o ouro de todas as contas numa só, por trocas dentro do jogo. **💱 Câmbio**
abre a janela; nasce **desligado**, e é a única automação do launcher cujo erro
não tem desfazer nenhum — ouro transferido não volta.

O caminho é uma **cadeia**, não uma estrela:

```
conta 9 → conta 8 → conta 7 → … → conta 2 → conta 1
```

Cada conta só precisa ser amiga da **vizinha**, e o ouro desce acumulando. O
motivo de poder ser cadeia é medido: a troca **não cobra taxa** — `given_gold` e
`received_gold` são iguais, e o saldo das duas contas fecha exatamente. Então
descer hop a hop custa o mesmo que mandar direto, com uma amizade por par em vez
de oito com a mesma conta.

### A reserva

Cada conta de origem fica com um piso intocado, **100.000 por padrão e no
mínimo**. Não é preciosismo: a conta paga o próprio auto-refill com ouro
próprio, e uma conta zerada para de repor poção e revive, para de caçar e deixa
de render. A tela não aceita menos, e um `prefs.json` editado à mão é corrigido
na leitura.

A conta de **destino não tem reserva**: ela é o fim da linha, só recebe. Ela
também participa sempre, mesmo marcada como excluída — "excluída" quer dizer
"não doa", não "não recebe", e sem ela não existe cadeia.

### O correio entra antes

Antes de planejar um hop, a conta de origem **recolhe do correio o ouro que é
só ouro**. Uma venda de mercado entrega por correio, e enquanto nada recolhe o
valor não está no saldo — sem esta etapa o câmbio desceria apenas o ouro de
caçada e deixaria para trás o de venda, que nas contas que mais vendem é a
maior parte.

O critério é o mais estreito possível: entradas com ouro e **nada mais**. Nunca
com item, porque resgate com a bolsa cheia é **parcial** e silencioso; nunca com
diamante, porque isso é recompensa, não venda; nunca as retidas para análise,
que o servidor recusa antes do prazo. Recompensa de evento, prêmio e item
guardado de propósito ficam intocados.

A página do correio é **0-based**, e o lote é 20. Medido
(`tools/mail-probe.js`): o deslocamento é `page * page_size`, então pedir
`page:1, page_size:50` numa caixa de 26 cai depois do fim e responde
`entries: []` com o `total` certo e **sem erro nenhum**. Parecia caixa vazia, e
eram as cartas novas — as únicas por recolher, já que elas ficam todas na
página zero. Provado com resgate real: 803.694 → 2.530.837.

Logo **depois** do hop as duas contas são lidas de novo. Na origem, porque uma
venda pode ter fechado durante os segundos da troca — sem isso esse ouro
esperaria o hop seguinte, dez minutos depois. No destino, porque ele é a origem
do hop de baixo: a conta 8 que acabou de receber da 9 é quem doa no 8 → 7, e
chegar lá com ouro parado na caixa faria a cadeia descer menos do que ela tem.

A leitura é estrangulada em dois minutos por conta — o laço varre a cadeia a
cada quinze segundos, e sem isso seriam oito leituras por tique para quase
sempre não achar nada. "Transferir agora" ignora o estrangulamento.

O ouro desce **acumulando**: o plano lê o saldo no instante do hop, então o que
a conta 8 recebeu da 9 viaja junto com o dela no hop 8 → 7.

### Um hop

As etapas, todas medidas contra o servidor real (`tools/trade-probe.js`):

1. **amizade** — `invite` entre contas que não são amigas responde
   `trade.friends_only`. É a única pré-condição que o servidor cobra por código,
   e é persistente: o launcher pede e aceita uma vez por par, nunca mais.
2. **reunião** — as duas na cidade, no **mesmo canal**, perto uma da outra. Quem
   anda e quem troca de canal é **quem dá** o ouro; o destino fica parado, porque
   é ele que várias contas procuram.
3. **oferta** — `set_offer{gold}` e **conferir antes de travar**. Depois do
   `lock` o servidor recusa mudar a oferta (`trade.locked`) e a trava **não cai**,
   então o que for conferido ali vale até o fim. Qualquer item ou sombra na
   oferta, de qualquer lado, **aborta** — esta automação só move ouro.
4. **confirmação** — os dois `lock`, os dois `confirm`, e o `completed` que fecha.
5. **conferência** — `given_gold`/`received_gold` contra o plano, **e o saldo**
   nos dois lados. O `completed` é o que o servidor diz; o saldo é a verificação
   independente, e divergência aqui **para a cadeia** em vez de empilhar a troca
   seguinte sobre uma premissa que não se confirmou.
6. **retorno** — `start_hunt` nas duas, só em quem tinha bilhete.

Não há etapa de correio: medido, `TradeCompleted.mailed` vem falso nas trocas de
ouro e o valor cai direto no saldo (via `character_patch`, em
`value.wallet.gold`). `mailed` continua sendo conferido e aparece no relatório,
mas como aviso, não como caminho.

O hop inteiro leva **~3 s**. O resto é pausa.

### O ritmo

**Uma troca por vez no launcher inteiro**, e a seguinte só depois de a anterior
ter fechado **e** o saldo ter sido conferido nos dois lados. O intervalo (dez
minutos por padrão) conta do **fecho** da anterior, não do início, e leva uma
variação aleatória de até 20%: trocas espaçadas por exatamente dez minutos, hop
após hop, são um padrão que se lê num gráfico.

O relógio do último hop vai para o disco. Sem isso, reiniciar o launcher logo
depois de uma troca liberaria a seguinte na hora.

### Quando o hop aborta

Durante a troca a conta recusa refill, boss, expedição e troca de caçada — todas
tirariam a conta da cidade no meio da transferência. O recíproco também vale: um
hop não começa numa conta que já está em qualquer dessas.

E há o **arrasto**: medido na sonda, o líder de um grupo troca de caçada e leva a
conta com ele (`party.follow.pulled`). Se isso chegar durante o hop, a conta já
está em outra cena e a troca é abortada (`cambio.arrastado`) — antes do
`confirm`, que é o ponto sem volta.

### O relatório

Cada linha traz o par, o valor e **os dois saldos**. É o único histórico que
existe: a janela de troca do jogo não guarda nada, e depois de um hop não há onde
conferir o que aconteceu além do saldo. Sobrevive ao fechamento do launcher,
em `cambio-log.json`.

## Status

**🧬 Status** distribui os pontos de atributo de cada nível, sozinho, na build
que você escolher para cada conta. Fica em janela própria e nasce **desligado**.

O gatilho não é "subiu de nível": é **ponto livre maior que zero**. Não existe
pacote de level-up no protocolo, e pontos parados também chegam de um login com
níveis acumulados — uma conta que subiu oito níveis com o launcher fechado
distribui os 40 pontos no próprio login.

### A fórmula é copiada do jogo

Alocar ponto é irreversível: desfazer custa token de respec ou cristal. Uma
fórmula só *parecida* com a do botão "Distribuir pela build" gastaria pontos de
verdade numa divisão que você não escolheu.

Então ela não foi inferida. `tools/leveling-extract-build-math.js` baixa os
chunks publicados do jogo e localiza a função; `src/domain/leveling-stats.js`
traz a transcrição dela, com o original minificado no cabeçalho do arquivo. A
suíte `test/leveling-stats.test.cjs` tem o original como **oráculo** e compara as
duas em mil combinações aleatórias de pesos, investido e pontos livres.

Re-rodar o extrator depois de cada deploy do jogo é o que mantém isso honesto.

### A base é o investido, não o total

A divisão olha só `StatsState.allocated` — o que **você** gastou. O que a classe
dá de graça (`class_base`) e o que vem de equipamento (`from_items`) ficam fora.

Isso não é escolha do launcher: é o que o jogo faz, e o que a descrição da build
"Rajada Arcana" diz com todas as letras — *"a Inteligência inicial da classe não
conta"*. Usar `total` mandaria menos pontos para o atributo principal de toda
classe que já começa forte nele.

O alvo de cada atributo é proporcional ao total **depois** de gastar, e só quem
está abaixo do alvo recebe. Atributo já adiantado recebe zero, e o ponto dele vai
para quem está atrás. Numa build já cumprida — ninguém abaixo do alvo — a divisão
cai nos pesos crus, senão os pontos ficariam parados para sempre.

### Por conta, não global

É a única automação do launcher com configuração **por conta**. As outras têm uma
política global e uma lista de contas de fora; aqui classe e build são do
personagem, e não existe valor global que sirva.

Conta sem escolha própria usa a **primeira build da classe** dela, que é a ordem
em que o jogo as mostra e é a build de dano puro. Há também o modo **pesos
meus**, que dispensa classe e catálogo: os números são proporção livre, porque a
fórmula divide cada peso pela soma — `20/40` e `50/100` dão a mesma divisão.

Se a build salva sumir num deploy do jogo, o launcher **recusa** com
`stats.buildGone` em vez de cair calado noutra divisão. Trocar a build sem avisar
seria pior que não distribuir.

### Nunca reseta

`reset_stats` está fora da lista de pacotes que podem sair do launcher. O
auto-status só gasta o que está livre; nunca realoca o que já foi gasto, porque
isso cobraria token ou cristal da conta.

### A prévia e o relatório

A coluna **Vai sair** da janela mostra a divisão exata que será enviada, e é
calculada pelo mesmo código do envio — não por uma conta paralela da tela. É a
conferência que evita queimar pontos numa build errada.

O relatório traz nível, build e a divisão de cada distribuição, à vista. O jogo
não guarda registro de alocação, então é o único histórico que existe. Sobrevive
ao fechamento do launcher, em `stats-log.json`.

## Retirar um anúncio

Em **💰 Mercado · Meus anúncios**, cada linha tem o seu botão de retirar, com
confirmação **na própria linha**. Um por clique, sem seleção múltipla: o risco
não é cancelar, é cancelar o anúncio **vizinho** — a tabela é ordenada por
expiração e troca de posição a cada repintura.

Acima da tabela, **Retirar todos** faz o lote: retira exatamente os anúncios
listados ali — se o filtro de conta estiver ativo, só os daquela conta. A
confirmação diz o número, e as retiradas vão uma a uma, com o progresso à
vista. Um anúncio que falhe não aborta o resto.

O item volta para a mochila. Com a mochila cheia ele vai para o **correio**, e
a tela avisa: sem isso o usuário procura a peça, não acha, e conclui que o
cancelamento a perdeu.

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

A contagem de painéis e o arranjo da grade valem **por aba**: um grupo pode
estar jogando em quatro painéis enquanto outro usa um só. A escolha volta ao
trocar de aba.

O **🔋 Monitor no início** é do launcher inteiro, não da aba. Ligado, todas as
abas sobem em monitor no boot, sem nenhum renderer do jogo. Ele já foi por aba,
e era uma armadilha: o botão grava na aba visível, então marcar numa e reiniciar
deixava as outras no modo normal, esperando uma visita para ligar — o oposto do
que "no início" promete.

O recorte continua sendo a contagem de painéis **daquela** aba: uma aba com um
painel sobe uma conta, não quatro. Painel escondido não conecta.

Trocar de aba descarta as WebViews da aba anterior, mas **não** desliga os
monitores headless: uma conta em aba escondida continua farmando e o HUD dela
reaparece com o estado atualizado ao voltar.

Remover uma aba com **− Aba** desliga os monitores das contas dela — senão
ficariam rodando sem nenhum botão para pará-los. As credenciais continuam
salvas e voltam intactas se a aba for recriada.

## Testes

```
npm test         # proto, codec, headless, refill, caçadas, boss diário, grupo,
                 # mercado, anúncio, auto-anunciar, câmbio, credenciais, HUD, modal
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

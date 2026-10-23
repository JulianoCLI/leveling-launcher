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
| `start_hunt` | voltar à caçada que a conta já estava fazendo (auto-refill) |

Os quatro últimos existem porque o servidor **não vende à distância**: medido
contra ele, `buy_consumable` numa cena de caçada responde `shop.npcRequired`, e
`interact` sem o personagem ter andado até o NPC é ignorado em silêncio. Repor
obriga a viagem completa.

Ele **nunca** manda `leave_hunt`, `set_automation`, `use_consumable`, `revive`,
nem um `start_hunt` que não seja o retorno à caçada original — o monitor não
escolhe caçada, só devolve a conta à que ela já estava fazendo. Comprar
reabastece o que a automação do servidor gasta sozinha; agir no jogo significa
desligar o monitor e voltar para a WebView.

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
npm test         # 77 testes: proto, codec, headless, credenciais, HUD, modal
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

# Protocolo de conexão (socket.io)

Contrato entre servidor e cliente: login, handshake de sala (criar/entrar/
listar), início automático da partida quando a sala lota, e o andamento da
partida em si (retransmissão dos eventos do `GameController`). Escrito
antes/durante o código pra evitar que cada lado invente um formato
diferente.

Os nomes de evento e códigos de erro abaixo são constantes em `conexao/eventos.js`
(`EventosCliente`, `EventosServidor`, `CodigosErro`). Ninguém deve usar a string
literal diretamente — sempre importar dali.

## Formato geral

Todo evento cliente -> servidor é **request/response via ack do socket.io**:

```js
socket.emit('nomeDoEvento', payload, (resposta) => { ... });
```

`payload` é sempre um objeto (mesmo vazio: `{}`), nunca omitido — o handler
no servidor tem assinatura fixa `(payload, ack)`. A resposta do ack é sempre:

- Sucesso: `{ ok: true, ...resultado }`
- Erro: `{ ok: false, codigo, mensagem }`, onde `codigo` é um valor de
  `CodigosErro` (pra lógica no cliente) e `mensagem` é texto legível (só
  pra exibição, nunca pra lógica).

Não existe um evento `erro` separado — o erro vem na resposta do próprio ack.
Os demais eventos servidor -> cliente (a partir de `listaJogadores`) são todos
*empurrados* pelo servidor, não resposta de um pedido específico — ver seção
própria abaixo, inclusive a distinção entre broadcast de sala e privado por
jogador.

## Fluxo básico

1. Cliente conecta o socket.
2. Cliente manda `entrar` com nome/senha -> servidor autentica contra o banco
   (via `conexao/login.js`/`conexao/db.js`) e associa `socket.id` a um
   `Player` pelo resto da conexão. Devolve um token JWT (`conexao/jwt.js`).
   O socket também entra numa sala pessoal `jogador:<id>` — é pra lá que vai
   qualquer informação privada do jogador (hoje só a mão, `suaMao`).
3. Cliente decide: `criarSala` (vira dono/adm, sala nasce com ele dentro) ou
   `listarSalas` seguido de `entrarSala` num `salaId` da lista.
4. A cada entrada numa sala, o servidor faz `io.to(salaId).emit('listaJogadores', ...)`
   — todo mundo já dentro da sala recebe a lista atualizada, incluindo quem
   acabou de entrar.
5. Quando a sala lota (`jogadores.length === numberPlayers`), o servidor
   agenda o início automático da partida e avisa a sala com
   `partidaIniciandoEm`. O adm (quem criou a sala) pode pular a espera
   mandando `forcarInicio`. Depois disso a partida emite os eventos de jogo
   (`novaRodadaIniciada`, `suaMao`, `manilhaVirada`, ...) e **pausa** em cada
   `turnoAposta` (um jogador por vez, na ordem da rodada — a resposta de um
   pode influenciar o próximo) esperando `apostar`, e depois em cada
   `turnoJogador`, esperando o jogador daquela vez mandar `jogarCarta` — só
   aí segue pra próxima jogada, até `jogoFinalizado`.

## Eventos cliente -> servidor

### `entrar`
Payload: `{ nome: string, senha: string }`
Pré-condição: nenhuma (primeiro evento da conexão).
Ack sucesso: `{ ok: true, nome, token }`.
Erros possíveis: `USUARIO_NAO_ENCONTRADO`, `SENHA_INCORRETA`.

### `cadastrar`
Payload: `{ nome: string, senha: string }` — `nome` e `senha` precisam ter
pelo menos 3 caracteres (espaços nas pontas do nome são descartados antes
de checar).
Pré-condição: nenhuma (alternativa a `entrar` pra quem ainda não tem conta).
Ack sucesso: `{ ok: true, nome, token }` — mesmo formato de `entrar`; a
conta já nasce autenticada, não precisa de um `entrar` separado depois.
Erros possíveis: `CADASTRO_INVALIDO` (nome/senha curtos demais),
`NOME_JA_CADASTRADO`.

### `criarSala`
Payload: `{ numberPlayers?: number, roundStart?: number, randomShuffle?: boolean, botNumber?: number }`
(todos opcionais — default vem do `SalaManager`: 4 / 3 / true / 0)
`numberPlayers` precisa ser inteiro entre 2 e 6; `roundStart` inteiro ≥ 1;
`botNumber` inteiro entre 0 e `numberPlayers - 1` (sempre sobra pelo menos o
assento de quem criou) — fora disso, `CONFIGURACAO_INVALIDA`.
`botNumber` preenche o resto dos assentos com bots (ver `bots/Bot.js`)
assim que a sala nasce, na ordem de entrada normal — se isso já lotar a
sala, a partida é agendada na hora, igual qualquer `entrarSala` que lote.
Bots não têm socket: não aparecem em `jogadorPorSocket`, nunca desconectam
nem reconectam, e cada turno deles é decidido por `bots/BotBrain.js` e
jogado depois de uma pausa de `atrasoBotMs` (1s por padrão), sem esperar
`tempoTurnoMs` (ver `PlayerGame.bot`).
Pré-condição: socket já mandou `entrar` com sucesso.
Ack sucesso: `{ ok: true, salaId, numberPlayers, jogadores: [{ nome }] }`. O
socket já dá `join` na sala; `jogadores` vem no próprio ack (só 1: o dono,
que também vira o adm — ver `forcarInicio`) porque o broadcast de
`listaJogadores` sai *dentro* deste handler, antes do ack — um cliente que
só registra o listener depois de processar o ack perderia esse primeiro
broadcast pra sempre. Não confie nele pro estado inicial, só nos que vêm
depois.
Erros possíveis: `NAO_IDENTIFICADO`, `CONFIGURACAO_INVALIDA`.

### `entrarSala`
Payload: `{ salaId: string }`
Pré-condição: socket já mandou `entrar` com sucesso.
Ack sucesso: `{ ok: true, salaId, numberPlayers, jogadores }`. O socket já dá
`join` na sala; todos os membros (incluindo quem entrou) recebem
`listaJogadores` atualizado. Se essa entrada lotar a sala, o início
automático é agendado (ver `partidaIniciandoEm`).
Erros possíveis: `NAO_IDENTIFICADO`, `SALA_NAO_ENCONTRADA`, `SALA_CHEIA`,
`SALA_JA_INICIADA`, `JA_ESTA_NA_SALA`, `NOME_INVALIDO` (nome duplicado na sala).

### `listarSalas`
Payload: `{}`
Pré-condição: socket já mandou `entrar` com sucesso.
Ack sucesso: `{ ok: true, salas: [{ salaId, numberPlayers, jogadoresAtual }] }`
— só salas **abertas** (não iniciadas e não cheias). Sala cheia ou já
iniciada simplesmente não aparece na lista.
Erros possíveis: `NAO_IDENTIFICADO`.

### `forcarInicio`
Payload: `{ salaId: string }`
Pré-condição: socket já mandou `entrar`; a sala precisa estar cheia; só quem
criou a sala (adm) pode mandar.
Ack sucesso: `{ ok: true }`. Cancela a espera de `partidaIniciandoEm` e
começa a partida na hora.
Erros possíveis: `NAO_IDENTIFICADO`, `SALA_NAO_ENCONTRADA`, `SALA_JA_INICIADA`,
`SALA_NAO_CHEIA`, `NAO_AUTORIZADO` (não é o adm da sala).

### `sairSala`
Payload: `{ salaId: string }`
Pré-condição: socket já mandou `entrar`; só funciona **antes** da partida
começar (saída de partida em andamento — abandono/forfeit — não existe
ainda, é feature separada).
Ack sucesso: `{ ok: true }`. O socket dá `leave` na sala e quem ficar recebe
`listaJogadores` atualizado. Se quem saiu era o adm, a posição passa pro
próximo da lista automaticamente. Se a sala ficar vazia, é descartada. Se
havia um início agendado (`partidaIniciandoEm`) e a sala deixou de estar
cheia, o agendamento é cancelado.
Erros possíveis: `NAO_IDENTIFICADO`, `SALA_NAO_ENCONTRADA`, `SALA_JA_INICIADA`,
`NAO_ESTA_NA_SALA`.

### `apostar`
Payload: `{ salaId: string, valor: number }` — `valor` é o número de vazas
que o jogador acha que vai fazer nessa rodada.
Pré-condição: socket já mandou `entrar`; a partida da sala precisa já ter
começado; e **precisa ser a vez de quem manda apostar** — o servidor decide
isso sozinho a partir de quem recebeu o `turnoAposta` mais recente, mesma
lógica de `jogarCarta` pro turno de jogar carta. As apostas são pedidas uma
de cada vez, na ordem da rodada (primeiro jogador, depois o segundo, e assim
por diante) — a resposta de quem apostou antes pode influenciar a de quem
vem depois, então o servidor não pede a próxima aposta antes da anterior
chegar.
Ack sucesso: `{ ok: true }`. Libera a espera do servidor e o `apostaFeita`
sai pra sala inteira; segue pro próximo `turnoAposta` ou, se era o último,
pro início da primeira vaza.
Erros possíveis: `NAO_IDENTIFICADO`, `SALA_NAO_ENCONTRADA`, `SALA_NAO_INICIADA`,
`NAO_E_SUA_VEZ`, `APOSTA_INVALIDA` (`valor` não é um inteiro entre 0 e o
número de cartas da rodada), `APOSTA_FECHA_RODADA` (só pode acontecer com o
**último** jogador a apostar na rodada — ver limite abaixo).

**Limites de aposta**:
- `valor` tem que ser um inteiro entre `0` e o número de cartas da rodada
  (o mesmo `cartas` que veio em `novaRodadaIniciada`) — não faz sentido
  apostar mais vazas do que existem cartas pra fazer.
- A soma das apostas de todo mundo não pode fechar exatamente no número de
  cartas da rodada — isso garantiria que pelo menos alguém acerta sem
  arriscar nada. Só o **último** jogador a apostar na rodada esbarra nisso
  na prática (os outros ainda não sabem a soma final); se o valor que ele
  mandou fecharia a soma, o servidor recusa com `APOSTA_FECHA_RODADA` e ele
  precisa escolher outro. É por isso que a ordem de aposta (`Game.setstartsequence`)
  precisa ser sorteada de verdade a cada partida: ser o último a apostar é
  uma desvantagem real (perde a liberdade de escolher qualquer valor), então
  não pode ser sempre a mesma pessoa só por ter entrado por último na sala.

**Timeout da aposta**: mesmo prazo de `jogarCarta` (`tempoTurnoMs`). Se
estourar, o servidor aposta por aquele jogador sozinho — 1, a não ser que
isso viole o limite acima (só possível se ele for o último a apostar), caso
em que aposta 0 — liga a flag `desconectado`, sem emitir um evento à parte,
só o `apostaFeita` normal com o valor escolhido.

### `jogarCarta`
Payload: `{ salaId: string, indice: number }` — `indice` é a posição da
carta na mão de quem manda (0-based; a mão vem em `suaMao`).
Pré-condição: socket já mandou `entrar`; a partida da sala precisa já ter
começado; e **precisa ser a vez de quem manda** — o servidor decide isso
sozinho a partir de quem recebeu o `turnoJogador` mais recente, não confia
em nada que o cliente diga sobre de quem é a vez.
Ack sucesso: `{ ok: true }`. Libera a espera do servidor, a carta sai da mão
e o jogo segue pro próximo evento (`cartaJogada` público, depois o próximo
`turnoJogador` ou o fim da vaza/rodada/partida).
Erros possíveis: `NAO_IDENTIFICADO`, `SALA_NAO_ENCONTRADA`, `SALA_NAO_INICIADA`,
`NAO_E_SUA_VEZ`, `CARTA_INVALIDA` (índice fora da mão).

**Timeout do turno**: cada `turnoJogador` tem um prazo (`tempoTurnoMs` no
`GameController`, 15s por padrão) pra `jogarCarta` chegar. Se estourar, o
servidor joga sozinho por aquele jogador — mesma decisão simples usada pros
bots de verdade (hoje sempre a última carta da mão; ver `bots/BotBrain.js`
— trocar por uma escolha melhor, ou treinar com ML, é trabalho futuro) —
liga a flag `desconectado` nele e emite `jogadaAutomatica` pra sala. Uma
falta isolada é só isso: o próximo turno dele continua esperando
`tempoTurnoMs` normalmente, do zero — pode ter sido só uma demora.
`limiteInatividadeMs`/`jogadorExpulsoPorInatividade` (ver abaixo) não
mudaram: continuam avaliados a cada timeout, exatamente como antes de
existir bot. Só quando isso realmente acumula o suficiente pra estourar
`limiteInatividadeMs` (várias faltas seguidas, não uma só) é que ele é
considerado desconectado de verdade — expulsa o socket da sala **e** liga a
flag `bot` (`PlayerGame.bot`): a partir daí esse assento para de esperar
`tempoTurnoMs` e joga na hora, com uma pausa de `atrasoBotMs` (1s por
padrão, mesma pausa de um bot de verdade — ver `GameController`) só pra não
resolver a vaza inteira instantaneamente. As flags só desligam quando ele
manda `jogarCarta`/`apostar` de novo com sucesso, ou reconecta (ver
`reconectar` abaixo) — a partir daí volta a esperar `tempoTurnoMs` como
qualquer jogador de verdade, com a reconexão funcionando exatamente igual a
antes (mesmo `estadoDeReconexao`, mesma mão, mesmo "de quem é a vez").

Uma desconexão "do nada" (aba fechada, rede caiu) **antes** da partida
começar tem exatamente o mesmo efeito de mandar `sairSala` — o servidor
chama a mesma função internamente ao detectar o `disconnect`, sem esperar o
cliente pedir nada (silenciosamente: não tem ack pra responder, e um erro
esperado não é logado). Já uma desconexão **depois** que a partida começou
não mexe no roster do jogo — o assento continua lá. Se a desconexão
acontecer bem na vez dele, o timeout acima cuida disso normalmente (jogada
automática); se não for a vez dele, simplesmente não acontece nada até a
vez chegar.

**Expulsão por inatividade**: cada timeout de turno (aposta ou carta) também
checa há quanto tempo (real, em ms — não em turnos) aquele jogador não faz
nada de verdade. Se passar de `limiteInatividadeMs` (`GameController`, 90s
por padrão, configurável por sala igual `tempoTurnoMs`) desde a última ação
real dele (jogar carta, apostar ou `reconectar`), o servidor tira o *socket*
dele da room daquela sala e avisa todo mundo com `jogadorExpulsoPorInatividade`
— só isso, uma vez por período de inatividade (não reemite a cada novo
timeout enquanto ele continuar sumido). O assento na partida **não muda**:
`controller.jogadores` continua com ele lá, `jogadaAutomatica` continua
jogando por ele a cada turno normalmente — só o socket parou de estar na
room, então o cliente dele para de receber os eventos daquela partida e
(olhando o `id` do evento) deve navegar pra tela de salas. Pra voltar, é só
mandar `reconectar` de novo — o socket ainda está autenticado (não é uma
desconexão de verdade), não precisa `entrar` outra vez. Hoje isso só
desconecta: não existe bot nenhum jogando estrategicamente por ele nesse
meio tempo (ver "o que fica fora deste marco" mais abaixo).

### `reconectar`
Payload: `{ salaId: string }`
Pré-condição: socket já mandou `entrar` (de novo — reconectar não dispensa
logar de novo, o `socket.id` é outro); a sala precisa **já ter começado**
(pra sala em espera, é só `entrarSala` mesmo) e quem manda precisa já fazer
parte daquela partida (ter entrado na sala antes dela começar).
Ack sucesso: `{ ok: true, salaId, mao: string[], cartasRodada: number,
suaVez: boolean, jogadorDaVez: string | null, suaVezDaAposta: boolean,
jogadorDaVezAposta: string | null }` — a mão atual de quem reconectou,
quantas cartas tem a rodada (pro limite do input de aposta) e de quem é a
vez agora, tanto pra jogar carta quanto pra apostar (as duas esperas nunca
coexistem — no máximo um par faz sentido de cada vez, o outro fica
`false`/`null`), pra o cliente já poder pedir a ação certa na hora, sem
esperar um `turnoJogador`/`turnoAposta` que já passou antes dele voltar. O
socket dá `join` na sala de novo (broadcasts futuros voltam a chegar) e a
flag `desconectado` desse jogador é desligada.
Erros possíveis: `NAO_IDENTIFICADO`, `SALA_NAO_ENCONTRADA`,
`SALA_NAO_INICIADA` (sala existe mas a partida não começou — use
`entrarSala`), `NAO_ESTA_NA_SALA` (não faz parte dessa partida).

### `minhaSalaAtiva`
Payload: `{}`
Pré-condição: socket já mandou `entrar`.
Ack sucesso: `{ ok: true, salaId: string | null }` — o `salaId` de uma
partida já em andamento em que quem pediu ainda tem assento, ou `null` se
não tiver nenhuma. Existe pra um socket recém-autenticado (ex.: depois de um
refresh de página — o cliente não guarda `salaId` nenhum entre recarregas,
de propósito) conseguir descobrir sozinho que existe uma partida esperando
por ele, sem precisar saber o `salaId` de antemão — é o mesmo `salaId` que
`reconectar` espera. Salas ainda na sala de espera (não iniciadas) não
contam aqui: lá "sumir" já tira o assento de verdade (ver `disconnect` em
`jogarCarta` acima), não tem o que descobrir. Se o jogador tiver assento em
mais de uma partida em andamento ao mesmo tempo (hoje possível — nada
impede criar/entrar numa sala nova depois de sair de outra, ver "Sair da
partida" no front), devolve só a primeira encontrada.
Erros possíveis: `NAO_IDENTIFICADO`.

## Eventos servidor -> cliente

Todos levam `salaId` no payload. Todos são broadcast pra sala inteira
(`io.to(salaId)`), **exceto `suaMao`**, que é privado — vai só pra
`jogador:<id>` de quem é dona daquela mão.

### `listaJogadores`
`{ salaId, jogadores: [{ nome }] }` — toda vez que a lista de espera muda.

### `partidaIniciandoEm`
`{ salaId, segundos }` — disparado assim que a sala lota. `segundos` é a
espera configurada (15s por padrão) antes do início automático; o adm pode
pular mandando `forcarInicio`.

### Eventos de partida (retransmissão direta do `GameController`)
A partir daqui, o payload de cada evento é exatamente o que o
`GameController` emite (ver `game/GameController.js`), só com `salaId`
adicionado:

| Evento | Payload (além de `salaId`) |
|---|---|
| `novaRodadaIniciada` | `{ numero, cartas }` |
| `suaMao` **(privado)** | `{ mao: string[] }` — só a mão de quem recebe |
| `manilhaVirada` | `{ vira, viraValor }` |
| `turnoAposta` | `{ id, jogador }` — `id` é de quem tem que mandar `apostar` agora |
| `apostaFeita` | `{ jogador, aposta }` — só depois que a aposta foi de fato registrada (real ou timeout) |
| `turnoJogador` | `{ id, jogador }` — `id` é de quem tem que mandar `jogarCarta` |
| `cartaJogada` | `{ jogador, carta, status }` |
| `vazaFinalizada` | `{ vencedor, carta }` |
| `rodadaFinalizada` | `{ numero, resultado }` |
| `jogadoresEliminados` | `{ eliminados: [{ nome, hp }] }` |
| `jogoFinalizado` | `{ vencedor }` |
| `jogadaAutomatica` | `{ id, jogador }` — `tempoTurnoMs` estourou, o servidor jogou sozinho por ele |
| `jogadorReconectou` | `{ id, jogador }` — voltou via `reconectar`, flag `desconectado` desligada |
| `jogadorExpulsoPorInatividade` | `{ id, jogador }` — `limiteInatividadeMs` sem nenhuma ação real dele; o socket dele já saiu da room dessa sala (assento continua, ver seção de `reconectar` acima) |

## Códigos de erro (`CodigosErro`)

| Código | Quando |
|---|---|
| `NAO_IDENTIFICADO` | Mandou `criarSala`/`entrarSala`/`listarSalas`/`forcarInicio`/`sairSala`/`jogarCarta`/`reconectar`/`minhaSalaAtiva` sem ter mandado `entrar` antes |
| `USUARIO_NAO_ENCONTRADO` | `entrar` com nome que não existe no banco |
| `SENHA_INCORRETA` | `entrar` com nome existente, senha errada |
| `CADASTRO_INVALIDO` | `cadastrar` com nome ou senha menor que 3 caracteres |
| `NOME_JA_CADASTRADO` | `cadastrar` com nome que já existe no banco |
| `NOME_INVALIDO` | `entrarSala` com nome já em uso *nessa sala* |
| `CONFIGURACAO_INVALIDA` | `criarSala` com `numberPlayers`/`roundStart`/`botNumber` fora do intervalo aceito |
| `SALA_NAO_ENCONTRADA` | `entrarSala`/`forcarInicio`/`sairSala`/`jogarCarta`/`reconectar` com `salaId` que não existe |
| `SALA_CHEIA` | `entrarSala` numa sala que já tem `numberPlayers` jogadores |
| `SALA_NAO_CHEIA` | `forcarInicio` antes da sala lotar |
| `SALA_JA_INICIADA` | `entrarSala`/`forcarInicio`/`sairSala` numa sala cuja partida já começou |
| `SALA_NAO_INICIADA` | `jogarCarta`/`reconectar` numa sala cuja partida ainda não começou |
| `JA_ESTA_NA_SALA` | `entrarSala` com o mesmo jogador (mesmo id de sessão) já presente |
| `NAO_ESTA_NA_SALA` | `sairSala` por quem não está (mais) naquela sala; `reconectar` por quem não faz parte da partida |
| `NAO_AUTORIZADO` | `forcarInicio` por quem não é o adm da sala |
| `NAO_E_SUA_VEZ` | `jogarCarta`/`apostar` fora da sua vez |
| `CARTA_INVALIDA` | `jogarCarta` com `indice` que não existe na mão de quem mandou |
| `APOSTA_INVALIDA` | `apostar` com `valor` fora de `[0, número de cartas da rodada]` |
| `APOSTA_FECHA_RODADA` | `apostar` pelo último da rodada com `valor` que fecharia a soma de todo mundo no número de cartas |
| `ERRO_INTERNO` | Exceção inesperada no servidor — não deveria acontecer; se aparecer, é bug |

## O que fica fora deste marco (decisão adiada, não esquecida)

- Bot de verdade. `escolherCartaAutomatica` (`game/GameController.js`) hoje
  só devolve a última carta da mão — dá pra validar o mecanismo de
  timeout/flag ponta a ponta, mas não é uma escolha estratégica nenhuma.
  Trocar por algo que jogue com alguma lógica é trabalho futuro; hoje, depois
  da expulsão por inatividade, é exatamente essa mesma jogada boba que
  continua acontecendo a cada turno até alguém voltar via `reconectar`.
- Reconectar durante a **sala de espera** (antes da partida começar) não
  existe como conceito separado — hoje uma desconexão nessa fase tira o
  jogador da sala (`sairSala`), então "reconectar" ali é só logar de novo e
  mandar `entrarSala` como se fosse a primeira vez. `reconectar` (evento
  novo) só serve pra partida já em andamento.
- Abandono/forfeit de partida em andamento (hoje só dá pra sair antes de
  começar, via `sairSala` — uma vez que a partida começa, o único jeito de
  "sair" é deixar o timeout jogar automático por você indefinidamente).
- Reconexão via `Main2.js`: o harness de CLI não guarda o token entre
  execuções nem oferece a opção "reconectar" no menu — pra testar o fluxo
  de reconexão hoje é preciso emitir o evento manualmente (ou usar os
  testes automatizados, que já cobrem o caminho ponta a ponta).

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
   `turnoJogador`, esperando o jogador daquela vez mandar `jogarCarta` — só
   aí segue pra próxima jogada, até `jogoFinalizado`.

## Eventos cliente -> servidor

### `entrar`
Payload: `{ nome: string, senha: string }`
Pré-condição: nenhuma (primeiro evento da conexão).
Ack sucesso: `{ ok: true, nome, token }`.
Erros possíveis: `USUARIO_NAO_ENCONTRADO`, `SENHA_INCORRETA`.

### `criarSala`
Payload: `{ numberPlayers?: number, roundStart?: number, randomShuffle?: boolean }`
(todos opcionais — default vem do `SalaManager`: 4 / 3 / true)
`numberPlayers` precisa ser inteiro entre 2 e 6; `roundStart` inteiro ≥ 1 —
fora disso, `CONFIGURACAO_INVALIDA`.
Pré-condição: socket já mandou `entrar` com sucesso.
Ack sucesso: `{ ok: true, salaId, numberPlayers }`. O socket já dá `join`
na sala e recebe o primeiro `listaJogadores` (com 1 jogador: o dono, que
também vira o adm da sala — ver `forcarInicio`).
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

**Sem timeout ainda**: se ninguém mandar `jogarCarta` pra vez que está
esperando, a partida fica parada ali pra sempre — não existe bot nem prazo.
Decisão consciente pra esse marco (ver pendências).

Uma desconexão "do nada" (aba fechada, rede caiu) durante a espera tem
**exatamente o mesmo efeito** de mandar `sairSala` — o servidor chama a
mesma função internamente ao detectar o `disconnect`, sem esperar o cliente
pedir nada. A diferença é só quem está mandando: aqui o `socketServer.js`
mesmo, silenciosamente (não tem ack pra responder, e um erro esperado — tipo
a sala já ter começado — não é logado, só ignorado). Já uma desconexão
**depois** que a partida começou não faz nada: o jogador continua no roster
do jogo (é isso que deixa reconexão futura viável — ver seção de pendências).

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
| `apostaFeita` | `{ jogador, aposta }` |
| `turnoJogador` | `{ id, jogador }` — `id` é de quem tem que mandar `jogarCarta` |
| `cartaJogada` | `{ jogador, carta, status }` |
| `vazaFinalizada` | `{ vencedor, carta }` |
| `rodadaFinalizada` | `{ numero, resultado }` |
| `jogadoresEliminados` | `{ eliminados: [{ nome, hp }] }` |
| `jogoFinalizado` | `{ vencedor }` |

## Códigos de erro (`CodigosErro`)

| Código | Quando |
|---|---|
| `NAO_IDENTIFICADO` | Mandou `criarSala`/`entrarSala`/`listarSalas`/`forcarInicio`/`sairSala`/`jogarCarta` sem ter mandado `entrar` antes |
| `USUARIO_NAO_ENCONTRADO` | `entrar` com nome que não existe no banco |
| `SENHA_INCORRETA` | `entrar` com nome existente, senha errada |
| `NOME_INVALIDO` | `entrarSala` com nome já em uso *nessa sala* |
| `CONFIGURACAO_INVALIDA` | `criarSala` com `numberPlayers`/`roundStart` fora do intervalo aceito |
| `SALA_NAO_ENCONTRADA` | `entrarSala`/`forcarInicio`/`sairSala`/`jogarCarta` com `salaId` que não existe |
| `SALA_CHEIA` | `entrarSala` numa sala que já tem `numberPlayers` jogadores |
| `SALA_NAO_CHEIA` | `forcarInicio` antes da sala lotar |
| `SALA_JA_INICIADA` | `entrarSala`/`forcarInicio`/`sairSala` numa sala cuja partida já começou |
| `SALA_NAO_INICIADA` | `jogarCarta` numa sala cuja partida ainda não começou |
| `JA_ESTA_NA_SALA` | `entrarSala` com o mesmo jogador (mesmo id de sessão) já presente |
| `NAO_ESTA_NA_SALA` | `sairSala` por quem não está (mais) naquela sala |
| `NAO_AUTORIZADO` | `forcarInicio` por quem não é o adm da sala |
| `NAO_E_SUA_VEZ` | `jogarCarta` fora da sua vez |
| `CARTA_INVALIDA` | `jogarCarta` com `indice` que não existe na mão de quem mandou |
| `ERRO_INTERNO` | Exceção inesperada no servidor — não deveria acontecer; se aparecer, é bug |

## O que fica fora deste marco (decisão adiada, não esquecida)

- Reconexão de verdade (o socket cair e voltar, e o cliente continuar
  recebendo a partida de onde parou). O bloqueador estrutural que existia
  antes — o `GameController` rodar a partida inteira num loop síncrono, sem
  nenhum "onde" pra pausar — **não existe mais**: `jogarCarta` já faz o
  motor esperar de verdade a vez de cada jogador (ver `_aguardarJogada` em
  `game/GameController.js`), e o resto do que reconexão vai precisar também
  já está pronto — token JWT sem estado, sala pessoal `jogador:<id>`, e
  desconexão em partida já iniciada não mexe no roster (ver `sairSala`
  acima). O que falta é só o fluxo do lado do protocolo: um evento
  `reconectar` e um jeito de reidentificar qual `socket.id` novo corresponde
  a qual `player.id` já em jogo (hoje `jogadorPorSocket`/`salaPorSocket` só
  conhecem o `socket.id` atual, que morre no disconnect) — e, ligado a isso,
  o que fazer se ninguém responder `turnoJogador` a tempo (ver timeout
  abaixo).
- Timeout/bot pra quando o jogador da vez não responde. Hoje `jogarCarta`
  não tem prazo — se a pessoa cair ou sumir bem na hora da vez dela, a
  partida trava ali pra sempre, esperando pra sempre por uma jogada que
  pode nunca vir. Decisão consciente pra chegar rápido numa versão
  jogável; timer dedicado + jogada automática de fallback + flag marcando
  "essa cadeira está sendo jogada no automático" é o desenho já discutido,
  só não implementado ainda.
- Abandono/forfeit de partida em andamento (hoje só dá pra sair antes de
  começar, via `sairSala`).
- Apostas reais (hoje toda aposta é fixa em 1 — `jogador.aposta = 1` sem
  perguntar nada; só a escolha da carta virou interativa nesse marco).

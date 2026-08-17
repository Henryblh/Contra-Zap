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
   mandando `forcarInicio`. Depois disso a partida roda sozinha até o fim,
   emitindo os eventos de jogo (`novaRodadaIniciada`, `suaMao`,
   `manilhaVirada`, ..., `jogoFinalizado`) conforme a lista abaixo.

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
| `turnoJogador` | `{ jogador }` |
| `cartaJogada` | `{ jogador, carta, status }` |
| `vazaFinalizada` | `{ vencedor, carta }` |
| `rodadaFinalizada` | `{ numero, resultado }` |
| `jogadoresEliminados` | `{ eliminados: [{ nome, hp }] }` |
| `jogoFinalizado` | `{ vencedor }` |

## Códigos de erro (`CodigosErro`)

| Código | Quando |
|---|---|
| `NAO_IDENTIFICADO` | Mandou `criarSala`/`entrarSala`/`listarSalas`/`forcarInicio` sem ter mandado `entrar` antes |
| `USUARIO_NAO_ENCONTRADO` | `entrar` com nome que não existe no banco |
| `SENHA_INCORRETA` | `entrar` com nome existente, senha errada |
| `NOME_INVALIDO` | `entrarSala` com nome já em uso *nessa sala* |
| `CONFIGURACAO_INVALIDA` | `criarSala` com `numberPlayers`/`roundStart` fora do intervalo aceito |
| `SALA_NAO_ENCONTRADA` | `entrarSala`/`forcarInicio` com `salaId` que não existe |
| `SALA_CHEIA` | `entrarSala` numa sala que já tem `numberPlayers` jogadores |
| `SALA_NAO_CHEIA` | `forcarInicio` antes da sala lotar |
| `SALA_JA_INICIADA` | `entrarSala`/`forcarInicio` numa sala cuja partida já começou |
| `JA_ESTA_NA_SALA` | `entrarSala` com o mesmo jogador (mesmo id de sessão) já presente |
| `NAO_AUTORIZADO` | `forcarInicio` por quem não é o adm da sala |
| `ERRO_INTERNO` | Exceção inesperada no servidor — não deveria acontecer; se aparecer, é bug |

## O que fica fora deste marco (decisão adiada, não esquecida)

- Reconexão (o que acontece se o socket cair e voltar). A camada de
  identidade já dá suporte a isso — token é JWT assinado (`conexao/jwt.js`),
  verificável sem estado e sobrevive a restart do processo, e a sala pessoal
  `jogador:<id>` já é endereçável por id estável, não por `socket.id` — mas
  ainda não existe um evento `reconectar` nem um `Map<playerId, socket.id>`
  do lado do `socketServer.js` (hoje `jogadorPorSocket` é indexado por
  `socket.id`, que troca a cada reconexão). Falta também o `GameController`
  saber esperar a jogada de um jogador real (hoje ele resolve a partida
  inteira num loop síncrono) — pré-requisito pra reconectar *durante* uma
  partida em andamento, não só na sala de espera.
- Sair da sala voluntariamente antes da partida começar.
- Tempo de resposta / turnos com jogador real (hoje toda jogada é automática
  — `jogador.mao.pop()` — e toda aposta é fixa em 1; isso é consequência
  direta do `GameController` rodar a partida inteira síncrono, no mesmo
  ponto que trava a reconexão durante partida). Fica pra discussão própria.

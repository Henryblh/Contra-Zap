# Protocolo de conexão (socket.io)

Contrato entre servidor e cliente para o marco "login + criar sala / entrar
na sala / listar salas abertas". Escrito antes/durante o código pra evitar
que cada lado invente um formato diferente. Não cobre formatação de cartas
nem a partida em si — só login e o handshake de sala.

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
A única exceção é `listaJogadores`, que é *empurrado* pelo servidor (broadcast
pra sala, não resposta de um pedido específico).

## Fluxo básico

1. Cliente conecta o socket.
2. Cliente manda `entrar` com nome/senha -> servidor autentica contra
   `banco.json` (via `conexao/login.js`) e associa `socket.id` a um `Player`
   pelo resto da conexão. Devolve um token (ver `login.js` pro porquê de ser
   opaco por enquanto).
3. Cliente decide: `criarSala` (vira dono, sala nasce com ele dentro) ou
   `listarSalas` seguido de `entrarSala` num `salaId` da lista.
4. A cada entrada numa sala, o servidor faz `io.to(salaId).emit('listaJogadores', ...)`
   — todo mundo já dentro da sala recebe a lista atualizada, incluindo quem
   acabou de entrar.
5. Critério de sucesso do marco: os 4 sockets têm, ao final, a mesma
   `listaJogadores` com 4 nomes na mesma sala. Início de partida fica para o
   próximo marco.

## Eventos cliente -> servidor

### `entrar`
Payload: `{ nome: string, senha: string }`
Pré-condição: nenhuma (primeiro evento da conexão).
Ack sucesso: `{ ok: true, nome, token }`.
Erros possíveis: `USUARIO_NAO_ENCONTRADO`, `SENHA_INCORRETA`.

### `criarSala`
Payload: `{ numberPlayers?: number, roundStart?: number, randomShuffle?: boolean }`
(todos opcionais — default vem do `SalaManager`: 4 / 3 / true)
Pré-condição: socket já mandou `entrar` com sucesso.
Ack sucesso: `{ ok: true, salaId, numberPlayers }`. O socket já dá `join`
na sala e recebe o primeiro `listaJogadores` (com 1 jogador: o dono).
Erros possíveis: `NAO_IDENTIFICADO`.

### `entrarSala`
Payload: `{ salaId: string }`
Pré-condição: socket já mandou `entrar` com sucesso.
Ack sucesso: `{ ok: true, salaId, numberPlayers, jogadores }`. O socket já dá
`join` na sala; todos os membros (incluindo quem entrou) recebem
`listaJogadores` atualizado.
Erros possíveis: `NAO_IDENTIFICADO`, `SALA_NAO_ENCONTRADA`, `SALA_CHEIA`,
`SALA_JA_INICIADA`, `JA_ESTA_NA_SALA`, `NOME_INVALIDO` (nome duplicado na sala).

### `listarSalas`
Payload: `{}`
Pré-condição: socket já mandou `entrar` com sucesso.
Ack sucesso: `{ ok: true, salas: [{ salaId, numberPlayers, jogadoresAtual }] }`
— só salas **abertas** (não iniciadas e não cheias). Sala cheia ou já
iniciada simplesmente não aparece na lista.
Erros possíveis: `NAO_IDENTIFICADO`.

## Eventos servidor -> cliente

### `listaJogadores`
Payload: `{ salaId: string, jogadores: [{ nome: string }] }`
Broadcast (`io.to(salaId)`) pra todos os sockets da sala toda vez que a lista
muda (por enquanto só entrada — sair/desconectar durante a espera é um dos
itens adiados abaixo).

## Códigos de erro (`CodigosErro`)

| Código | Quando |
|---|---|
| `NAO_IDENTIFICADO` | Mandou `criarSala`/`entrarSala`/`listarSalas` sem ter mandado `entrar` antes |
| `USUARIO_NAO_ENCONTRADO` | `entrar` com nome que não existe no banco |
| `SENHA_INCORRETA` | `entrar` com nome existente, senha errada |
| `NOME_INVALIDO` | `entrarSala` com nome já em uso *nessa sala* |
| `SALA_NAO_ENCONTRADA` | `entrarSala` com `salaId` que não existe |
| `SALA_CHEIA` | `entrarSala` numa sala que já tem `numberPlayers` jogadores |
| `SALA_JA_INICIADA` | `entrarSala` numa sala cuja partida já começou |
| `JA_ESTA_NA_SALA` | `entrarSala` com o mesmo jogador (mesmo id de sessão) já presente |
| `ERRO_INTERNO` | Exceção inesperada no servidor — não deveria acontecer; se aparecer, é bug |

## O que fica fora deste marco (decisão adiada, não esquecida)

- Reconexão (o que acontece se o socket cair e voltar). A camada de
  identidade já dá suporte a isso — token é JWT assinado (`conexao/jwt.js`),
  verificável sem estado e sobrevive a restart do processo — mas ainda não
  existe um evento `reconectar` nem um `Map<playerId, socket.id>` do lado do
  `socketServer.js` (hoje `jogadorPorSocket` é indexado por `socket.id`, que
  troca a cada reconexão). Falta também o `GameController` saber esperar a
  jogada de um jogador real (hoje ele resolve a partida inteira num loop
  síncrono) — pré-requisito pra reconectar *durante* uma partida em
  andamento, não só na sala de espera.
- Sair da sala voluntariamente antes da partida começar.
- Iniciar a partida (ligar `entrarSala` cheia a `GameController.iniciarPartida()`).

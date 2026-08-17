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

**Timeout do turno**: cada `turnoJogador` tem um prazo (`tempoTurnoMs` no
`GameController`, 15s por padrão) pra `jogarCarta` chegar. Se estourar, o
servidor joga sozinho por aquele jogador — hoje um placeholder bem simples
(sempre a última carta da mão, o mesmo `pop()` de antes de existir jogada
real; ver `escolherCartaAutomatica` em `game/GameController.js` — trocar
isso por uma escolha de verdade é trabalho futuro) — liga a flag
`desconectado` nele e emite `jogadaAutomatica` pra sala. A flag só desliga
quando ele manda `jogarCarta` de novo com sucesso, ou reconecta (ver
`reconectar` abaixo).

Uma desconexão "do nada" (aba fechada, rede caiu) **antes** da partida
começar tem exatamente o mesmo efeito de mandar `sairSala` — o servidor
chama a mesma função internamente ao detectar o `disconnect`, sem esperar o
cliente pedir nada (silenciosamente: não tem ack pra responder, e um erro
esperado não é logado). Já uma desconexão **depois** que a partida começou
não mexe no roster do jogo — o assento continua lá. Se a desconexão
acontecer bem na vez dele, o timeout acima cuida disso normalmente (jogada
automática); se não for a vez dele, simplesmente não acontece nada até a
vez chegar.

### `reconectar`
Payload: `{ salaId: string }`
Pré-condição: socket já mandou `entrar` (de novo — reconectar não dispensa
logar de novo, o `socket.id` é outro); a sala precisa **já ter começado**
(pra sala em espera, é só `entrarSala` mesmo) e quem manda precisa já fazer
parte daquela partida (ter entrado na sala antes dela começar).
Ack sucesso: `{ ok: true, salaId, mao: string[], suaVez: boolean,
jogadorDaVez: string | null }` — a mão atual de quem reconectou e de quem é
a vez agora, pra o cliente saber se já deve pedir a escolha de carta na
hora. O socket dá `join` na sala de novo (broadcasts futuros voltam a
chegar) e a flag `desconectado` desse jogador é desligada.
Erros possíveis: `NAO_IDENTIFICADO`, `SALA_NAO_ENCONTRADA`,
`SALA_NAO_INICIADA` (sala existe mas a partida não começou — use
`entrarSala`), `NAO_ESTA_NA_SALA` (não faz parte dessa partida).

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
| `jogadaAutomatica` | `{ id, jogador }` — `tempoTurnoMs` estourou, o servidor jogou sozinho por ele |
| `jogadorReconectou` | `{ id, jogador }` — voltou via `reconectar`, flag `desconectado` desligada |

## Códigos de erro (`CodigosErro`)

| Código | Quando |
|---|---|
| `NAO_IDENTIFICADO` | Mandou `criarSala`/`entrarSala`/`listarSalas`/`forcarInicio`/`sairSala`/`jogarCarta`/`reconectar` sem ter mandado `entrar` antes |
| `USUARIO_NAO_ENCONTRADO` | `entrar` com nome que não existe no banco |
| `SENHA_INCORRETA` | `entrar` com nome existente, senha errada |
| `NOME_INVALIDO` | `entrarSala` com nome já em uso *nessa sala* |
| `CONFIGURACAO_INVALIDA` | `criarSala` com `numberPlayers`/`roundStart` fora do intervalo aceito |
| `SALA_NAO_ENCONTRADA` | `entrarSala`/`forcarInicio`/`sairSala`/`jogarCarta`/`reconectar` com `salaId` que não existe |
| `SALA_CHEIA` | `entrarSala` numa sala que já tem `numberPlayers` jogadores |
| `SALA_NAO_CHEIA` | `forcarInicio` antes da sala lotar |
| `SALA_JA_INICIADA` | `entrarSala`/`forcarInicio`/`sairSala` numa sala cuja partida já começou |
| `SALA_NAO_INICIADA` | `jogarCarta`/`reconectar` numa sala cuja partida ainda não começou |
| `JA_ESTA_NA_SALA` | `entrarSala` com o mesmo jogador (mesmo id de sessão) já presente |
| `NAO_ESTA_NA_SALA` | `sairSala` por quem não está (mais) naquela sala; `reconectar` por quem não faz parte da partida |
| `NAO_AUTORIZADO` | `forcarInicio` por quem não é o adm da sala |
| `NAO_E_SUA_VEZ` | `jogarCarta` fora da sua vez |
| `CARTA_INVALIDA` | `jogarCarta` com `indice` que não existe na mão de quem mandou |
| `ERRO_INTERNO` | Exceção inesperada no servidor — não deveria acontecer; se aparecer, é bug |

## O que fica fora deste marco (decisão adiada, não esquecida)

- Bot de verdade. `escolherCartaAutomatica` (`game/GameController.js`) hoje
  só devolve a última carta da mão — dá pra validar o mecanismo de
  timeout/flag ponta a ponta, mas não é uma escolha estratégica nenhuma.
  Trocar por algo que jogue com alguma lógica é trabalho futuro.
- Reconectar durante a **sala de espera** (antes da partida começar) não
  existe como conceito separado — hoje uma desconexão nessa fase tira o
  jogador da sala (`sairSala`), então "reconectar" ali é só logar de novo e
  mandar `entrarSala` como se fosse a primeira vez. `reconectar` (evento
  novo) só serve pra partida já em andamento.
- Abandono/forfeit de partida em andamento (hoje só dá pra sair antes de
  começar, via `sairSala` — uma vez que a partida começa, o único jeito de
  "sair" é deixar o timeout jogar automático por você indefinidamente).
- Apostas reais (hoje toda aposta é fixa em 1 — `jogador.aposta = 1` sem
  perguntar nada; só a escolha da carta virou interativa nesse marco).
- Reconexão via `Main2.js`: o harness de CLI não guarda o token entre
  execuções nem oferece a opção "reconectar" no menu — pra testar o fluxo
  de reconexão hoje é preciso emitir o evento manualmente (ou usar os
  testes automatizados, que já cobrem o caminho ponta a ponta).

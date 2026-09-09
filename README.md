# Contra ZAP

![CI](https://github.com/Henryblh/Contra-Zap/actions/workflows/ci.yml/badge.svg)

Jogo de cartas estilo truco, multiplayer, jogado no navegador. Motor de regras
em Node.js, comunicação em tempo real via Socket.io, front-end em React.

## Pré-requisitos

[Node.js](https://nodejs.org/) **22 ou superior** — o `better-sqlite3@13`
exige. Em versões anteriores o servidor trava com segfault na primeira
operação de banco, sem erro claro. Confira com `node -v` (ou use o Docker,
que não depende da sua versão local).

## Rodar

```
node GameStart.js
```

Instala dependências, builda o front e sobe o servidor. Quando terminar, abra
**[localhost:3000](http://localhost:3000)**.

Passo a passo, se preferir:

```
npm install
cd public/app && npm run build && cd ../..
npm start
```

> Só pode haver **um** `Server.js` rodando por vez — feche (`Ctrl+C`) qualquer
> outro antes.

## Rodar com Docker

Não precisa de Node na versão certa — tudo isolado no container. Precisa do
[Docker Desktop](https://www.docker.com/products/docker-desktop) instalado.

```
touch banco.sqlite jwt.secret     # só na primeira vez
docker compose up --build
```

Abra [localhost:3000](http://localhost:3000). `docker compose down` pra parar.
Saúde do servidor: `curl http://localhost:3000/health`.

## Testes

```
npm test
```

Test runner nativo do Node (`node --test`), sem dependência extra.

## Estrutura

```
game/         regras do jogo (baralho, cartas, mesa, rodada). Não conhece rede.
  GameController.js   orquestra uma partida e expõe o andamento como eventos
bots/         jogadores controlados por IA (Bot.js + BotBrain.js, redes de RL)
conexao/      camada de sala/rede
  PROTOCOLO.md        contrato dos eventos socket.io — leia antes de mexer no protocolo
  socketServer.js     única peça que conhece socket.io
  SalaManager.js      cria salas, valida entrada, aplica cooldown de chat
  db.js jwt.js login.js cadastro.js convidado.js retomarSessao.js   auth/sessão
  chat/               validação e catálogo do chat de sala
public/app/   front-end (React + Vite) — código-fonte em src/
public/dist/  build do front (gerado por `npm run build`, servido pelo Server.js)
Server.js     servidor web (Express + Socket.io)
GameStart.js  atalho: instala + builda + sobe, tudo de uma vez
```

## O que já funciona

- Motor de jogo completo: apostas, vazas, manilha, eliminação por hp, teto de
  baralhos por partida (`maxDeck`).
- Autenticação (login/cadastro com senha em hash), sessão via JWT retomável
  sem senha depois de F5 ou queda de rede.
- Salas multiplayer ponta a ponta: criar, entrar, listar, sair, início
  automático ou forçado pelo dono; partida rápida (fila compartilhada).
- Partida real via socket.io: jogadas, mão privada, vazas, placar em tempo
  real, chat de sala com cooldown no servidor.
- Timeout de turno, expulsão por inatividade, reconexão de quem caiu.
- Bots preenchem assento e assumem quem for expulso — jogam com redes
  treinadas por RL (ver `training/`).
- "Jogar de novo": sala nova com a mesma config, convite pra quem ficou.
- Interface web em React ponta a ponta (login, lobby, partida).

## Mais

- **`conexao/PROTOCOLO.md`** — todos os eventos socket.io, payloads e erros.
- **`DEV.md`** — workflow de front (Vite), ferramentas de debug, treino de
  bot, backlog técnico e o que ainda falta.

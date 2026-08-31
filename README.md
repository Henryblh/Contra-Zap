# Contra ZAP

Jogo de cartas estilo truco, multiplayer, jogado no navegador. Motor de regras
em Node.js, comunicação em tempo real via Socket.io, front-end em React.

## Pré-requisitos

- [Node.js](https://nodejs.org/) instalado (qualquer versão recente, 18+).

## Como rodar o projeto (comece por aqui)

Se o `Server.js` já estiver rodando em algum terminal seu, **feche ele**
(`Ctrl+C`) antes de continuar — nenhuma das opções abaixo funciona com dois
`Server.js` rodando ao mesmo tempo.

**Opção automática** — execute o comando para: (instala dependências, builda
o front-end e sobe o servidor)
```
node GameStart.js
```
(ou `npm run gamestart`, é a mesma coisa). Espere terminar e abra
[localhost:3000](http://localhost:3000).

**OU, manualmente, passo a passo:**

1. Instale as dependências, na raiz do projeto:
   ```
   npm install
   ```
2. Gere o build do front-end:
   ```
   cd public/app
   npm run build
   ```
3. Volte pra raiz do projeto e, num terminal separado, suba o servidor:
   ```
   npm start
   ```
4. Abra [localhost:3000](http://localhost:3000) no navegador.

Qualquer uma das duas formas é suficiente pra ter o sistema completo rodando
(login, salas, partida) do jeito que vai pra "produção".

### Mexendo no front-end (React)

`public/dist` (o que o `Server.js` serve) só é atualizado quando você roda
`npm run build` — reiniciar o `Server.js` sozinho **não** reflete mudanças em
`public/app/src`. Pra não ter que buildar toda hora enquanto desenvolve:

1. Num terminal, na raiz: `npm start` (sobe só o back-end, porta 3000).
2. Em outro terminal, dentro de `public/app`: `npm run dev` (sobe o Vite,
   porta 5173, já configurado em `vite.config.js` pra proxiar `/socket.io`
   pro back-end em `:3000`).
3. Abra `localhost:5173` — qualquer edição em `public/app/src` aparece na
   hora, sem precisar buildar nem reiniciar nada.

O código do front fica todo em `public/app/src`:
- `App.jsx` — componente raiz, decide qual tela mostrar.
- `socket.js` — conexão com o back-end via socket.io-client.
- `components/Login.jsx`, `Lobby.jsx`, `Partida.jsx` — as três telas
  principais (login/cadastro, sala de espera, partida em si).

**Antes de mexer no protocolo de eventos (o que o cliente manda/recebe do
servidor), leia `conexao/PROTOCOLO.md`** — é a fonte de verdade de todos os
eventos socket.io, payloads e erros possíveis.

## Estrutura do projeto

```
game/              -> regras do jogo (baralho, cartas, mesa, rodada, jogadores),
                      não sabe nada sobre servidor, socket ou front-end
  GameController.js  -> orquestra uma partida inteira e emite eventos (mão distribuída,
                         carta jogada, vaza fechada, etc.)
  idEfemero.js        -> fonte única de ids negativos pra Player sem linha no banco
                         (compartilhada por bots/Bot.js e conexao/convidado.js)
bots/              -> jogadores controlados pelo computador
  Bot.js              -> um "jogador" sem socket (id negativo, nunca desconecta)
  BotBrain.js         -> decide jogada/aposta automática — hoje um placeholder burro
conexao/           -> camada de sala/rede, separada das regras do jogo
  eventos.js          -> vocabulário do protocolo (nomes de evento, códigos de erro)
  PROTOCOLO.md        -> contrato dos eventos socket.io (payloads, fluxo, erros)
  db.js               -> persistência de usuários em SQLite (única peça que sabe SQL)
  jwt.js              -> emite e verifica o token de sessão (JWT assinado, HS256)
  login.js            -> autentica nome/senha contra o banco e emite token de sessão
  cadastro.js         -> cria conta nova (nome/senha) e já autentica, mesmo formato do login
  convidado.js        -> login "convidado": só nome, Player só em memória (id negativo), nunca grava no banco
  SalaManager.js      -> cria salas e valida entrada de jogadores (sem saber de socket.io)
  socketServer.js     -> liga o protocolo a sockets de verdade (única peça que conhece socket.io)
  chat/               -> validação e catálogo de mensagens do chat de sala
public/app/        -> código-fonte do front-end (React + Vite)
  src/App.jsx         -> componente raiz
  src/socket.js       -> conexão socket.io-client com o back-end
  src/components/     -> telas (Login, Lobby, Partida)
public/dist/       -> build do front-end (gerado por `npm run build`, servido pelo Server.js)
Server.js          -> servidor web (Express + Socket.io), liga `conexao/socketServer.js`
GameStart.js       -> atalho: instala dependências, builda o front e sobe o Server.js, tudo de uma vez
banco.json         -> fixture inicial de usuários, usada só pra semear o banco.sqlite na 1ª execução
banco.sqlite       -> banco de verdade (gerado automaticamente, não versionado)
jwt.secret         -> segredo de assinatura do JWT (gerado automaticamente, não versionado)
index.js           -> ponto de entrada do módulo (exporta as classes do jogo)
```

## Como rodar os testes

```
npm test
```

Usa o test runner nativo do Node (`node --test`) — sem dependência extra.

## Status atual

- ✅ Motor de jogo completo: apostas, vazas, manilha, eliminação por hp.
- ✅ Autenticação (login/cadastro com senha em hash) e sessão via JWT.
- ✅ Login em etapas, estilo Pokémon Showdown: digita só o nome primeiro
  (`verificarNome`); se já existe conta, pede senha pra confirmar identidade
  (`entrar`); se não existe, pergunta se quer registrar (`cadastrar`) ou
  seguir sem conta como **convidado** (`entrarComoConvidado` — Player só em
  memória, id negativo, nunca grava no banco). Não existe botão de "guest"
  solto — é sempre consequência de responder "não" à oferta de cadastro.
- ✅ Salas multiplayer ponta a ponta: criar, entrar, listar, sair, início
  automático quando lota (ou forçado pelo dono).
- ✅ **Partida rápida**: fila compartilhada de sala com config default — quem
  clica primeiro cria, quem clica depois entra na mesma até ela lotar; o
  jeito manual de criar sala continua existindo do lado do cliente.
- ✅ Partida real via socket.io: jogadas, mão privada por jogador, vazas,
  placar, tudo em tempo real.
- ✅ Timeout de turno com jogada automática (placeholder simples) + jogador
  expulso por inatividade de verdade (várias faltas seguidas, não uma só) +
  reconexão de quem caiu no meio da partida, exatamente do mesmo jeito.
- ✅ **Jogar de novo**: quando a partida termina, o dono da sala pode criar
  uma sala nova com a mesma config (incluindo o mesmo número de bots) e
  ficar esperando nela; quem mais estava na sala antiga recebe um convite
  (sim entra na sala nova, não sai pro menu).
- ✅ Estrutura de bots pronta (pasta `bots/`, `botNumber` na criação de sala,
  campo pra escolher no lobby): um bot entra igual um jogador, sem socket, e
  assume o assento de um jogador de verdade quando ele é expulso por
  inatividade. Falta só a inteligência de verdade (ver "o que falta fazer").
- ✅ **Expiração de vaga reservada**: depois que um assento vira bot
  (`jogadorExpulsoPorInatividade`, por inatividade real ou `sairDaPartida`),
  a vaga fica reservada por `tempoReservaMs` (150s por padrão). Sem
  `reconectar` real nesse prazo, o servidor avisa (`vagaExpirada`) e a vaga
  não pode mais ser reclamada — `reconectar` passa a devolver `VAGA_EXPIRADA`
  e `minhaSalaAtiva` para de oferecer aquela sala pro cliente (sem botão de
  reconectar automático). Não existe "outra pessoa pode entrar no lugar" —
  decisão consciente: ninguém quer pegar uma mão alheia no meio de uma
  partida. Se essa era a última vaga de gente de verdade da sala, ela é
  removida do sistema na mesma hora (some de tudo, `SALA_NAO_ENCONTRADA` daí
  em diante); o jogo, agora só bot contra bot, termina sozinho em segundo
  plano.
- ✅ **Limpeza de sala após o fim da partida**: uma `Sala` finalizada
  (`jogoFinalizado` já disparou) não fica mais presa pra sempre no `Map` do
  `SalaManager`. Assim que ninguém mais estiver conectado na room dela —
  saiu, recusou ou aceitou a revanche, ou só fechou a aba — a sala é
  descartada do sistema na hora, sem depender de nenhum timer.
- ✅ **Sucessão de adm durante a partida**: se quem é adm tiver a vaga
  expirada (ver acima), o posto passa pro próximo jogador de verdade na
  ordem de entrada (`novoAdm`) — nunca fica preso num assento que virou bot
  pra sempre. Enquanto a vaga só está reservada (ainda não expirou), o adm
  não muda: ele recupera o posto sozinho ao reconectar, porque a flag nunca
  saiu dele.
- ✅ Interface web em React funcionando ponta a ponta (login, lobby, partida).

## Ferramentas de debug (linha de comando)


- `node Main.js` — simula uma partida inteira com 4 jogadores fixos, sem
  rede nenhuma, jogadas automáticas. Bom pra testar regras do `game/` isoladas.
- `node Main2.js` — conecta num `Server.js` já rodando como um jogador de
  verdade (login + criar/entrar em sala) via terminal. Rode até 4 instâncias
  em terminais separados pra simular uma mesa completa. Use nomes de
  `banco.json` (ex.: `henrique`/`123`).
- Com bots preenchendo assento, dá pra criar uma sala 100% automática
  (`numberPlayers: 2, botNumber: 1` com só você) — bom caso de teste pra
  validar o motor inteiro sem precisar de mais gente.

## O que falta fazer

Gaps estruturais de verdade — o motor/protocolo tem um buraco real, não é só
polimento.

- **Lógica de verdade dos bots** (`bots/BotBrain.js`) — hoje é só um
  placeholder burro (sempre a última carta, sempre aposta 1). A estrutura já
  tá pronta pra trocar isso sem mexer em mais nada; o plano é evoluir pra uma
  estratégia melhor e, mais pra frente, treinar com ML.
- Subir o servidor num ambiente de verdade, com sockets web funcionando fora
  da rede local (hoje só foi testado em `localhost`).
- O cooldown de chat (`CHAT_COOLDOWN_MS`) só existe no front — o servidor
  aceita qualquer volume de `chat` que passe na validação de tipo/tamanho.
  Um cliente customizado pode spammar a sala inteira sem limite nenhum.
- O JWT emitido em `entrar`/`cadastrar`/`entrarComoConvidado` nunca é
  validado em produção (`validarToken`, em `login.js`, só é chamado no
  teste) — e o front nem guarda o token (de propósito, ver `socket.js`).
  Hoje ele não serve pra nada além de existir; se a ideia é reaproveitar
  sessão depois de uma queda de conexão sem pedir nome/senha de novo, esse é
  o gancho certo.
- `socket.js` não escuta `disconnect`/`reconnect` do socket.io-client —
  precisa expor isso como uma flag de estado de conexão pro front consumir,
  pra dar algum feedback visual quando a rede cai (hoje o jogador só percebe
  quando uma ação falhar).


### PIN — só mexer se alguém reclamar

Fica pra depois de propósito: pro escopo e tipo de sistema, o custo de fazer
não parece compensar o ganho agora.

- `Player.rate` / ranking: existe desde sempre (banco, classe,
  getter/setter) mas nunca é lido nem atualizado em lugar nenhum. No melhor
  dos casos é a última coisa que fazemos no projeto; no pior, nunca usamos.
  Juntar gente de nível parecido em salas ranqueadas depende disso e cai na
  mesma categoria.
- Placar/histórico entre partidas (não só o hp da partida atual) e persistir
  qualquer coisa além de conta de usuário (`banco.sqlite` só guarda nome +
  hash de senha hoje — salas, placar, quem jogou o quê vivem só na memória e
  somem num restart).

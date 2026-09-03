# Contra ZAP

![CI](https://github.com/Henryblh/Contra-Zap/actions/workflows/ci.yml/badge.svg)

Jogo de cartas estilo truco, multiplayer, jogado no navegador. Motor de regras
em Node.js, comunicação em tempo real via Socket.io, front-end em React.

## Pré-requisitos

- [Node.js](https://nodejs.org/) **22 ou superior** (o `better-sqlite3@13`
  exige Node ≥ 22 — versões anteriores rodam, mas travam com segfault na
  primeira operação de banco, sem mensagem de erro clara. Se for rodar sem
  Docker, confirme sua versão com `node -v` antes de reportar bug).

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

## Como rodar com Docker

Alternativa que não depende de ter Node instalado na versão certa na sua
máquina — tudo roda isolado em container.

**Pré-requisito**: [Docker Desktop](https://www.docker.com/products/docker-desktop)
instalado e rodando.

1. Na raiz do projeto, na primeira vez, crie os arquivos que o SQLite/JWT
   geram sozinhos (evita o Docker criar pasta no lugar de arquivo):
   ```
   touch banco.sqlite jwt.secret
   ```
2. Suba o container:
   ```
   docker compose up --build
   ```
3. Abra [localhost:3000](http://localhost:3000).

Pra rodar em segundo plano (sem prender o terminal):
```
docker compose up -d --build
```

Pra parar:
```
docker compose down
```

### Verificando se o servidor está saudável

```
curl http://localhost:3000/health
```

Deve retornar algo como `{"status":"ok","uptime":...,"timestamp":"..."}`.
O Docker também monitora isso sozinho — `docker compose ps` mostra
`(healthy)` depois de alguns segundos de container de pé.

### Por que a imagem usa Node 22 + Alpine

Só documentando pra ninguém precisar redescobrir isso: o binário nativo do
`better-sqlite3` não tem prebuild compatível pra Node 20, e a combinação
certa (Node 22 + musl/Alpine + arm64) ainda assim exige compilar o addon do
zero dentro do container — por isso o `Dockerfile` instala `python3 make
g++` mesmo usando Alpine. Trocar a versão do Node no Dockerfile sem
confirmar compatibilidade com o `better-sqlite3` provavelmente quebra o
build de novo.

### CI/CD

Todo push/PR contra a `main` roda automaticamente testes (`npm test`) e o
build da imagem Docker via GitHub Actions — ver `.github/workflows/ci.yml`.

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
  retomarSessao.js    -> reautentica um socket a partir de um token já emitido, sem nome/senha
  SalaManager.js      -> cria salas e valida entrada de jogadores (sem saber de socket.io)
  socketServer.js     -> liga o protocolo a sockets de verdade (única peça que conhece socket.io)
  chat/               -> validação e catálogo de mensagens do chat de sala
public/app/        -> código-fonte do front-end (React + Vite)
  src/App.jsx         -> componente raiz
  src/socket.js       -> conexão socket.io-client com o back-end
  src/sessao.js       -> persistência da sessão (sessionStorage) e retomada depois de reconexão/F5
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
- ✅ Autenticação (login/cadastro com senha em hash), sessão via JWT
  retomável sem senha de novo depois de um F5 ou queda de rede
  (`retomarSessao`).
- ✅ Login em etapas: nome primeiro, depois senha (conta existente) ou
  oferta de cadastro/convidado (conta nova).
- ✅ Salas multiplayer ponta a ponta: criar, entrar, listar, sair, início
  automático (ou forçado pelo dono).
- ✅ Partida rápida: fila compartilhada de sala com config default.
- ✅ Partida real via socket.io: jogadas, mão privada, vazas, placar em
  tempo real.
- ✅ Timeout de turno + expulsão por inatividade + reconexão de quem caiu.
- ✅ Jogar de novo: sala nova com a mesma config, convite pra quem ficou.
- ✅ Bots preenchem assento e assumem quem for expulso por inatividade —
  falta só a inteligência de verdade (ver "o que falta fazer").
- ✅ Vaga fica reservada por um tempo depois de virar bot; expirando sem
  reconectar, não pode mais ser reclamada e, se não sobrar ninguém real, a
  sala é descartada sozinha.
- ✅ Sala é removida do sistema assim que a partida termina e todo mundo sai
  dela.
- ✅ Adm passa pro próximo jogador de verdade se a vaga do adm atual expirar.
- ✅ Cooldown de chat aplicado no servidor, não só de fachada no front.
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

### Avaliador offline de bots

O avaliador reutiliza o motor real da partida, mas não liga modelos treinados
ao servidor. Rode com a venv de `training`:

```powershell
training\.venv\Scripts\python.exe training\python\evaluate.py versus `
  --candidate checkpoint=training\checkpoints\overnight.pt `
  --opponent heuristic --games 10000 --seed 42
```

Também há escalação livre dos quatro assentos:

```powershell
training\.venv\Scripts\python.exe training\python\evaluate.py lineup `
  --players checkpoint=training\checkpoints\overnight.pt heuristic random heuristic
```

Descritores aceitos: `checkpoint=<arquivo.pt>`, `heuristic`, `random` e
`strategy=<módulo>:<Classe>`. Uma estratégia Python deve expor
`act(kind, obs, legal_mask, rng)` e devolver uma ação permitida. O resultado
aparece no console e é salvo como JSON em `training/logs/`.

## O que falta fazer

Gaps estruturais de verdade — o motor/protocolo tem um buraco real, não é só
polimento.

- **Lógica de verdade dos bots** (`bots/BotBrain.js`) — hoje é só um
  placeholder burro (sempre a última carta, sempre aposta 1). A estrutura já
  tá pronta pra trocar isso sem mexer em mais nada; o plano é evoluir pra uma
  estratégia melhor e, mais pra frente, treinar com ML.
- Subir o servidor num ambiente de verdade, com sockets web funcionando fora
  da rede local (hoje só foi testado em `localhost`).

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
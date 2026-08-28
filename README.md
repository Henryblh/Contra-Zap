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
conexao/           -> camada de sala/rede, separada das regras do jogo
  eventos.js          -> vocabulário do protocolo (nomes de evento, códigos de erro)
  PROTOCOLO.md        -> contrato dos eventos socket.io (payloads, fluxo, erros)
  db.js               -> persistência de usuários em SQLite (única peça que sabe SQL)
  jwt.js              -> emite e verifica o token de sessão (JWT assinado, HS256)
  login.js            -> autentica nome/senha contra o banco e emite token de sessão
  cadastro.js         -> cria conta nova (nome/senha) e já autentica, mesmo formato do login
  SalaManager.js      -> cria salas e valida entrada de jogadores (sem saber de socket.io)
  socketServer.js     -> liga o protocolo a sockets de verdade (única peça que conhece socket.io)
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
- ✅ Salas multiplayer ponta a ponta: criar, entrar, listar, sair, início
  automático quando lota (ou forçado pelo dono).
- ✅ Partida real via socket.io: jogadas, mão privada por jogador, vazas,
  placar, tudo em tempo real.
- ✅ Timeout de turno com jogada automática (placeholder simples) + jogador
  expulso por inatividade de verdade (várias faltas seguidas, não uma só) +
  reconexão de quem caiu no meio da partida, exatamente do mesmo jeito.
- ✅ Estrutura de bots pronta (pasta `bots/`, `botNumber` na criação de sala,
  campo pra escolher no lobby): um bot entra igual um jogador, sem socket, e
  assume o assento de um jogador de verdade quando ele é expulso por
  inatividade. Falta só a inteligência de verdade (ver "o que falta fazer").
- ✅ Interface web em React funcionando ponta a ponta (login, lobby, partida).

## Ferramentas de debug (linha de comando)


- `node Main.js` — simula uma partida inteira com 4 jogadores fixos, sem
  rede nenhuma, jogadas automáticas. Bom pra testar regras do `game/` isoladas.
- `node Main2.js` — conecta num `Server.js` já rodando como um jogador de
  verdade (login + criar/entrar em sala) via terminal. Rode até 4 instâncias
  em terminais separados pra simular uma mesa completa. Use nomes de
  `banco.json` (ex.: `henrique`/`123`).

## O que falta fazer

- **Lógica de verdade dos bots** (`bots/BotBrain.js`) — hoje é só um
  placeholder burro (sempre a última carta, sempre aposta 1). A estrutura já
  tá pronta pra trocar isso sem mexer em mais nada; o plano é evoluir pra uma
  estratégia melhor e, mais pra frente, treinar com ML.
- **Botão de "jogar de novo" quando alguém vencer** — hoje `jogoFinalizado`
  é o fim da linha: não existe fluxo pra recomeçar a mesma sala nem pra
  descartá-la. Precisa de: um evento de protocolo novo (algo como
  `jogarNovamente`, só o adm ou todo mundo?), decidir se reaproveita a
  sala/jogadores ou cria uma nova, e o botão em `Partida.jsx` pra disparar
  isso.
- **Limpar sala depois que a partida termina** — hoje uma `Sala` finalizada
  fica pra sempre no `Map` do `SalaManager` (só some da listagem, não da
  memória). Combinar isso com o item acima: sala vira descartável quando
  não tiver mais ninguém nela depois do fim de jogo, ou depois de um tempo
  sem ninguém pedir revanche.
- Subir o servidor num ambiente de verdade, com sockets web funcionando fora
  da rede local (hoje só foi testado em `localhost`).

*ranking: tentar juntar pessoas de um nível similar durante sala ranqueadas, ou casuais

Placar: Algum método de quantificar performance do jogador


*jogadores desconectados a mais de x minutos abrem a sala para jogadores reconectadrem 



### Sugestões pra deixar o motor redondo antes de investir no front

- `Player.rate` existe desde sempre (banco, classe, getter/setter) mas nunca
  é lido nem atualizado em lugar nenhum — se a ideia é ter algum tipo de
  ranking/pontuação entre partidas, esse é o momento de decidir a fórmula e
  ligar isso ao fim de `jogoFinalizado`, antes de esquecer que o campo existe.
- Uma sala em que todo mundo (ou todo mundo que sobrou) virou bot por
  inatividade não tem como terminar sozinha nem ser limpa — ela só segue
  jogando bot contra bot pra sempre. Vale um limite (ex.: ninguém real ativo
  há X minutos → encerra a partida) além da limpeza de sala já citada acima.
- Com bots preenchendo assento, dá pra criar uma sala 100% automática
  (`numberPlayers: 2, botNumber: 1` com só você) — bom caso de teste pra
  validar o motor inteiro sem precisar de mais gente, vale ter isso em mente
  ao testar.

# Contra ZAP

Motor de regras de um jogo de cartas estilo truco, jogado no console por enquanto (front/conexão em desenvolvimento).

## Pré-requisitos

- [Node.js](https://nodejs.org/) instalado (qualquer versão recente, 18+).

## Como rodar

1. Clone o repositório e entre na pasta do projeto.
2. Instale as dependências:
   ```
   npm install
   ```
3. Rode a partida de teste:
   ```
   node Main.js
   ```

Isso simula uma partida inteira com 4 jogadores fixos (jogadas automáticas — sempre a última carta da mão) e imprime tudo no terminal: mãos, manilha, jogadas, vazas e o vencedor final.

## Como testar a sala multiplayer (login + criar/entrar em sala)

1. Num terminal, suba o servidor:
   ```
   npm start
   ```
2. Em até 4 terminais separados, rode um jogador cada:
   ```
   node Main2.js
   ```
   Cada um pede nome/senha (use qualquer um de `banco.json`, ex.: `henrique`/`123`,
   `piconi`/`123`, `moras`/`123`, `guilherme`/`123`), depois pergunta se você
   quer criar uma sala nova ou entrar numa já aberta. O primeiro cria (e recebe
   um `salaId` pra passar pros outros); os demais escolhem "entrar" e veem a
   sala na lista. Todo mundo na sala vê a lista de jogadores atualizar em
   tempo real conforme cada um entra. Quando a sala lota (padrão 4), a
   partida começa sozinha 15s depois — cada terminal só imprime a própria
   mão (`suaMao` é privado, roteado por jogador) e o resto da partida
   (manilha, jogadas, vazas, vencedor) em tempo real. **Na sua vez**, o
   terminal lista as cartas da mão numeradas e pergunta qual jogar — a
   partida só segue depois que você escolhe (sem timeout ainda: se ninguém
   responder, ela fica esperando).

## Estrutura do projeto

```
game/              -> regras do jogo (baralho, cartas, mesa, rodada, jogadores)
  GameController.js  -> orquestra uma partida inteira e emite eventos (mão distribuída,
                         carta jogada, vaza fechada, etc.)
conexao/           -> camada de sala/rede, separada das regras do jogo
  eventos.js          -> vocabulário do protocolo (nomes de evento, códigos de erro)
  PROTOCOLO.md        -> contrato dos eventos socket.io (payloads, fluxo, erros)
  db.js               -> persistência de usuários em SQLite (única peça que sabe SQL)
  jwt.js              -> emite e verifica o token de sessão (JWT assinado, HS256)
  jwt.test.js          -> testes do token
  login.js            -> autentica nome/senha contra o banco e emite token de sessão
  login.test.js        -> testes do login
  SalaManager.js      -> cria salas e valida entrada de jogadores (sem saber de socket.io)
  SalaManager.test.js -> testes da camada de sala
  socketServer.js     -> liga o protocolo a sockets de verdade (única peça que conhece socket.io)
  socketServer.test.js -> testes de integração ponta a ponta (servidor + clientes reais)
banco.json         -> fixture inicial de usuários (nome/senha em texto puro), usada só pra
                      semear o banco.sqlite na primeira execução
banco.sqlite       -> banco de verdade (gerado automaticamente, não versionado) — senha
                      sempre em hash (bcrypt), nunca texto puro
jwt.secret         -> segredo de assinatura do JWT (gerado automaticamente, não versionado)
Main.js            -> harness de teste: escuta os eventos do GameController e imprime no console
Main2.js           -> harness de um jogador de verdade: login + criar/entrar em sala via socket.io
index.js           -> ponto de entrada do módulo (exporta as classes do jogo)
Server.js          -> servidor web (Express + Socket.io), liga `conexao/socketServer.js`
public/            -> front-end estático (em construção)
```

O jogo em si (pasta `game/`) não sabe nada sobre servidor, socket ou console — só regras.
Dentro de `conexao/`, só o `socketServer.js` sabe o que é um socket.io — `login.js` e
`SalaManager.js` trabalham só com objetos de domínio (`Player`, `Sala`), o que é o que
permite testá-los sem precisar de rede nenhuma.

## Como rodar os testes

```
npm test
```

Usa o test runner nativo do Node (`node --test`) — sem dependência extra.

## Status atual

- ✅ Regras da partida completas (apostas, vazas, manilha, eliminação por hp).
- ✅ Login (nome/senha contra banco SQLite com senha em hash) e token de sessão assinado
  (JWT, expira em 6h, sobrevive a restart do processo) e sala multiplayer (criar, entrar,
  listar salas abertas) funcionando ponta a ponta via socket.io — testado com 4 conexões
  reais simultâneas.
- ✅ Sala cheia → partida começa sozinha (15s de espera, ou na hora se o dono/adm mandar
  `forcarInicio`). Todo evento de jogo é retransmitido pro cliente certo: broadcast de
  sala pra informação pública (jogadas, vazas, manilha, placar), e privado por jogador
  (`suaMao`, via sala pessoal `jogador:<id>`) pra mão de cada um — testado ponta a ponta
  com 4 conexões reais confirmando que ninguém vê a mão de outro jogador.
- ✅ Sair da sala (`sairSala`) antes da partida começar — voluntário ou por desconexão (aba
  fechada, rede caiu tratam igual). Se quem sai é o dono/adm, a posição passa pro próximo;
  sala vazia é descartada. Desconexão **depois** que a partida já começou não mexe no
  roster do jogo, de propósito — é a base pra reconexão futura, não implementada ainda.
- ✅ Jogada real: o `GameController` pausa em cada turno e espera `jogarCarta` (índice da
  carta na mão) em vez de jogar sozinho — `Main2.js` já pede pra escolher a carta na sua
  vez. Isso tira o principal bloqueador estrutural que faltava pra reconexão de verdade
  (agora existe um "onde" pausar); ainda não tem timeout/bot pra quando ninguém responde.
- 🚧 Reconexão de verdade (socket cair e voltar e continuar de onde parou) — token, sala
  pessoal por jogador, roster intacto pós-desconexão e agora a pausa real por turno já dão
  a base; falta só o evento/fluxo do lado do protocolo (reidentificar `socket.id` novo com
  `player.id` já em jogo).
- 🚧 Timeout/bot pra quando o jogador da vez não responde — hoje a partida trava esperando
  pra sempre.
- 🚧 Interface web — em desenvolvimento.

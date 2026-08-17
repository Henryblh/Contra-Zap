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

Isso simula uma partida inteira com 4 jogadores fixos (jogadas automáticas) e imprime tudo no terminal: mãos, manilha, jogadas, vazas e o vencedor final.

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
   tempo real conforme cada um entra.

## Estrutura do projeto

```
game/              -> regras do jogo (baralho, cartas, mesa, rodada, jogadores)
  GameController.js  -> orquestra uma partida inteira e emite eventos (mão distribuída,
                         carta jogada, vaza fechada, etc.)
conexao/           -> camada de sala/rede, separada das regras do jogo
  eventos.js          -> vocabulário do protocolo (nomes de evento, códigos de erro)
  PROTOCOLO.md        -> contrato dos eventos socket.io (payloads, fluxo, erros)
  login.js            -> autentica nome/senha contra banco.json e emite token de sessão
  login.test.js        -> testes do login
  SalaManager.js      -> cria salas e valida entrada de jogadores (sem saber de socket.io)
  SalaManager.test.js -> testes da camada de sala
  socketServer.js     -> liga o protocolo a sockets de verdade (única peça que conhece socket.io)
  socketServer.test.js -> testes de integração ponta a ponta (servidor + clientes reais)
banco.json         -> "banco" provisório de usuários (nome/senha em texto puro — dívida técnica assumida)
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
- ✅ Login (nome/senha contra `banco.json`, token de sessão em memória) e sala multiplayer
  (criar, entrar, listar salas abertas) funcionando ponta a ponta via socket.io — testado com
  4 conexões reais simultâneas.
- 🚧 Iniciar a partida a partir da sala cheia (ligar ao `GameController`) — próximo marco.
- 🚧 Interface web — em desenvolvimento.

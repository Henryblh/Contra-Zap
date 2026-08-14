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


## Estrutura do projeto

```
game/              -> regras do jogo (baralho, cartas, mesa, rodada, jogadores)
  GameController.js  -> orquestra uma partida inteira e emite eventos (mão distribuída,
                         carta jogada, vaza fechada, etc.)
Main.js            -> harness de teste: escuta os eventos do GameController e imprime no console
index.js           -> ponto de entrada do módulo (exporta as classes do jogo)
Server.js          -> servidor web (Express + Socket.io) — ainda não conectado ao jogo
public/            -> front-end estático (em construção)
```

O jogo em si (pasta `game/`) não sabe nada sobre servidor, socket ou console — só regras.
Quem decide o que fazer com os eventos do jogo é quem está escutando (`Main.js` hoje, o futuro
`Server.js` mais pra frente).

## Status atual

- ✅ Regras da partida completas (apostas, vazas, manilha, eliminação por hp).
- 🚧 Conexão entre jogadores (multiplayer via Socket.io) — em desenvolvimento.
- 🚧 Interface web — em desenvolvimento.

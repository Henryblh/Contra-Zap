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
   `piconi`/`123`, `moras`/`123`, `guilherme`/`123` — ou cadastre uma conta nova via
   evento `cadastrar`, `Main2.js` não tem prompt pra isso ainda), depois pergunta se você
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

## Como rodar a interface web (front-end React)

O `Server.js` (porta 3000) serve arquivos estáticos de `public/dist` — **não**
tem hot-reload embutido nesse fluxo. `public/dist` só é gerado/atualizado por
um build explícito (`npm run build` dentro de `public/app`); reiniciar o
`Server.js` sozinho não reflete nenhuma mudança no `public/app/src`, porque
ele não sabe nada sobre o código-fonte, só serve o que já está buildado.

Duas formas de rodar, dependendo do que você quer:

- **Testar como em produção** (build único, sem hot-reload):
  ```
  cd public/app
  npm run build
  ```
  Depois suba/mantenha `npm start` na raiz e abra `localhost:3000`. Repita o
  `npm run build` a cada mudança no front — e dê um hard refresh
  (`Ctrl+Shift+R`) no navegador pra não pegar cache antigo.

- **Desenvolvendo o front** (hot-reload automático, recomendado no dia a dia):
  1. Num terminal, na raiz: `npm start` (sobe só o backend, porta 3000).
  2. Em outro terminal, dentro de `public/app`: `npm run dev` (sobe o Vite,
     porta 5173, já configurado em `vite.config.js` pra proxiar `/socket.io`
     pro backend em `:3000`).
  3. Abra `localhost:5173` — qualquer edição em `public/app/src` aparece na
     hora, sem precisar buildar nem reiniciar nada.

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
  cadastro.js         -> cria conta nova (nome/senha) e já autentica, mesmo formato do login
  cadastro.test.js     -> testes do cadastro
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
  roster do jogo, de propósito.
- ✅ Jogada real: o `GameController` pausa em cada turno e espera `jogarCarta` (índice da
  carta na mão) em vez de jogar sozinho — `Main2.js` já pede pra escolher a carta na sua
  vez.
- ✅ Timeout de turno + reconexão: cada turno tem um prazo (`tempoTurnoMs` no
  `GameController`, 15s por padrão) — se estourar, o servidor joga sozinho (placeholder
  simples: última carta da mão, trocar por bot de verdade é trabalho futuro) e liga uma
  flag `desconectado` naquele jogador. O evento `reconectar` reencaixa quem voltou numa
  partida já em andamento (devolve mão atual + de quem é a vez) e desliga a flag — testado
  ponta a ponta: cair na própria vez aciona a jogada automática, reconectar limpa a flag.
- ✅ Cadastro de conta nova (`cadastrar`) — nome/senha com pelo menos 3 caracteres, nome
  único (a constraint do banco é a única fonte de verdade pra isso, não um SELECT antes),
  senha sempre em hash. Já devolve token autenticado, sem precisar de `entrar` depois.
- 🚧 Interface web — em desenvolvimento.

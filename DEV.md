# Contra ZAP — notas de desenvolvimento

Tudo que é detalhe de quem mexe no código. Pra rodar o projeto, ver o
`README.md`. Pro contrato de eventos socket.io, ver `conexao/PROTOCOLO.md`.

---

## Mexendo no front-end (React)

`public/dist` (o que o `Server.js` serve) só é atualizado quando você roda
`npm run build` — reiniciar o `Server.js` sozinho **não** reflete mudanças em
`public/app/src`. Pra não ter que buildar toda hora enquanto desenvolve:

1. Num terminal, na raiz: `npm start` (sobe só o back-end, porta 3000).
2. Em outro terminal, dentro de `public/app`: `npm run dev` (sobe o Vite,
   porta 5173, já configurado em `vite.config.js` pra proxiar `/socket.io`
   pro back-end em `:3000`).
3. Abra `localhost:5173` — qualquer edição em `public/app/src` aparece na
   hora, sem precisar buildar nem reiniciar nada.

Quando terminar, **rode `npm run build`** antes de commitar — o servidor de
"produção" serve o `public/dist`, não o Vite.

O código do front fica todo em `public/app/src`:
- `App.jsx` — componente raiz, decide qual tela mostrar.
- `socket.js` — conexão com o back-end via socket.io-client.
- `sessao.js` — persistência da sessão (sessionStorage) e retomada depois de
  reconexão/F5.
- `components/Login.jsx`, `Lobby.jsx`, `Partida.jsx` — as três telas
  principais (login/cadastro, sala de espera, partida em si).

**Antes de mexer no protocolo de eventos (o que o cliente manda/recebe do
servidor), leia `conexao/PROTOCOLO.md`** — é a fonte de verdade de todos os
eventos socket.io, payloads e erros possíveis.

---

## Docker — por que Node 22 + Alpine

Só documentando pra ninguém precisar redescobrir isso: o binário nativo do
`better-sqlite3` não tem prebuild compatível pra Node 20, e a combinação
certa (Node 22 + musl/Alpine + arm64) ainda assim exige compilar o addon do
zero dentro do container — por isso o `Dockerfile` instala `python3 make
g++` mesmo usando Alpine. Trocar a versão do Node no `Dockerfile` sem
confirmar compatibilidade com o `better-sqlite3` provavelmente quebra o
build de novo.

## CI/CD

Todo push/PR contra a `main` roda automaticamente testes (`npm test`) e o
build da imagem Docker via GitHub Actions — ver `.github/workflows/ci.yml`.

---

## Ferramentas de debug (linha de comando)

- `node Main.js` — simula uma partida inteira com 4 jogadores fixos, sem
  rede nenhuma, jogadas automáticas. Bom pra testar regras do `game/`
  isoladas.
- `node Main2.js` — conecta num `Server.js` já rodando como um jogador de
  verdade (login + criar/entrar em sala) via terminal. Rode até 4 instâncias
  em terminais separados pra simular uma mesa completa. Use nomes de
  `banco.json` (ex.: `henrique`/`123`).
- Com bots preenchendo assento, dá pra criar uma sala 100% automática
  (`numberPlayers: 2, botNumber: 1` com só você) — bom caso de teste pra
  validar o motor inteiro sem precisar de mais gente.
- `criarSala` aceita `seed` (inteiro): fixa o embaralhamento, então a mesma
  seed reproduz a partida carta por carta — e o resultado bate com o motor
  Python de `training/`. Ausente = aleatório de sempre.

---

## Treino de bot (RL)

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

### Treino contra liga

O treinador aceita um manifesto de liga com checkpoints congelados e executa
PPO somente nos assentos controlados pelo aprendiz. A mistura usada no
experimento evolutivo é 50% self-play, 35% campeões históricos selecionados
por PFSP e 15% âncoras (H, overnight, heurístico e aleatório). O orquestrador
em `training/python/orquestrar_4dias.py` gera esses manifestos, preserva
checkpoints completos e usa torneios no motor JavaScript para a seleção.

### Paridade JS × Python

O motor em `training/python/motor/` é um porte fiel do `game/` JS. Com a
mesma `seed`, os dois distribuem a partida idêntica — `game/seed.test.js` e
`training/python/test_seed.py` pinam a mesma referência (`seed 999`); se um
lado divergir, o teste do lado que mudou quebra.

---

## O que falta fazer

Gaps estruturais de verdade — o motor/protocolo tem um buraco real, não é só
polimento.

- **Rede de RL só treinou com 4 assentos** (`bots/BotBrain.js`, `training/`)
  — hoje ela joga em qualquer sala de 2 a 6 via `ajustarParaModelo()`
  (encaixe/corte de assento, ver comentário lá), o que cobre 2–3 bem mas
  deixa 5–6 fora da distribuição de treino (jogada coerente, mas fraca).
  Falta treinar com nº de assentos variável ou uma rede dedicada a 5–6.
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
- Desempate quando **todos** morrem na mesma rodada: hoje é "hp mais perto de
  0, empate → quem chegou primeiro" (`GameController._resolverFimDeJogo`),
  marcado como provisório. O time ainda vai decidir o critério definitivo.
- Sobras do grupo 1 (segurança) — baixo risco no cenário atual de dois jeitos
  diferentes: os dois primeiros abaixo são de boas incondicionalmente; os
  dois últimos são de boas só porque nada no sistema hoje consegue disparar
  o cenário ruim (não é que o código seja à prova disso — é que a
  funcionalidade que abriria a brecha ainda não existe):
  - 🟢 `jwt.secret` gerado sem flag `wx` (`jwt.js`) — só dá problema se duas
    instâncias subirem pela primeira vez ao mesmo tempo, sem o arquivo ainda
    existir.
  - 🟡 Sem HTTPS/wss — item de produção puro, sem efeito nenhum em `localhost`.
  - 🟡 `retomarSessao` não confere se a conta ainda existe (`retomarSessao.js`)
    — inofensivo porque não existe NENHUMA forma de apagar/renomear/banir
    conta no sistema ainda; some da lista de "de boas" no dia que isso mudar.
  - 🟡 Contador de `idEfemero.js` reinicia em -1 a cada restart, mas token de
    convidado vale 6h → risco de colisão de id — só bate numa sessão longa
    com restart no meio e convidado com token ainda válido rondando; uma
    demo curta sem restart não passa perto disso.

---

## Backlog técnico — auditoria de backend

Legenda: 🔴 bug/segurança · 🟡 robustez/produção · 🟢 limpeza/doc.

### 5. QA / Validação de comportamento
19. 🟡 Falta Testes Para confirmar paridade de regra JS × motor Python em treinamento

### 6. Documentação vs código
20. 🟡 README seção Docker: o passo `touch banco.sqlite jwt.secret` ficou sem efeito (volumes do compose comentados). Depende de decidir sobre os volumes (item 49). `README.md`

### 7. Operação / produção / DevOps
42. 🔴 `Server.js` ignora `process.env.PORT` (`server.listen(3000)` fixo) — Docker/compose setam `PORT` esperando que valha. `Server.js`
43. 🟡 `express.static('public/dist')` e `sendFile(__dirname + '/public/dist/...')` usam caminho relativo/concatenação. Usar `path.join`. `Server.js`
44. 🔴 Sem shutdown gracioso (SIGTERM/SIGINT): drenar conexões, `wal_checkpoint`, `db.close()`. `Server.js`, `db.js`
45. 🔴 Sem `uncaughtException`/`unhandledRejection` — um throw num `setTimeout` do `GameController` derruba o servidor inteiro. `Server.js`
46. 🟡 Log tudo em `console.*`, sem nível/timestamp/JSON/request-id.
47. 🟢 `/health` sempre 200 mesmo com o banco quebrado. `Server.js`
48. 🟡 Arquitetura single-process em memória + socket.io sem adapter → não escala horizontalmente.
49. 🔴 `docker-compose.yml`: volumes comentados → `banco.sqlite`/`jwt.secret` só no container; todo `up --build` perde contas e rotaciona o JWT. O `touch` do README ficou sem sentido. `docker-compose.yml`
50. 🟡 `docker-compose.yml` fixa `platform: linux/arm64` → quebra em host/CI amd64. `docker-compose.yml`
51. 🔴 `Dockerfile` não builda o front — **agora que `public/dist` saiu do git, virou pré-requisito pra imagem subir com frontend.** `Dockerfile`
52. 🟢 `Dockerfile` linha `RUN find node_modules/better-sqlite3 -name "*.node"` — debug sobrando. `Dockerfile`
53. 🟢 `Dockerfile` sem multi-stage: imagem final carrega `python3 make g++`. `Dockerfile`
54. 🟡 `.dockerignore` não exclui `training/` (`.venv`), `public/app/node_modules`, `banco.sqlite-*`. `.dockerignore`
55. 🔴 CI roda zero teste de backend: `conexao/*.test.js` são gitignorados; num checkout limpo `npm test` não acha nada e sai 0. `ci.yml`, `package.json`
56. 🟢 `GameStart.js` roda `npm install` toda vez sem checar `node_modules`; não repassa SIGINT pro filho. `GameStart.js`

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
2. Cliente manda `verificarNome` só com o nome pra saber se já existe conta,
   e então um de `entrar` (nome/senha, conta existente), `cadastrar`
   (nome/senha, conta nova) ou `entrarComoConvidado` (só nome, sem conta) ->
   servidor autentica (contra o banco nos dois primeiros, via
   `conexao/login.js`/`conexao/cadastro.js`/`conexao/db.js`; só em memória no
   terceiro, via `conexao/convidado.js`) e associa `socket.id` a um `Player`
   pelo resto da conexão. Devolve um token JWT (`conexao/jwt.js`).
   O socket também entra numa sala pessoal `jogador:<id>` — é pra lá que vai
   qualquer informação privada do jogador (hoje só a mão, `suaMao`).
   Alternativa aos três: `retomarSessao` (só o token, sem nome/senha) — ver
   seção própria abaixo. É o caminho usado depois de um F5 na página ou de
   uma reconexão de rede, quando o cliente já tem um token de uma
   autenticação anterior (de qualquer um dos quatro caminhos, incluindo um
   `retomarSessao` anterior).
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
   `turnoAposta` (um jogador por vez, na ordem da rodada — a resposta de um
   pode influenciar o próximo) esperando `apostar`, e depois em cada
   `turnoJogador`, esperando o jogador daquela vez mandar `jogarCarta` — só
   aí segue pra próxima jogada, até `jogoFinalizado`.

## Eventos cliente -> servidor

### `verificarNome`
Payload: `{ nome: string }`
Pré-condição: nenhuma (pode ser o primeiro evento da conexão — não exige
`entrar` antes, nem autentica o socket).
Ack sucesso: `{ ok: true, existe: boolean }` — `nome` (depois de `trim`) já
tem conta cadastrada? É só uma consulta, sem efeito colateral nenhum.
Erros possíveis: `MUITAS_TENTATIVAS` (rate-limit por IP, ver abaixo) — `nome`
ausente/não-string, ou maior que 24 caracteres (`conexao/limites.js` — nenhuma
conta de verdade passa disso), devolve `existe: false` em vez de erro.

Rate-limit por IP (`conexao/rateLimiter.js`, 20 tentativas a cada 5 minutos
por padrão): sem `entrar` prévio pra identificar quem pergunta, este evento
seria um oráculo livre de enumeração de contas (varrer uma lista de nomes e
descobrir quais existem). O teto é generoso pra uso real — o cliente só
chama isto uma vez por clique em "Continuar" no login, nunca por tecla
digitada.

Existe pra decidir, no fluxo de login em etapas (estilo Pokémon Showdown), o
que o cliente pede a seguir: se `existe`, pede senha pra confirmar
identidade (`entrar`); senão, oferece registrar o nome (`cadastrar`) ou
seguir sem conta (`entrarComoConvidado`). Não existe botão de "entrar como
convidado" solto na interface — é sempre consequência de responder "não" a
essa oferta.

### `entrar`
Payload: `{ nome: string, senha: string }`
Pré-condição: nenhuma.
Ack sucesso: `{ ok: true, nome, token }`.
Erros possíveis: `USUARIO_NAO_ENCONTRADO`, `SENHA_INCORRETA`, `MUITAS_TENTATIVAS`
(rate-limit por IP, ver abaixo), `JA_AUTENTICADO` (socket já é OUTRA conta —
ver seção "Reautenticação num socket já autenticado" mais abaixo; logar de
novo como a MESMA conta é permitido).

Rate-limit de **login falhado** por IP (`conexao/rateLimiter.js`, 5 falhas a
cada 20 minutos por padrão) — sem isto, o único freio contra brute-force de
senha era o custo do próprio bcrypt (~70ms por tentativa). `USUARIO_NAO_ENCONTRADO`
e `SENHA_INCORRETA` contam igual pra esse teto (as duas são "falha"; contar
diferente vazaria se o nome existe pelo padrão de bloqueio, o mesmo problema
do timing oracle). Um login com **sucesso** não gasta a cota de ninguém.
Estourou o teto, o servidor nem chega a chamar `login()` — devolve
`MUITAS_TENTATIVAS` na hora, sem pagar o custo do bcrypt. A resposta de erro
da falha que **consumiu a última unidade** da janela vem com
`ultimaTentativa: true` além de `codigo`/`mensagem` — é o sinal pro cliente
avisar "essa foi sua última tentativa" antes do bloqueio de verdade.

`nome` maior que 24 caracteres ou `senha` maior que 72 (`conexao/limites.js`)
também são recusados na hora, sem tocar banco nem bcrypt — nenhuma conta de
verdade pode ter nome/senha fora desses tetos (impostos em `cadastrar`), então
uma string gigante aqui não pode ser um login real de qualquer jeito. Mesmo
`USUARIO_NAO_ENCONTRADO` de sempre; não é informação nova (o cliente já vê o
`maxLength` do próprio campo). Só o MÁXIMO é checado — `entrar` nunca recusa
por senha curta, senão contas antigas com senha menor que o mínimo de
`cadastrar` atual parariam de autenticar.

### `cadastrar`
Payload: `{ nome: string, senha: string }` — `nome` precisa ter entre 3 e 24
caracteres depois do `trim`; `senha` precisa ter entre 8 e 72 caracteres
(limites em `conexao/limites.js`, únicos pros dois — sem teto, uma string
gigante em qualquer um dos dois vira custo de CPU/memória de graça pra quem
manda: hash bcrypt de um buffer enorme, linha sem limite no SQLite, JWT
inchado, e — só `nome` — ecoado em todo broadcast de sala). O mínimo de 8 na
senha é reforço mesmo, não só teto: só vale pra cadastro **novo** — contas
já existentes (inclusive as de `banco.json`, senha "123") continuam
autenticando normalmente, `entrar` nunca cobra mínimo, só o máximo de 72 (ver
abaixo).
Pré-condição: nenhuma (alternativa a `entrar` pra quem ainda não tem conta).
Ack sucesso: `{ ok: true, nome, token }` — mesmo formato de `entrar`; a
conta já nasce autenticada, não precisa de um `entrar` separado depois.
Erros possíveis: `CADASTRO_INVALIDO` (nome/senha fora dos limites acima),
`NOME_JA_CADASTRADO`, `MUITAS_TENTATIVAS` (rate-limit por IP, ver abaixo),
`JA_AUTENTICADO` (socket já autenticado — ver seção própria mais abaixo;
cadastro sempre cria identidade nova, então aqui **qualquer** socket já
autenticado é barrado, não só "conta diferente").

Rate-limit de **cadastro** por IP (`conexao/rateLimiter.js`, 10 a cada 10
minutos por padrão) — `cadastrar` é independente de `verificarNome` (nada
obriga chamar um antes do outro, e pra criar conta nova nem faz sentido
checar nome livre antes: um nome inventado quase nunca colide), então sem
isto dava pra martelar `cadastrar` com nomes aleatórios sem limite nenhum.
Diferente do rate-limit de `entrar` (só falha conta), aqui **toda tentativa
conta**, sucesso incluso — cada uma paga um hash de bcrypt de verdade mesmo
quando falha por nome já existente (o hash roda ANTES do INSERT esbarrar na
constraint UNIQUE), competindo pelo mesmo threadpool que `entrar` de gente
de verdade usa (o threadpool do libuv é só 4 threads por padrão, compartilhado
por TODO bcrypt do processo — ver itens 4/5 do backlog). Estourou o teto, o
servidor nem chama `cadastrar()` — devolve `MUITAS_TENTATIVAS` na hora, sem
pagar bcrypt nenhum.

### `entrarComoConvidado`
Payload: `{ nome: string }` — mesmo limite de `cadastrar` (3 a 24 caracteres
depois de `trim`).
Pré-condição: nenhuma (alternativa a `cadastrar` pra quem respondeu "não"
à oferta de registro depois de um `verificarNome` com `existe: false`).
Ack sucesso: `{ ok: true, nome, token }` — mesmo formato de `entrar`/
`cadastrar`; autentica o socket do mesmo jeito (mesmo `autenticarSocket`,
mesma sala pessoal `jogador:<id>`), então o resto do protocolo (criar/entrar
em sala, jogar) funciona sem diferença nenhuma. A diferença fica só em
`conexao/convidado.js`: o `Player` nasce só em memória, com um id negativo
(nunca colide com os ids `AUTOINCREMENT`, sempre positivos, do banco) e
**nada é gravado em `banco.sqlite`**. A identidade em si sobrevive
normalmente a um F5 na mesma aba (via `retomarSessao`, ver seção própria
abaixo — o token não depende de banco nenhum) e até a um restart do
servidor (a assinatura continua batendo, ver `conexao/jwt.js`) — o que se
perde num restart é qualquer sala/partida em que o convidado estivesse
(o `Map` do `SalaManager` fica vazio de novo), exatamente como aconteceria
com uma conta registrada.
Erros possíveis: `CONVIDADO_INVALIDO` (nome curto demais),
`NOME_JA_CADASTRADO` (alguém registrou esse exato nome entre o
`verificarNome` do cliente e esta chamada — corrida rara, mas a checagem
contra o banco é refeita aqui em vez de confiar só no que o cliente viu
antes), `JA_AUTENTICADO` (socket já autenticado — ver seção própria mais
abaixo; convidado sempre nasce com id novo, então qualquer socket já
autenticado é barrado).

### `retomarSessao`
Payload: `{ token: string }` — um token já emitido por `entrar`, `cadastrar`,
`entrarComoConvidado` ou por um `retomarSessao` anterior.
Pré-condição: nenhuma (mesmo nível dos outros três — pode ser o primeiro
evento da conexão).
Ack sucesso: `{ ok: true, nome, token }` — mesmo formato dos outros três;
autentica o socket do mesmo jeito (`autenticarSocket`, mesma sala pessoal
`jogador:<id>`). O `token` devolvido é **sempre um novo** (mesmo `id`/`nome`
do antigo, prazo e `jti` novos, ver `conexao/jwt.js`) — é assim que uma
sessão que continua sendo retomada de tempos em tempos nunca esbarra na
expiração fixa de 6h do token original.

Existe pra dois casos: um F5 na página (o cliente guarda a sessão em
`sessionStorage`, isolado por aba — ver `public/app/src/sessao.js` — e tenta
retomar assim que o socket conecta, antes de mostrar a tela de login de
novo) e uma reconexão de rede que já estava autenticada (o socket.io-client
reconecta sozinho com um `socket.id` novo, que o servidor nunca viu — sem
isto, a próxima ação qualquer devolveria `NAO_IDENTIFICADO` do nada, mesmo
com a rede já tendo voltado). Nos dois casos, `retomarSessao` só restaura a
**identidade** do socket (a sala pessoal `jogador:<id>`) — se o jogador
estava com assento numa sala/partida, o cliente ainda precisa chamar
`entrarSala`/`reconectar` de novo pra voltar pra room daquela sala
especificamente (o front já faz isso sozinho — ver `Partida.jsx`).

Não faz distinção nenhuma entre conta registrada, cadastrada na hora ou
convidado: `validarToken` (`conexao/login.js`) decodifica o `id`/`nome` do
token sem tocar no banco, então o mesmo caminho serve pros três.
Erros possíveis: `TOKEN_INVALIDO` (assinatura não bate, token expirado, ou
veio ausente/malformado — os três casos colapsam no mesmo código, porque o
cliente reage do mesmo jeito aos três: descarta a sessão salva e volta pro
login normal), `JA_AUTENTICADO` (ver seção abaixo — só se o token decodificar
pra uma conta DIFERENTE da que este socket já é; o mesmo token/conta de novo
é permitido, e precisa continuar sendo — ver abaixo o porquê).

### Reautenticação num socket já autenticado

`entrar`, `cadastrar`, `entrarComoConvidado` e `retomarSessao` são os únicos
quatro eventos que chamam `autenticarSocket` internamente — e ela só dá
`join` na room pessoal nova (`jogador:<id>`), **nunca `leave`** na antiga.
Isso é de propósito (reconectar não deveria precisar saber qual era a
identidade anterior pra "sair" dela primeiro), mas sem um guard, um socket já
autenticado como conta A que chamasse qualquer um desses quatro de novo com
credenciais de conta B ficaria pertencendo às DUAS rooms pessoais ao mesmo
tempo — recebendo `suaMao`/`maosReveladas` privados das duas contas na mesma
conexão. Numa mesa de cartas isso é sério: um cliente customizado (a UI
normal nunca faz isso) poderia entrar com a conta A numa sala, depois com a
conta B — mesmo socket — na MESMA sala (`entrarSala` só checa "esse
`player.id` já está aqui?", que é `false` pra uma conta diferente), e jogar
os dois assentos vendo as duas mãos.

Por isso, os quatro eventos recusam com `JA_AUTENTICADO` se o resultado da
autenticação for uma conta **diferente** da que este socket já é. **Virar a
MESMA conta de novo é permitido** — não é uma troca de identidade, e
`autenticarSocket` é idempotente pra esse caso (reescreve os mesmos mapas,
`join` numa room que já pertence não faz nada). Essa exceção não é só
teórica: o efeito de restaurar sessão salva do front (`App.jsx`) roda dentro
de `React.StrictMode` (`public/app/src/main.jsx`), que em desenvolvimento
invoca esse efeito duas vezes de propósito — disparando dois `retomarSessao`
**reais** pro mesmo token, no mesmo socket, antes do primeiro ack voltar. Sem
a exceção "mesma conta é permitida", isso quebraria a restauração de sessão
toda vez em `npm run dev`.

### `criarSala`
Payload: `{ numberPlayers?: number, roundStart?: number, randomShuffle?: boolean, maxDeck?: number, seed?: number, botNumber?: number, chatAberto?: boolean }`
(todos opcionais — default vem do `SalaManager`: 4 / 3 / true / 50 / — / 0 / false)
`numberPlayers` precisa ser inteiro entre 2 e 6; `roundStart` inteiro entre
1 e 10 (o teto evita montar milhares de baralhos e estourar a memória);
`maxDeck` inteiro entre 1 e 50 — máximo de baralhos de 40 cartas que a
partida monta numa rodada. Enquanto a próxima rodada (mão maior) não couber
nesse teto, a mão para de crescer; volta a crescer quando alguém morre e
libera cartas na mesa. 50 é o topo e vale "Sem Limite" (2000 cartas,
inalcançável). Se `roundStart` com a mesa cheia já não couber em `maxDeck`,
`CONFIGURACAO_INVALIDA`. `seed` (opcional) é a semente do embaralhamento —
inteiro não-negativo; ausente = aleatório de sempre. Com ela a partida fica
reproduzível carta por carta (mesma seed = mesma mesa) e o resultado bate com
o motor Python (`training/python/motor/`). Não é herdada por "jogar de novo".
`botNumber` inteiro entre 0 e `numberPlayers - 1`
(sempre sobra pelo menos o assento de quem criou); `chatAberto` e
`randomShuffle`, se vierem, precisam ser boolean — fora disso,
`CONFIGURACAO_INVALIDA`. `chatAberto` libera o chat de texto livre da sala
(ver evento `chat`); as mensagens prontas não dependem dele.
`botNumber` preenche o resto dos assentos com bots (ver `bots/Bot.js`)
assim que a sala nasce, na ordem de entrada normal — se isso já lotar a
sala, a partida é agendada na hora, igual qualquer `entrarSala` que lote.
Bots não têm socket: não aparecem em `jogadorPorSocket`, nunca desconectam
nem reconectam, e cada turno deles é decidido por `bots/BotBrain.js` e
jogado depois de uma pausa de `atrasoBotMs` (2s por padrão), sem esperar
`tempoTurnoMs` (ver `PlayerGame.bot`).
Pré-condição: socket já mandou `entrar` com sucesso.
Ack sucesso: `{ ok: true, salaId, numberPlayers, jogadores: [{ nome, adm }],
segundosParaIniciar: number | null, chatAberto: boolean }`. O socket já dá `join` na sala;
`jogadores` vem no próprio ack (o dono + os bots que `botNumber` já colocou)
porque o broadcast de `listaJogadores` sai *dentro* deste handler, antes do
ack — um cliente que só registra o listener depois de processar o ack
perderia esse primeiro broadcast pra sempre. Não confie nele pro estado
inicial, só nos que vêm depois. `segundosParaIniciar` é `null` na maioria
dos casos, mas vem preenchido quando `botNumber` já lotou a sala: aí o
`agendarInicio` (e o broadcast de `partidaIniciandoEm`) dispara dentro deste
handler, antes do ack — mesmo motivo de `jogadores` vir aqui.
Erros possíveis: `NAO_IDENTIFICADO`, `CONFIGURACAO_INVALIDA`,
`LIMITE_DE_SALAS` (teto global de salas vivas), `LIMITE_DE_SALAS_POR_JOGADOR`
(você já é adm de salas ativas demais ao mesmo tempo — feche/termine alguma),
`JA_EM_PARTIDA` (você já tem assento numa partida em andamento — a resposta
traz `{ salaId }` dela; reconecte ou `desista` antes).

### `partidaRapida`
Payload: `{}`
Pré-condição: socket já mandou `entrar`/`cadastrar`/`entrarComoConvidado`.
Ack sucesso: mesmo formato de `criarSala`/`entrarSala` — `{ ok: true, salaId,
numberPlayers, jogadores, segundosParaIniciar: number | null, chatAberto }`.
Erros possíveis: `NAO_IDENTIFICADO`, `JA_EM_PARTIDA` (você já tem assento
numa partida em andamento — ver `criarSala`), mais os que `entrarSala` pode
devolver quando cai no caminho de entrar numa sala já existente
(`NOME_INVALIDO` se o nome já estiver em uso nela — caso raro, dois
jogadores com o mesmo nome batendo na fila ao mesmo tempo).

Fila compartilhada de sala com config default (mesmo resultado de
`criarSala` sem parâmetros nenhum — 4 jogadores, 3 cartas na primeira
rodada, sem bots, chat fechado): quem chama primeiro cria essa sala; todo
mundo que chamar depois, enquanto ela continuar aberta (não cheia, não
iniciada), entra nela em vez de criar uma nova — não precisa saber o
`salaId` de antemão. Assim que ela lota (e a partida é agendada, igual
qualquer `entrarSala`/`criarSala` que lote), a próxima chamada cria outra
sala do zero e vira a nova "sala da fila". O jeito manual de criar sala
(`criarSala` com config própria) continua existindo do lado do cliente sem
nenhuma mudança — `partidaRapida` é só um atalho por cima do mesmo
`SalaManager`, não substitui nada.

### `entrarSala`
Payload: `{ salaId: string }`
Pré-condição: socket já mandou `entrar` com sucesso.
Ack sucesso: `{ ok: true, salaId, numberPlayers, jogadores,
segundosParaIniciar: number | null, chatAberto: boolean }`. O socket já dá
`join` na sala; todos os membros (incluindo quem entrou) recebem
`listaJogadores` atualizado. Se
essa entrada lotar a sala, o início automático é agendado (ver
`partidaIniciandoEm`) e `segundosParaIniciar` vem preenchido no ack — quem
acabou de entrar só monta a tela depois do ack e perderia o broadcast de
`partidaIniciandoEm` que já saiu.
Erros possíveis: `NAO_IDENTIFICADO`, `SALA_NAO_ENCONTRADA`, `SALA_CHEIA`,
`SALA_JA_INICIADA`, `JA_ESTA_NA_SALA`, `NOME_INVALIDO` (nome duplicado na
sala), `JA_EM_PARTIDA` (você já tem assento numa partida em andamento — a
resposta traz `{ salaId }` dela; reconecte ou `desista` antes).

### `listarSalas`
Payload: `{}`
Pré-condição: socket já mandou `entrar` com sucesso.
Ack sucesso: `{ ok: true, salas: [{ salaId, numberPlayers, jogadoresAtual, chatAberto }] }`
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
começar. Pra sair de uma partida **já em andamento**, ver `sairDaPartida`
abaixo.
Ack sucesso: `{ ok: true }`. O socket dá `leave` na sala e quem ficar recebe
`listaJogadores` atualizado. Se quem saiu era o adm, a posição passa pro
próximo da lista automaticamente. Se a sala ficar vazia, é descartada. Se
havia um início agendado (`partidaIniciandoEm`) e a sala deixou de estar
cheia, o agendamento é cancelado.
Erros possíveis: `NAO_IDENTIFICADO`, `SALA_NAO_ENCONTRADA`, `SALA_JA_INICIADA`,
`NAO_ESTA_NA_SALA`.

### `sairDaPartida`
Payload: `{ salaId: string }`
Pré-condição: socket já mandou `entrar`; a partida da sala precisa **já ter
começado** (antes disso é `sairSala`); e quem manda precisa fazer parte
dessa partida.
Ack sucesso: `{ ok: true }`. O assento **não** sai de `controller.jogadores`
— vira bot na hora: liga as flags `desconectado`/`bot` (mesmo efeito da
expulsão por inatividade, só que imediato, sem esperar `limiteInatividadeMs`
acumular) e o servidor emite `jogadorExpulsoPorInatividade` pra sala, o que
também tira o socket de quem saiu da room. A partir daí cada turno desse
assento é jogado na hora por `bots/BotBrain.js` (com a pausa de
`atrasoBotMs`), até alguém voltar via `reconectar` — exatamente como depois
de uma expulsão por inatividade. Pra voltar: `entrar` (socket novo) +
`reconectar`.
Erros possíveis: `NAO_IDENTIFICADO`, `SALA_NAO_ENCONTRADA`,
`SALA_NAO_INICIADA` (a partida ainda não começou — use `sairSala`),
`NAO_ESTA_NA_SALA` (não faz parte dessa partida).

### `desistir`
Payload: `{ salaId: string }`
Pré-condição: socket já mandou `entrar`; a partida da sala precisa **já ter
começado** e não ter terminado; e quem manda precisa fazer parte dela com a
vaga ainda não expirada.
Desistência **definitiva**, o oposto de `sairDaPartida` (que só vira bot e
mantém a vaga reservada). É o que o cliente chama no fluxo "desistir e
entrar", quando `JA_EM_PARTIDA` (ver abaixo) barra a entrada numa segunda
sala. Efeito:
- **Perde na hora**: o `hp` do assento vai a 0, o que garante a eliminação
  dele na próxima virada de rodada (igual morte normal — sai um
  `jogadoresEliminados`), e se isso deixar um único vivo o `jogoFinalizado`
  decide W.O. sozinho. O bot termina a rodada em curso no lugar dele.
- **A vaga expira já** (mesmo caminho de `tempoReservaMs` estourando): sai um
  `jogadorDesistiu` seguido de um `vagaExpirada`, o socket dele sai da room,
  e — se era o adm — o posto passa adiante (`novoAdm`). A partir daí
  `reconectar` nessa sala devolve `VAGA_EXPIRADA` e `minhaSalaAtiva` para de
  apontar pra ela — o jogador está livre pra entrar noutra sala.
- Se era a última vaga de gente de verdade, a sala inteira é removida (igual
  `vagaExpirada` por tempo — ver "Expiração de vaga reservada").
Ack sucesso: `{ ok: true }`.
Erros possíveis: `NAO_IDENTIFICADO`, `SALA_NAO_ENCONTRADA`,
`SALA_NAO_INICIADA` (a partida ainda não começou), `NAO_ESTA_NA_SALA` (não
faz parte de uma partida em andamento nessa sala, ou a vaga já expirou).

### `jogarDeNovo`
Payload: `{ salaId: string }` — a sala que **terminou** (`jogoFinalizado` já
disparou nela).
Pré-condição: socket já mandou `entrar`/`cadastrar`/`entrarComoConvidado`; a
partida dessa sala precisa ter terminado de verdade (não só começado — ver
`GameController.finalizada`); só quem criou a sala original (adm) pode
chamar.
Ack sucesso: mesmo formato de `criarSala`/`entrarSala` — `{ ok: true,
salaId, numberPlayers, jogadores, segundosParaIniciar: number | null,
chatAberto }`, só que `salaId` aqui já é o da sala **nova**. A sala nova
nasce com exatamente a mesma config da que terminou (`numberPlayers`,
`roundStart`, `randomShuffle`, `maxDeck`, `botNumber`, `chatAberto`) e o adm já entra
nela, do mesmo jeito que `criarSala` — ela fica esperando gente lotar, igual
qualquer sala nova.
Além do ack, todo mundo que ainda estava na sala antiga (broadcast em
`salaId`, a sala que terminou) recebe `convidadoParaRevanche` com o
`salaId` da sala nova — ver seção de eventos do servidor abaixo.
Erros possíveis: `NAO_IDENTIFICADO`, `SALA_NAO_ENCONTRADA`,
`SALA_NAO_FINALIZADA` (a partida dessa sala ainda não acabou),
`NAO_AUTORIZADO` (quem chamou não é o adm da sala original).

### `apostar`
Payload: `{ salaId: string, valor: number }` — `valor` é o número de vazas
que o jogador acha que vai fazer nessa rodada.
Pré-condição: socket já mandou `entrar`; a partida da sala precisa já ter
começado; e **precisa ser a vez de quem manda apostar** — o servidor decide
isso sozinho a partir de quem recebeu o `turnoAposta` mais recente, mesma
lógica de `jogarCarta` pro turno de jogar carta. As apostas são pedidas uma
de cada vez, na ordem da rodada (primeiro jogador, depois o segundo, e assim
por diante) — a resposta de quem apostou antes pode influenciar a de quem
vem depois, então o servidor não pede a próxima aposta antes da anterior
chegar.
Ack sucesso: `{ ok: true }`. Libera a espera do servidor e o `apostaFeita`
sai pra sala inteira; segue pro próximo `turnoAposta` ou, se era o último,
pro início da primeira vaza.
Erros possíveis: `NAO_IDENTIFICADO`, `SALA_NAO_ENCONTRADA`, `SALA_NAO_INICIADA`,
`NAO_E_SUA_VEZ`, `APOSTA_INVALIDA` (`valor` não é um inteiro entre 0 e o
número de cartas da rodada), `APOSTA_FECHA_RODADA` (só pode acontecer com o
**último** jogador a apostar na rodada — ver limite abaixo).

**Limites de aposta**:
- `valor` tem que ser um inteiro entre `0` e o número de cartas da rodada
  (o mesmo `cartas` que veio em `novaRodadaIniciada`) — não faz sentido
  apostar mais vazas do que existem cartas pra fazer.
- A soma das apostas de todo mundo não pode fechar exatamente no número de
  cartas da rodada — isso garantiria que pelo menos alguém acerta sem
  arriscar nada. Só o **último** jogador a apostar na rodada esbarra nisso
  na prática (os outros ainda não sabem a soma final); se o valor que ele
  mandou fecharia a soma, o servidor recusa com `APOSTA_FECHA_RODADA` e ele
  precisa escolher outro. É por isso que a ordem de aposta (`Game.setstartsequence`)
  precisa ser sorteada de verdade a cada partida: ser o último a apostar é
  uma desvantagem real (perde a liberdade de escolher qualquer valor), então
  não pode ser sempre a mesma pessoa só por ter entrado por último na sala.

**Timeout da aposta**: mesmo prazo de `jogarCarta` (`tempoTurnoMs`). Se
estourar, o servidor aposta por aquele jogador sozinho — 1, a não ser que
isso viole o limite acima (só possível se ele for o último a apostar), caso
em que aposta 0 — liga a flag `desconectado`, sem emitir um evento à parte,
só o `apostaFeita` normal com o valor escolhido.

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
`GameController`, 20s por padrão) pra `jogarCarta` chegar. Se estourar, o
servidor joga sozinho por aquele jogador — mesma decisão usada pros bots de
verdade (ver `bots/BotBrain.js`) — liga a flag `desconectado` nele e emite
`jogadaAutomatica` pra sala. Uma
falta isolada é só isso: o próximo turno dele continua esperando
`tempoTurnoMs` normalmente, do zero — pode ter sido só uma demora.
`limiteInatividadeMs`/`jogadorExpulsoPorInatividade` (ver abaixo) não
mudaram: continuam avaliados a cada timeout, exatamente como antes de
existir bot. Só quando isso realmente acumula o suficiente pra estourar
`limiteInatividadeMs` (várias faltas seguidas, não uma só) é que ele é
considerado desconectado de verdade — expulsa o socket da sala **e** liga a
flag `bot` (`PlayerGame.bot`): a partir daí esse assento para de esperar
`tempoTurnoMs` e joga na hora, com uma pausa de `atrasoBotMs` (2s por
padrão, mesma pausa de um bot de verdade — ver `GameController`) só pra não
resolver a vaza inteira instantaneamente. As flags só desligam quando ele
manda `jogarCarta`/`apostar` de novo com sucesso, ou reconecta (ver
`reconectar` abaixo) — a partir daí volta a esperar `tempoTurnoMs` como
qualquer jogador de verdade, com a reconexão funcionando exatamente igual a
antes (mesmo `estadoDeReconexao`, mesma mão, mesmo "de quem é a vez").

Uma desconexão "do nada" (aba fechada, rede caiu) **antes** da partida
começar tem exatamente o mesmo efeito de mandar `sairSala` — o servidor
chama a mesma função internamente ao detectar o `disconnect`, sem esperar o
cliente pedir nada (silenciosamente: não tem ack pra responder, e um erro
esperado não é logado). **Exceção multi-aba**: se ainda sobrar outro socket
autenticado do mesmo jogador apontando pra essa mesma sala (ex.: ele abriu
uma segunda aba, ou relogou noutra, e só depois a primeira caiu), esse
`disconnect` não mexe no assento — só quando não sobra nenhuma conexão dele
naquela sala é que a limpeza roda. Já uma desconexão **depois** que a
partida começou mas **antes** dela terminar não mexe no roster do jogo — o
assento continua lá. Se a desconexão acontecer bem na vez dele, o timeout
acima cuida disso normalmente (jogada automática); se não for a vez dele,
simplesmente não acontece nada até a vez chegar.

Uma desconexão **depois** que a partida já **terminou** (`jogoFinalizado`
já disparou) é a única exceção: como não existe mais nenhum turno sendo
despachado, nenhum timeout chegaria a pegar isso sozinho — sem tratamento
especial, fechar a aba depois de ver o resultado nunca reservaria/expiraria
a vaga (nem disputaria a sucessão de adm, ver "Sucessão de adm" mais
abaixo). Por isso, nesse caso específico, o `disconnect` chama a mesma
função de `sairDaPartida` internamente (mesma filosofia do caso "antes de
começar" acima). A mesma exceção multi-aba vale aqui: só roda se não sobrou
outra conexão do jogador naquela sala.

**Expulsão por inatividade**: cada timeout de turno (aposta ou carta) também
checa há quanto tempo (real, em ms — não em turnos) aquele jogador não faz
nada de verdade. Se passar de `limiteInatividadeMs` (`GameController`, 90s
por padrão, configurável por sala igual `tempoTurnoMs`) desde a última ação
real dele (jogar carta, apostar ou `reconectar`), o servidor tira o *socket*
dele da room daquela sala e avisa todo mundo com `jogadorExpulsoPorInatividade`
— só isso, uma vez por período de inatividade (não reemite a cada novo
timeout enquanto ele continuar sumido). O assento na partida **não muda**:
`controller.jogadores` continua com ele lá, `jogadaAutomatica` continua
jogando por ele a cada turno normalmente — só o socket parou de estar na
room, então o cliente dele para de receber os eventos daquela partida e
(olhando o `id` do evento) deve navegar pra tela de salas. Pra voltar, é só
mandar `reconectar` de novo — o socket ainda está autenticado (não é uma
desconexão de verdade), não precisa `entrar` outra vez. Hoje isso só
desconecta: não existe bot nenhum jogando estrategicamente por ele nesse
meio tempo (ver "o que fica fora deste marco" mais abaixo).

**Expiração de vaga reservada**: toda vez que `jogadorExpulsoPorInatividade`
dispara (por inatividade real ou por `sairDaPartida`), começa a contar
`tempoReservaMs` (`GameController`, 150s por padrão, configurável por sala
igual `tempoTurnoMs`) pra aquela vaga específica. Se ninguém mandar
`reconectar` (ou jogar/apostar de verdade, o que só é possível vindo de
`reconectar` primeiro) antes disso, o servidor emite `vagaExpirada` e a vaga
não pode mais ser reclamada: um `reconectar` depois disso devolve
`VAGA_EXPIRADA`, e `minhaSalaAtiva` para de devolver o `salaId` dessa sala
pra esse jogador — é assim que o cliente para de oferecer o botão de
reconectar automático sozinho. O assento em si **não muda**: continua em
`controller.jogadores`, jogando como bot pelo resto da partida, exatamente
como antes de expirar — só que agora pra sempre, não só até alguém voltar.
Reconectar antes do prazo cancela o contador normalmente (mesmo
`jogadorReconectou` de sempre).

Se a vaga que expirou era a **última** vaga de gente de verdade da sala (ou
seja: todo mundo que não nasceu como um `bots/Bot.js` de verdade já expirou
ou nunca existiu), a sala inteira é removida do sistema na mesma hora —
some de `listarSalas` (já não aparecia, por já estar iniciada), e
`reconectar`/`entrarSala`/`chat`/`jogarDeNovo` nela devolvem
`SALA_NAO_ENCONTRADA` a partir daí, como se ela nunca tivesse existido. A
partida em si (agora só bot contra bot) não é interrompida no meio — ela
termina sozinha em segundo plano, rápido, sem que ninguém mais a veja.

**Sucessão de adm**: se quem tem `adm` for justamente quem teve a vaga
expirada, o posto passa pro próximo jogador de verdade (nem um `Bot` de
`bots/Bot.js`, nem alguém com a própria vaga já expirada) na ordem de
entrada da sala, e o servidor avisa com `novoAdm`. Enquanto a vaga só está
reservada (ainda dentro de `tempoReservaMs`, não expirada de vez), o posto
**não muda** — ele continua adm normalmente e recupera isso sozinho ao
reconectar, porque a flag nunca chegou a sair dele; só a expiração de
verdade dispara a sucessão. Se ninguém mais for elegível (não sobrou gente
de verdade), ninguém vira adm — mas nesse caso a sala inteira já é removida
do sistema no mesmo instante (ver parágrafo acima), então não sobra ninguém
pra se importar.

### `reconectar`
Payload: `{ salaId: string }`
Pré-condição: socket já mandou `entrar` (de novo — reconectar não dispensa
logar de novo, o `socket.id` é outro); a sala precisa **já ter começado**
(pra sala em espera, é só `entrarSala` mesmo); quem manda precisa já fazer
parte daquela partida (ter entrado na sala antes dela começar); e a vaga
dele não pode ter expirado de vez (ver `VAGA_EXPIRADA` abaixo e a seção
"Expiração de vaga reservada" mais adiante).
Ack sucesso: `{ ok: true, salaId, jogadores: [{ nome, adm }],
mao: string[], cartasRodada: number,
numeroRodada: number, maosReveladas: [{ jogador, mao: string[] }],
mesa: [{ jogador, carta: string }], vira: string | null,
viraValor: number | null, apostas: [{ jogador, aposta: number }],
eliminados: string[], desconectados: string[],
ultimoPlacar: [{ nome, aposta, steak, diferenca, hp }], suaVez: boolean,
jogadorDaVez: string | null, suaVezDaAposta: boolean,
jogadorDaVezAposta: string | null, finalizada: boolean,
vencedor: string | null, chatAberto: boolean }` — o estado pra remontar a
tela inteira sem depender dos broadcasts que já passaram enquanto o jogador
estava fora:
- `jogadores`: o roster da sala com a flag `adm` — o ack de `reconectar` não
  dispara `listaJogadores`, então sem isto a tela remontada ficaria sem
  lista de jogadores até o próximo evento que a mexa.
- `mao` / `cartasRodada` / `numeroRodada`: a mão atual, quantas cartas tem a
  rodada (pro limite do input de aposta) e o número dela.
- `suaVez`/`jogadorDaVez` e `suaVezDaAposta`/`jogadorDaVezAposta`: de quem é
  a vez agora, tanto pra jogar carta quanto pra apostar (as duas esperas
  nunca coexistem — no máximo um par faz sentido de cada vez, o outro fica
  `false`/`null`), pra o cliente já pedir a ação certa sem esperar um
  `turnoJogador`/`turnoAposta` que já passou.
- `mesa`: as cartas já baixadas na vaza em curso, na ordem em que caíram
  (mesmo shape acumulado de `cartaJogada`); `[]` no começo de cada vaza.
- `vira`/`viraValor`: a manilha da rodada (mesmo conteúdo de `manilhaVirada`);
  `null` no vão — na prática síncrono — entre `novaRodadaIniciada` e a vira.
- `apostas`: só as apostas que **já valem** nesta rodada (mesmo shape
  acumulado de `apostaFeita`); quem ainda não apostou não aparece.
- `eliminados`: nomes de quem já foi eliminado (hp ≤ 0) na partida.
- `desconectados`: nomes dos assentos humanos jogando no automático agora
  (mesmo critério de `jogadorExpulsoPorInatividade`, sem o próprio
  reconectante); some de lá com o `jogadorReconectou` de cada um.
- `ultimoPlacar`: o resultado da última `rodadaFinalizada` (aposta/steak/
  diferença/hp por jogador); `[]` antes da primeira rodada fechar.
- `maosReveladas`: só na rodada de 1 carta (ver evento abaixo) — as mãos dos
  outros que ainda não jogaram, pra remontar a "testa"; `[]` nas demais.
- `finalizada`/`vencedor`: se a partida já acabou (blip de rede no último
  lance), `finalizada: true` e `vencedor` com o nome; `null` enquanto joga.

O socket dá `join` na sala de novo (broadcasts futuros voltam a chegar) e a
flag `desconectado` desse jogador é desligada.
Erros possíveis: `NAO_IDENTIFICADO`, `SALA_NAO_ENCONTRADA`,
`SALA_NAO_INICIADA` (sala existe mas a partida não começou — use
`entrarSala`), `NAO_ESTA_NA_SALA` (não faz parte dessa partida),
`VAGA_EXPIRADA` (a vaga dele já passou de `tempoReservaMs` sem ninguém
voltar — ver "Expiração de vaga reservada" mais adiante).

### `minhaSalaAtiva`
Payload: `{}`
Pré-condição: socket já mandou `entrar`.
Ack sucesso: `{ ok: true, salaId: string | null }` — o `salaId` de uma
partida em andamento (começou, **não terminou**) em que quem pediu ainda tem
assento reclamável, ou `null` se não tiver nenhuma. Existe pra um socket
recém-autenticado (ex.: depois de um refresh de página — o cliente não
guarda `salaId` nenhum entre recarregas, de propósito) conseguir descobrir
sozinho que existe uma partida esperando por ele, sem precisar saber o
`salaId` de antemão — é o mesmo `salaId` que `reconectar` espera. Não contam
aqui: salas ainda na sala de espera (lá "sumir" já tira o assento de
verdade); salas já **finalizadas** mas ainda no sistema (reconectar numa
partida que acabou não serve pra nada); e vagas com `VAGA_EXPIRADA` (o
cliente para de oferecer "reconectar" pra uma vaga que já era). Como não dá
mais pra ter assento em duas partidas ao mesmo tempo (`JA_EM_PARTIDA` barra
`criarSala`/`entrarSala`/`partidaRapida`), na prática só existe uma —
devolvida diretamente.
Erros possíveis: `NAO_IDENTIFICADO`.

### `chat`
Payload: `{ salaId: string, tipo: 'aberta' | 'restrita', texto?: string, id?: number }`
Pré-condição: socket já mandou `entrar`; quem manda precisa estar na sala
(`salaId`) — vale tanto na sala de espera quanto com a partida em andamento.
Bots não mandam (não têm socket).

- `tipo: 'restrita'`: `id` de uma mensagem pronta do catálogo
  (`conexao/chat/mensagensChat.js`). **Sempre liberada**, mesmo com
  `chatAberto: false`. O `texto` do payload é ignorado — o texto vem sempre
  do catálogo, o cliente não escolhe. `id` fora do catálogo → `CHAT_INVALIDO`.
- `tipo: 'aberta'`: texto livre digitado pelo jogador. Só funciona se a sala
  foi criada com `chatAberto: true` (senão `CHAT_DESABILITADO`). O `texto`,
  depois de `trim`, precisa ter entre 1 e 200 caracteres (`CHAT_INVALIDO`
  fora disso).

**Cooldown**: `chatCooldownMs` (`SalaManager`, 3s por padrão) entre envios
*aceitos* — qualquer sala, qualquer tipo, contado por jogador (não por
sala: entrar em duas salas ao mesmo tempo não dobra o limite). Uma
tentativa antes do prazo devolve `CHAT_EM_COOLDOWN` sem mandar
`chatMensagem` nenhum. Só uma mensagem que passou em todas as outras
validações conta pro relógio — uma tentativa rejeitada por
`CHAT_INVALIDO`/`CHAT_DESABILITADO` não consome nem estica o prazo de quem
já estava dentro dele. `CHAT_COOLDOWN_MS` no front é só cosmético (desabilita
os botões na hora); quem decide de verdade é o servidor. O front importa essa
constante — e o catálogo de mensagens prontas — direto de
`conexao/chat/mensagensChat.js` (fonte única), então não há sincronização
manual entre os dois lados.

Ack sucesso: `{ ok: true }`. O servidor então faz `chatMensagem` pra sala
inteira, **incluindo quem enviou** (o cliente não renderiza otimista — espera
o broadcast, igual ao resto do protocolo).
Erros possíveis: `NAO_IDENTIFICADO`, `SALA_NAO_ENCONTRADA`, `NAO_ESTA_NA_SALA`,
`CHAT_DESABILITADO`, `CHAT_INVALIDO`, `CHAT_EM_COOLDOWN`.

## Eventos servidor -> cliente

Todos levam `salaId` no payload. Todos são broadcast pra sala inteira
(`io.to(salaId)`), **exceto `suaMao` e `maosReveladas`**, que são privados —
vão só pra `jogador:<id>` de cada destinatário (e cada um recebe um recorte
diferente, no caso de `maosReveladas`).

### `listaJogadores`
`{ salaId, jogadores: [{ nome, adm }] }` — toda vez que a lista de espera muda.

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
| `maosReveladas` **(privado)** | `{ maos: [{ jogador, mao: string[] }] }` — conjunto de mãos que ESTE jogador pode ver; ver seção "Rodada de 1 carta" abaixo |
| `manilhaVirada` | `{ vira, viraValor }` |
| `turnoAposta` | `{ id, jogador }` — `id` é de quem tem que mandar `apostar` agora |
| `apostaFeita` | `{ jogador, aposta }` — só depois que a aposta foi de fato registrada (real ou timeout) |
| `turnoJogador` | `{ id, jogador }` — `id` é de quem tem que mandar `jogarCarta` |
| `cartaJogada` | `{ jogador, carta, status }` |
| `vazaFinalizada` | `{ vencedor, carta }` |
| `rodadaFinalizada` | `{ numero, resultado }` |
| `jogadoresEliminados` | `{ eliminados: [{ nome, hp }] }` |
| `jogoFinalizado` | `{ vencedor }` |
| `partidaAbortada` | `{ motivo, erro }` — erro interno inesperado no motor (invariante quebrada, ex.: baralho vazio por conta errada de baralhos). A partida parou e **não recupera**; `GameController.finalizada` vira `true` (igual `jogoFinalizado`), mas **não há vencedor**. A sala não é desmontada sozinha — ver "Limpeza de sala após o fim da partida" abaixo. Cliente deve mostrar erro e deixar sair. |
| `jogadaAutomatica` | `{ id, jogador }` — `tempoTurnoMs` estourou, o servidor jogou sozinho por ele |
| `jogadorReconectou` | `{ id, jogador }` — voltou via `reconectar`, flag `desconectado` desligada |
| `jogadorExpulsoPorInatividade` | `{ id, jogador }` — `limiteInatividadeMs` sem nenhuma ação real dele **ou** ele mandou `sairDaPartida`; o socket dele já saiu da room dessa sala (assento continua e vira bot, ver seção de `reconectar` acima) |
| `jogadorDesistiu` | `{ id, jogador }` — mandou `desistir` (desistência definitiva): perde na hora (hp a 0 → eliminado na virada) e a vaga expira já; sai um `vagaExpirada` logo em seguida. O socket dele já saiu da room. Ver `desistir` acima. |
| `vagaExpirada` | `{ id, jogador }` — `tempoReservaMs` depois de `jogadorExpulsoPorInatividade` sem ninguém reconectar, **ou** logo após um `jogadorDesistiu`; a vaga não pode mais ser reclamada, ver "Expiração de vaga reservada" abaixo |
| `novoAdm` | `{ id, jogador }` — o adm anterior teve a vaga expirada; passa pro próximo jogador de verdade, ver "Sucessão de adm" abaixo |

### `convidadoParaRevanche`
`{ salaId, novaSalaId, jogador }` — broadcast na sala que **terminou**
(`salaId`) quando o adm dela chama `jogarDeNovo`. `jogador` é o nome de quem
chamou (inclusive o próprio remetente recebe — o cliente ignora quando
`jogador === meuNome`, já que ele mesmo já sabe pelo ack de `jogarDeNovo`).
Quem recebe decide: **sim**, manda `sairDaPartida` na sala que terminou
(best-effort — a sala já era, o assento não importa mais) e só depois
`entrarSala` com `salaId: novaSalaId` — nessa ordem, porque o servidor só
tira o socket da room antiga enquanto ainda pensa que ele está nela (ver
"Limpeza de sala após o fim da partida" abaixo); **não**, sai da sala que
terminou (mesmo caminho de `sairDaPartida` — ver seção de `jogarCarta`/
timeout acima). Não existe um evento de resposta dedicado: as duas opções
só reusam eventos que já existem.

### Limpeza de sala após o fim da partida

Depois que `jogoFinalizado` **ou `partidaAbortada`** dispara
(`GameController.finalizada` vira `true`), a sala continua existindo — dá pra
`jogarDeNovo` (só o adm) ou só sair. Mas assim que **nenhum socket** continuar conectado na room dela
(cada jeito de sair de uma sala terminada — `sairDaPartida`, aceitar ou
recusar um convite de revanche, ou só fechar a aba — tira o socket da room),
o servidor descarta a sala do sistema na mesma hora: some do `SalaManager`,
e `jogarDeNovo`/`reconectar`/`chat`/`entrarSala` nela passam a devolver
`SALA_NAO_ENCONTRADA` a partir daí. Diferente da expiração de vaga
reservada (ver acima), isso não depende de nenhum timer — é conferido na
hora, toda vez que um socket sai da room de uma sala já finalizada.

### Rodada de 1 carta ("testa" / rodada cega)

Quando a rodada tem só 1 carta por jogador (`cartas === 1` em
`novaRodadaIniciada`), cada um aposta **sem saber a própria carta**, mas
vendo a de todo mundo. O `GameController` emite `maosReveladas` logo depois
de `cartasDistribuidas`, e a camada de socket recorta por destinatário: cada
`jogador:<id>` recebe `{ maos }` com a mão dos **outros**, nunca a própria.

`suaMao` continua sendo enviado normalmente (com o valor real da carta) — é
o **cliente** que esconde a própria carta na UI nessa rodada (mostra virada,
mas ela segue jogável por índice como qualquer outra). Ou seja: hoje isso
não é anti-trapaça de verdade, é regra de exibição. Trocar por "não mandar
`suaMao` na rodada cega" é possível depois sem mexer no formato do evento.

O evento é **genérico** de propósito (`maos` é um conjunto arbitrário de
mãos que aquele jogador pode ver) — dá pra reusar num showdown de fim de
rodada, modo espectador ou debug sem inventar outro evento. Quem decide o
recorte é o servidor; o `ocultarProprio` que o `GameController` passa pro
socket não vai no fio, só controla o filtro por destinatário.

### `chatMensagem`

`{ salaId, jogador: string, tipo: 'aberta' | 'restrita' | 'sistema', id: number | null, texto: string }`
— resposta do servidor a um evento `chat` (ver seção própria acima), **ou**
um aviso de sistema gerado pelo próprio servidor. Broadcast pra sala inteira,
**incluindo quem enviou**. Não passa pelo `GameController` (chat é da camada
de conexão, não do jogo), então chega igual na sala de espera e na partida.

- `tipo: 'restrita'`: `id` é o do catálogo e `texto` é o texto resolvido
  dele — o cliente pode usar qualquer um dos dois (renderizar por `id` como
  um "chip", ou só mostrar `texto`).
- `tipo: 'aberta'`: `id` é `null` e `texto` é o que o jogador digitou, já
  com `trim` e limitado a 200 caracteres pelo servidor.
- `tipo: 'sistema'`: aviso do servidor, não veio de nenhum `chat`. Hoje só
  entrada/saída de jogador na sala de espera — `jogador` é o nome de quem
  entrou/saiu, `texto` é `"entrou na sala"` ou `"saiu da sala"`, `id` é
  `null`. Não respeita cooldown nem `chatAberto`. O cliente renderiza sem
  tratar como fala de ninguém (ex.: linha centralizada "Fulano entrou na
  sala").

## Códigos de erro (`CodigosErro`)

| Código | Quando |
|---|---|
| `NAO_IDENTIFICADO` | Mandou `criarSala`/`entrarSala`/`listarSalas`/`forcarInicio`/`sairSala`/`sairDaPartida`/`desistir`/`jogarCarta`/`reconectar`/`minhaSalaAtiva`/`chat` sem ter mandado `entrar` antes |
| `USUARIO_NAO_ENCONTRADO` | `entrar` com nome que não existe no banco |
| `SENHA_INCORRETA` | `entrar` com nome existente, senha errada |
| `CADASTRO_INVALIDO` | `cadastrar` com nome ou senha menor que 3 caracteres |
| `NOME_JA_CADASTRADO` | `cadastrar` com nome que já existe no banco; ou `entrarComoConvidado` com nome que virou conta registrada entre o `verificarNome` do cliente e a chamada |
| `CONVIDADO_INVALIDO` | `entrarComoConvidado` com nome menor que 3 caracteres |
| `TOKEN_INVALIDO` | `retomarSessao` com token que não bate a assinatura, expirou, ou veio ausente/malformado |
| `JA_AUTENTICADO` | `entrar`/`cadastrar`/`entrarComoConvidado`/`retomarSessao` tentando virar OUTRA conta num socket que já é alguém (ver "Reautenticação num socket já autenticado") — a mesma conta de novo é permitida, não cai aqui |
| `MUITAS_TENTATIVAS` | `verificarNome` acima do teto por IP (20 a cada 5 minutos), `entrar` com 5 falhas (senha errada/usuário inexistente) em 20 minutos, **ou** `cadastrar` com 10 tentativas (sucesso incluso) em 10 minutos, tudo pelo mesmo IP — ver `conexao/rateLimiter.js`. Espere a janela passar |
| `NOME_INVALIDO` | `entrarSala` com nome já em uso *nessa sala* |
| `CONFIGURACAO_INVALIDA` | `criarSala` com `numberPlayers`/`roundStart`/`maxDeck`/`botNumber` fora do intervalo aceito (`roundStart` 1 a 10, `maxDeck` 1 a 50), `roundStart` que não cabe em `maxDeck` baralhos com a mesa cheia, `seed` que não é inteiro não-negativo, ou `chatAberto`/`randomShuffle` que não é boolean |
| `LIMITE_DE_SALAS` | `criarSala`/`partidaRapida` com o teto global de salas simultâneas já atingido — barreira de sanidade, tenta de novo mais tarde |
| `LIMITE_DE_SALAS_POR_JOGADOR` | `criarSala`/`partidaRapida` por quem já é adm de salas ativas (não finalizadas) demais ao mesmo tempo — teto por pessoa (4), complementar ao global. Feche (`sairSala`) ou termine alguma antes |
| `SALA_NAO_ENCONTRADA` | `entrarSala`/`forcarInicio`/`sairSala`/`jogarCarta`/`reconectar` com `salaId` que não existe |
| `SALA_CHEIA` | `entrarSala` numa sala que já tem `numberPlayers` jogadores |
| `SALA_NAO_CHEIA` | `forcarInicio` antes da sala lotar |
| `SALA_JA_INICIADA` | `entrarSala`/`forcarInicio`/`sairSala` numa sala cuja partida já começou |
| `SALA_NAO_INICIADA` | `jogarCarta`/`reconectar` numa sala cuja partida ainda não começou |
| `SALA_NAO_FINALIZADA` | `jogarDeNovo` numa sala cuja partida ainda não terminou |
| `JA_ESTA_NA_SALA` | `entrarSala` com o mesmo jogador (mesmo id de sessão) já presente |
| `JA_EM_PARTIDA` | `criarSala`/`entrarSala`/`partidaRapida` por quem já tem assento reclamável numa partida em andamento (começou, não terminou). A resposta traz `{ salaId }` dela — o cliente oferece reconectar nela ou `desistir` dela antes de entrar em outra |
| `NAO_ESTA_NA_SALA` | `sairSala` por quem não está (mais) naquela sala; `reconectar`/`chat`/`desistir` por quem não faz parte da partida/sala |
| `VAGA_EXPIRADA` | `reconectar` numa vaga que já passou de `tempoReservaMs` desde que virou bot, sem ninguém voltar, **ou** que o jogador liberou via `desistir` (ver "Expiração de vaga reservada" abaixo) |
| `NAO_AUTORIZADO` | `forcarInicio` por quem não é o adm da sala |
| `NAO_E_SUA_VEZ` | `jogarCarta`/`apostar` fora da sua vez |
| `CARTA_INVALIDA` | `jogarCarta` com `indice` que não existe na mão de quem mandou |
| `APOSTA_INVALIDA` | `apostar` com `valor` fora de `[0, número de cartas da rodada]` |
| `APOSTA_FECHA_RODADA` | `apostar` pelo último da rodada com `valor` que fecharia a soma de todo mundo no número de cartas |
| `CHAT_DESABILITADO` | `chat` com `tipo: 'aberta'` numa sala criada sem `chatAberto` |
| `CHAT_INVALIDO` | `chat` com `tipo` desconhecido, `id` fora do catálogo, ou `texto` vazio/maior que 200 caracteres |
| `CHAT_EM_COOLDOWN` | `chat` antes de `chatCooldownMs` passar desde o último envio aceito (qualquer sala, qualquer tipo, por jogador) |
| `ERRO_INTERNO` | Exceção inesperada no servidor — não deveria acontecer; se aparecer, é bug |

## O que fica fora deste marco (decisão adiada, não esquecida)

- Bot forte em qualquer configuração de sala. Hoje `bots/BotBrain.js`
  (`escolherCarta`/`escolherAposta`) joga com redes treinadas por RL (ver
  `training/`) só em salas de 4 jogadores; fora disso, ou se os modelos não
  carregarem, cai num heurístico burro ("última carta", "aposta 1"). É essa
  mesma decisão (rede ou heurístico) que roda pelo assento no automático a
  cada turno depois da expulsão por inatividade, até alguém voltar via
  `reconectar`. Uma estratégia que cubra as outras contagens de jogador
  continua sendo trabalho futuro.
- Reconectar durante a **sala de espera** (antes da partida começar) não
  existe como conceito separado — hoje uma desconexão nessa fase tira o
  jogador da sala (`sairSala`), então "reconectar" ali é só logar de novo e
  mandar `entrarSala` como se fosse a primeira vez. `reconectar` (evento
  novo) só serve pra partida já em andamento.
- Abandono/forfeit com **remoção de assento** de verdade (a partida passar a
  ter menos gente na mesa, recontar baralho, etc.) continua fora — o motor
  assume número de assentos fixo pela partida inteira. O que existe:
  `sairDaPartida` (vira bot, vaga reservada, dá pra `reconectar`) e
  `desistir` (perde na hora — hp a 0, eliminado na virada, W.O. decidido
  sozinho se sobrar um vivo — e a vaga expira já, liberando o jogador pra
  entrar noutra sala). Nos dois o assento **continua** em
  `controller.jogadores`; `desistir` só o mata e o marca como não-reclamável,
  em vez de tirar da lista.
- Persistência de sessão no `Main2.js`: o harness de CLI não guarda o token
  entre execuções — a cada `node Main2.js` é preciso logar de novo. Ele já
  oferece `reconectar` logo após o login (checa `minhaSalaAtiva`) e tem um
  comando `sair` durante a partida (`sairSala`/`sairDaPartida`); o que falta
  é só não pedir nome/senha toda vez.

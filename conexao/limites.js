// limites.js
// Tetos de tamanho pra nome/senha: sem isso, uma string gigante em
// `nome`/`senha` vira custo de CPU/memória de graça pra quem manda (hash
// bcrypt de um buffer enorme, linha `TEXT` sem limite no SQLite, JWT
// inchado, e — só pra `nome` — ecoada em todo broadcast de sala, ver
// conexao/PROTOCOLO.md). Fonte única compartilhada por cadastro.js,
// convidado.js, login.js e o guard de verificarNome em socketServer.js, pra
// não divergirem sozinhos com o tempo.
export const NOME_MIN = 3;
// Nome de exibição — aparece em toda lista de sala, chat, placar... 24 é bem
// mais que qualquer nome de verdade usa (a maioria dos apps por aí gira em
// torno de 12-20).
export const NOME_MAX = 24;
// Reforço de senha, não só teto de tamanho. Só vale pra CADASTRO NOVO
// (`cadastrar`) — contas antigas (inclusive as de banco.json, "123")
// continuam autenticando normalmente: `login()` nunca checa mínimo, só
// máximo (ver login.js) — mudar a régua não pode invalidar quem já tem
// conta.
export const SENHA_MIN = 8;
// bcrypt só considera os primeiros 72 BYTES da senha por design (o resto é
// ignorado em silêncio, sem erro) — 72 caracteres é generoso o bastante pra
// qualquer senha de verdade e garante que nada além disso é processado à
// toa.
export const SENHA_MAX = 72;

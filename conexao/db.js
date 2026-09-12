// db.js
// Persistência de usuários em SQLite (arquivo `banco.sqlite` na raiz do
// projeto). Senha nunca é guardada em texto puro — só o hash (bcrypt).
// Única peça de conexao/ que sabe SQL: login.js só chama as funções daqui.
//
// `bcrypt` (binding nativo em C++), não `bcryptjs` (JS puro). As duas
// funções que rodam por requisição de verdade (`criarUsuario`,
// `verificarSenha`) usam a API ASSÍNCRONA da lib (`bcrypt.hash`/`compare`,
// sem `Sync`): despacha o hash pro threadpool do libuv em vez de travar a
// thread principal por ~60-70ms a cada chamada. As que só rodam UMA VEZ no
// boot (`semearSeVazio`, `HASH_DUMMY`) usam `Sync` — não repetem por
// requisição, e `semearSeVazio` roda dentro de uma `db.transaction()` do
// better-sqlite3, que não suporta callback assíncrono.
import Database from 'better-sqlite3';
import bcrypt from 'bcrypt';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CAMINHO_DB = path.join(__dirname, '..', 'banco.sqlite');
const CAMINHO_SEED = path.join(__dirname, '..', 'banco.json');
const SALT_ROUNDS = 10;

export const db = new Database(CAMINHO_DB);
db.pragma('journal_mode = WAL');

db.exec(`
    CREATE TABLE IF NOT EXISTS usuarios (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        nome TEXT UNIQUE NOT NULL,
        senha_hash TEXT NOT NULL,
        criado_em TEXT NOT NULL DEFAULT (datetime('now'))
    )
`);

semearSeVazio();

// Popula a tabela a partir de banco.json na primeira vez que o banco é
// criado (bootstrap de dev/teste) — nunca sobrescreve quem já existe.
// banco.json continua no repo só como fixture inicial, com senha em TEXTO
// PURO — por isso não roda em produção (`NODE_ENV=production`, já setado
// por `Dockerfile`/`docker-compose.yml`): um banco de prod vazio não pode
// nascer com essas contas conhecidas publicamente no repositório.
//
// OR IGNORE (em vez de checar "tabela vazia?" antes) é o que faz isso ser
// seguro com múltiplos processos rodando ao mesmo tempo (ex.: cada arquivo
// de teste sobe seu próprio processo Node e importa este módulo) — sem
// isso, dois processos podem checar "vazio" ao mesmo tempo e colidir na
// mesma inserção (UNIQUE constraint).
function semearSeVazio() {
    if (process.env.NODE_ENV === 'production') {
        console.log('[db] NODE_ENV=production — pulando semeadura de banco.json (contas de fixture nunca entram em produção).');
        return;
    }
    if (!existsSync(CAMINHO_SEED)) return;

    const usuarios = JSON.parse(readFileSync(CAMINHO_SEED, 'utf-8'));
    const inserir = db.prepare('INSERT OR IGNORE INTO usuarios (nome, senha_hash) VALUES (?, ?)');
    const semearTudo = db.transaction((lista) => {
        for (const { nome, senha } of lista) {
            inserir.run(nome, bcrypt.hashSync(senha, SALT_ROUNDS));
        }
    });
    semearTudo(usuarios);
}

export function buscarUsuarioPorNome(nome) {
    return db.prepare('SELECT id, nome, senha_hash FROM usuarios WHERE nome = ?').get(nome) ?? null;
}

export function usuarioExiste(nome) {
    return buscarUsuarioPorNome(nome) !== null;
}

// Assíncrona de propósito (ver comentário do topo do arquivo) — só o hash
// (`bcrypt.hash`) sai da thread principal; o INSERT em si já é rápido o
// bastante (SQLite local, tabela pequena) pra não precisar da mesma
// preocupação, e better-sqlite3 não tem versão assíncrona de qualquer jeito.
export async function criarUsuario(nome, senha) {
    const senha_hash = await bcrypt.hash(senha, SALT_ROUNDS);
    const info = db.prepare('INSERT INTO usuarios (nome, senha_hash) VALUES (?, ?)').run(nome, senha_hash);
    return { id: info.lastInsertRowid, nome };
}

// Assíncrona de propósito (ver comentário do topo do arquivo) — devolve uma
// Promise<boolean> em vez de comparar na hora.
export function verificarSenha(senha, senhaHash) {
    return bcrypt.compare(senha, senhaHash);
}

// Hash bcrypt de uma senha fixa que ninguém usa de verdade pra autenticar —
// existe só pra login() (conexao/login.js) ter algo pra comparar quando o
// usuário NÃO existe, pagando o mesmo custo de bcrypt que um hash de
// verdade pagaria (evita um timing oracle que revelaria quais nomes têm
// conta). `Sync` aqui é o caso certo: roda uma vez só, no import do módulo.
export const HASH_DUMMY = bcrypt.hashSync('nenhuma-conta-usa-esta-senha', SALT_ROUNDS);

// db.js
// Persistência de usuários em SQLite (arquivo `banco.sqlite` na raiz do
// projeto). Senha nunca é guardada em texto puro — só o hash (bcrypt).
// Única peça de conexao/ que sabe SQL: login.js só chama as funções daqui.
import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';
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
// banco.json continua no repo só como fixture inicial.
//
// OR IGNORE (em vez de checar "tabela vazia?" antes) é o que faz isso ser
// seguro com múltiplos processos rodando ao mesmo tempo (ex.: cada arquivo
// de teste sobe seu próprio processo Node e importa este módulo) — sem
// isso, dois processos podem checar "vazio" ao mesmo tempo e colidir na
// mesma inserção (UNIQUE constraint).
function semearSeVazio() {
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

export function criarUsuario(nome, senha) {
    const senha_hash = bcrypt.hashSync(senha, SALT_ROUNDS);
    const info = db.prepare('INSERT INTO usuarios (nome, senha_hash) VALUES (?, ?)').run(nome, senha_hash);
    return { id: info.lastInsertRowid, nome };
}

export function verificarSenha(senha, senhaHash) {
    return bcrypt.compareSync(senha, senhaHash);
}

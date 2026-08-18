// cadastro.js
// Cria contas novas: valida nome/senha, grava no banco (conexao/db.js) e já
// devolve um token de sessão — cadastrar deixa autenticado na hora, sem
// precisar de um "entrar" separado logo em seguida. Não sabe nada sobre
// socket.io, mesmo espírito de login.js.
import { Player } from '../game/Player.js';
import { CodigosErro } from './eventos.js';
import { criarUsuario } from './db.js';
import { emitirToken } from './jwt.js';

const NOME_MIN = 3;
const SENHA_MIN = 3;

export class ErroCadastro extends Error {
    constructor(codigo, mensagem) {
        super(mensagem);
        this.name = 'ErroCadastro';
        this.codigo = codigo;
    }
}

// Cria a conta e devolve { token, player }, igual login(). Lança
// ErroCadastro se nome/senha forem curtos demais ou o nome já existir.
//
// Não faz um SELECT antes pra checar duplicidade — deixa a constraint
// UNIQUE do banco ser a única fonte de verdade (ver db.js) e traduz a
// violação pra NOME_JA_CADASTRADO aqui. Checar antes e inserir depois
// deixaria uma janela onde dois cadastros com o mesmo nome ao mesmo tempo
// passariam os dois pela checagem antes de colidir no insert.
export function cadastrar(nome, senha) {
    validarDados(nome, senha);
    const nomeLimpo = nome.trim();

    let usuario;
    try {
        usuario = criarUsuario(nomeLimpo, senha);
    } catch (erro) {
        if (erro.code === 'SQLITE_CONSTRAINT_UNIQUE') {
            throw new ErroCadastro(CodigosErro.NOME_JA_CADASTRADO, `Já existe uma conta com o nome "${nomeLimpo}".`);
        }
        throw erro;
    }

    const player = new Player(usuario.nome, null);
    player.id = usuario.id;

    const token = emitirToken(player);
    return { token, player };
}

function validarDados(nome, senha) {
    if (typeof nome !== 'string' || nome.trim().length < NOME_MIN) {
        throw new ErroCadastro(CodigosErro.CADASTRO_INVALIDO, `Nome precisa ter pelo menos ${NOME_MIN} caracteres.`);
    }
    if (typeof senha !== 'string' || senha.length < SENHA_MIN) {
        throw new ErroCadastro(CodigosErro.CADASTRO_INVALIDO, `Senha precisa ter pelo menos ${SENHA_MIN} caracteres.`);
    }
}

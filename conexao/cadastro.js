// cadastro.js
// Cria contas novas: valida nome/senha, grava no banco (conexao/db.js) e já
// devolve um token de sessão — cadastrar deixa autenticado na hora, sem
// precisar de um "entrar" separado logo em seguida. Não sabe nada sobre
// socket.io, mesmo espírito de login.js.
import { Player } from '../game/Player.js';
import { CodigosErro } from './eventos.js';
import { criarUsuario } from './db.js';
import { emitirToken } from './jwt.js';
import { NOME_MIN, NOME_MAX, SENHA_MIN, SENHA_MAX } from './limites.js';

export class ErroCadastro extends Error {
    constructor(codigo, mensagem) {
        super(mensagem);
        this.name = 'ErroCadastro';
        this.codigo = codigo;
    }
}

// Cria a conta e devolve { token, player } (Promise — criarUsuario usa a API
// assíncrona do bcrypt pro hash), igual login(). Lança ErroCadastro se
// nome/senha forem inválidos ou o nome já existir.
//
// Não faz um SELECT antes pra checar duplicidade — deixa a constraint
// UNIQUE do banco ser a única fonte de verdade (ver db.js) e traduz a
// violação pra NOME_JA_CADASTRADO aqui. Checar antes e inserir depois
// deixaria uma janela onde dois cadastros com o mesmo nome ao mesmo tempo
// passariam os dois pela checagem antes de colidir no insert.
export async function cadastrar(nome, senha) {
    validarDados(nome, senha);
    const nomeLimpo = nome.trim();

    let usuario;
    try {
        usuario = await criarUsuario(nomeLimpo, senha);
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
    if (typeof nome !== 'string' || nome.trim().length < NOME_MIN || nome.trim().length > NOME_MAX) {
        throw new ErroCadastro(CodigosErro.CADASTRO_INVALIDO, `Nome precisa ter entre ${NOME_MIN} e ${NOME_MAX} caracteres.`);
    }
    if (typeof senha !== 'string' || senha.length < SENHA_MIN || senha.length > SENHA_MAX) {
        throw new ErroCadastro(CodigosErro.CADASTRO_INVALIDO, `Senha precisa ter entre ${SENHA_MIN} e ${SENHA_MAX} caracteres.`);
    }
}

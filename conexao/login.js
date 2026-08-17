// login.js
// Autenticação e sessão do jogador: valida nome/senha contra o banco SQLite
// (conexao/db.js) e emite um token de sessão assinado (conexao/jwt.js).
// Não sabe nada sobre socket.io — devolve só { token, player }; quem liga
// isso a uma conexão real é a camada de rede.
import { Player } from '../game/Player.js';
import { CodigosErro } from './eventos.js';
import { buscarUsuarioPorNome, verificarSenha } from './db.js';
import { emitirToken, verificarToken } from './jwt.js';

export class ErroLogin extends Error {
    constructor(codigo, mensagem) {
        super(mensagem);
        this.name = 'ErroLogin';
        this.codigo = codigo;
    }
}

// Autentica nome/senha contra o banco e devolve { token, player }.
// Falha: lança ErroLogin.
//
// O id do player vem da linha do usuário no banco, então é o mesmo em todo
// login daquela conta (diferente do token, que é novo a cada vez — ver
// jwtid em conexao/jwt.js).
export function login(nome, senha) {
    const usuario = buscarUsuarioPorNome(nome);

    if (!usuario) {
        throw new ErroLogin(CodigosErro.USUARIO_NAO_ENCONTRADO, `Usuário "${nome}" não encontrado.`);
    }
    if (!verificarSenha(senha, usuario.senha_hash)) {
        throw new ErroLogin(CodigosErro.SENHA_INCORRETA, 'Senha incorreta.');
    }

    const player = new Player(usuario.nome, null);
    player.id = usuario.id;

    const token = emitirToken(player);

    return { token, player };
}

// Devolve um Player reconstruído a partir dos dados do token, ou null se o
// token for inválido, tiver sido adulterado ou expirado. Diferente do
// player devolvido por login(), este é sempre uma instância nova — não há
// mais sessão em memória guardando identidade de objeto, então a
// comparação que importa é por id/nome, não por referência.
export function validarToken(token) {
    const dados = verificarToken(token);
    if (!dados) return null;

    const player = new Player(dados.nome, null);
    player.id = dados.id;
    return player;
}

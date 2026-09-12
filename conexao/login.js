// login.js
// Autenticação e sessão do jogador: valida nome/senha contra o banco SQLite
// (conexao/db.js) e emite um token de sessão assinado (conexao/jwt.js).
// Não sabe nada sobre socket.io — devolve só { token, player }; quem liga
// isso a uma conexão real é a camada de rede.
import { Player } from '../game/Player.js';
import { CodigosErro } from './eventos.js';
import { buscarUsuarioPorNome, verificarSenha, HASH_DUMMY } from './db.js';
import { emitirToken, verificarToken } from './jwt.js';
import { NOME_MAX, SENHA_MAX } from './limites.js';

export class ErroLogin extends Error {
    constructor(codigo, mensagem) {
        super(mensagem);
        this.name = 'ErroLogin';
        this.codigo = codigo;
    }
}

// Autentica nome/senha contra o banco e devolve { token, player } (Promise —
// verificarSenha é assíncrona, despacha o bcrypt pro threadpool do libuv em
// vez de travar a thread principal). Falha: rejeita com ErroLogin.
//
// O id do player vem da linha do usuário no banco, então é o mesmo em todo
// login daquela conta (diferente do token, que é novo a cada vez — ver
// jwtid em conexao/jwt.js).
export async function login(nome, senha) {
    // Nome/senha fora do teto de conexao/limites.js não podem ser conta
    // real — rejeita rápido, sem tocar banco nem bcrypt. Só MÁXIMO, nunca
    // mínimo: contas antigas (ex.: banco.json, "123") continuam válidas
    // mesmo com senha mais curta que o mínimo de cadastro atual.
    if (typeof nome !== 'string' || nome.length > NOME_MAX || (typeof senha === 'string' && senha.length > SENHA_MAX)) {
        throw new ErroLogin(CodigosErro.USUARIO_NAO_ENCONTRADO, `Usuário "${typeof nome === 'string' ? nome : ''}" não encontrado.`);
    }

    const usuario = buscarUsuarioPorNome(nome);

    // Sempre compara contra ALGUM hash (o de verdade, ou HASH_DUMMY de
    // db.js quando o usuário não existe) — mesmo custo de bcrypt nos dois
    // casos, pra "usuário não encontrado" e "senha incorreta" não se
    // distinguirem pelo tempo de resposta (timing oracle). `?? ''` porque
    // bcrypt rejeita `senha` que não seja string.
    const senhaConfere = await verificarSenha(typeof senha === 'string' ? senha : '', usuario ? usuario.senha_hash : HASH_DUMMY);

    if (!usuario) {
        throw new ErroLogin(CodigosErro.USUARIO_NAO_ENCONTRADO, `Usuário "${nome}" não encontrado.`);
    }
    if (!senhaConfere) {
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

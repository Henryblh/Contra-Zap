// convidado.js
// Login "pseudo-guest": autentica só com nome, sem senha, sem gravar nada no
// banco. O Player nasce só em memória com um id negativo (via
// game/idEfemero.js — mesma fonte que bots/Bot.js, pra nunca colidir nem com
// os ids AUTOINCREMENT do SQLite, sempre positivos, nem entre si) — dá pra
// esquecer essa conta assim que o processo reinicia ou o socket desconecta,
// mesmo espírito de outros dados só-em-memória do projeto (ver socket.js no
// front, que também não persiste token nenhum). Mesmo formato de
// login.js/cadastro.js: não sabe nada sobre socket.io.
import { Player } from '../game/Player.js';
import { proximoIdEfemero } from '../game/idEfemero.js';
import { CodigosErro } from './eventos.js';
import { usuarioExiste } from './db.js';
import { emitirToken } from './jwt.js';

const NOME_MIN = 3;

export class ErroConvidado extends Error {
    constructor(codigo, mensagem) {
        super(mensagem);
        this.name = 'ErroConvidado';
        this.codigo = codigo;
    }
}

// Devolve { token, player }, igual login()/cadastrar(). Lança ErroConvidado
// se o nome for curto demais ou (checagem de última hora, contra corrida com
// um cadastro concorrente) já tiver virado uma conta registrada desde que o
// cliente checou com verificarNome.
export function entrarComoConvidado(nome) {
    if (typeof nome !== 'string' || nome.trim().length < NOME_MIN) {
        throw new ErroConvidado(CodigosErro.CONVIDADO_INVALIDO, `Nome precisa ter pelo menos ${NOME_MIN} caracteres.`);
    }
    const nomeLimpo = nome.trim();

    if (usuarioExiste(nomeLimpo)) {
        throw new ErroConvidado(CodigosErro.NOME_JA_CADASTRADO, `"${nomeLimpo}" já é uma conta registrada — confirme a senha em vez de entrar como convidado.`);
    }

    const player = new Player(nomeLimpo, null);
    player.id = proximoIdEfemero();

    const token = emitirToken(player);
    return { token, player };
}

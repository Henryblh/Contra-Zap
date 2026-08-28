// convidado.js
// Login "pseudo-guest": autentica só com nome, sem senha, sem gravar nada no
// banco. O Player nasce só em memória com um id negativo (nunca colide com
// os ids AUTOINCREMENT do SQLite, que são sempre positivos e começam em 1) —
// dá pra esquecer essa conta assim que o processo reinicia ou o socket
// desconecta, mesmo espírito de outros dados só-em-memória do projeto (ver
// socket.js no front, que também não persiste token nenhum). Mesmo formato
// de login.js/cadastro.js: não sabe nada sobre socket.io.
import { Player } from '../game/Player.js';
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

// Contador compartilhado por todo o processo — cada convidado recebe o
// próximo id negativo, então dois convidados nunca colidem entre si, e
// nenhum convidado colide com uma conta de verdade.
let proximoId = -1;

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
    player.id = proximoId--;

    const token = emitirToken(player);
    return { token, player };
}

// retomarSessao.js
// Reautentica um socket a partir de um token de sessão já emitido (ver
// emitirToken/verificarToken em conexao/jwt.js) — o "gancho" que faltava
// pra não pedir nome/senha de novo depois de uma queda de conexão ou de um
// F5 na página (ver conexao/PROTOCOLO.md, evento `retomarSessao`). Mesmo
// formato de login.js/cadastro.js/convidado.js: não sabe nada sobre
// socket.io, devolve só { token, player }.
import { validarToken } from './login.js';
import { emitirToken } from './jwt.js';
import { CodigosErro } from './eventos.js';

export class ErroSessao extends Error {
    constructor(codigo, mensagem) {
        super(mensagem);
        this.name = 'ErroSessao';
        this.codigo = codigo;
    }
}

// Devolve { token, player } a partir de um token válido — igual login()/
// cadastrar()/entrarComoConvidado(). `validarToken` (conexao/login.js) já
// decodifica o token em um Player sem tocar no banco — funciona igual pra
// conta registrada, recém-cadastrada ou convidado (um convidado só existe
// em memória, mas o id dele continua válido enquanto alguma sala/partida
// ainda o referenciar; ver conexao/convidado.js).
//
// O token devolvido é SEMPRE um novo (mesmo id/nome do antigo, prazo e
// jwtid novos) — assim uma sessão que continua sendo retomada de tempos em
// tempos (a cada reconexão, ou a cada F5) nunca esbarra na expiração fixa
// do token original, sem precisar de um segundo mecanismo de "refresh
// token" separado.
//
// Lança ErroSessao com TOKEN_INVALIDO se o token não bater a assinatura,
// estiver expirado, ou vier ausente/malformado — validarToken já cobre os
// três casos devolvendo null, nunca lançando.
export function retomarSessao(token) {
    const player = validarToken(token);
    if (!player) {
        throw new ErroSessao(CodigosErro.TOKEN_INVALIDO, 'Token inválido ou expirado — faça login novamente.');
    }

    return { token: emitirToken(player), player };
}

// chat.js
// Regras do chat de sala, sem saber o que é socket — recebe os campos crus do
// evento `chat` (ver conexao/PROTOCOLO.md) e devolve o payload pronto pra
// virar broadcast, ou lança ErroChat com um código de conexao/eventos.js.
// Quem liga isso a sockets é o socketServer; isolar aqui é o que deixa testar
// a validação sem rede, igual login.js / SalaManager.js.
import { CodigosErro } from '../eventos.js';
import { mensagemPorId } from './mensagensChat.js';

// Teto do texto livre (tipo 'aberta'). Curto de propósito: chat é um extra num
// jogo simples, não um campo de texto pra qualquer coisa.
export const LIMITE_TEXTO_ABERTO = 200;

export class ErroChat extends Error {
    constructor(codigo, mensagem) {
        super(mensagem);
        this.name = 'ErroChat';
        this.codigo = codigo;
    }
}

// Valida os campos do evento `chat` e monta o miolo do CHAT_MENSAGEM
// (`{ tipo, id, texto }` — o `jogador` e o `salaId` quem põe é o socketServer).
//
// - tipo 'restrita': `id` precisa existir no catálogo (mensagensChat.js);
//   funciona mesmo com `chatAberto` false. `texto` do payload é ignorado — o
//   texto vem sempre do catálogo, o cliente não escolhe.
// - tipo 'aberta': só com `chatAberto` true; `texto` depois de trim precisa
//   ter entre 1 e LIMITE_TEXTO_ABERTO caracteres.
export function montarMensagemChat({ chatAberto, tipo, id, texto }) {
    if (tipo === 'restrita') {
        const item = mensagemPorId(id);
        if (!item) {
            throw new ErroChat(CodigosErro.CHAT_INVALIDO, `Mensagem pronta ${id} não existe.`);
        }
        return { tipo: 'restrita', id: item.id, texto: item.texto };
    }

    if (tipo === 'aberta') {
        if (!chatAberto) {
            throw new ErroChat(CodigosErro.CHAT_DESABILITADO, 'O chat aberto está desligado nesta sala.');
        }
        const limpo = typeof texto === 'string' ? texto.trim() : '';
        if (limpo.length === 0 || limpo.length > LIMITE_TEXTO_ABERTO) {
            throw new ErroChat(
                CodigosErro.CHAT_INVALIDO,
                `A mensagem precisa ter entre 1 e ${LIMITE_TEXTO_ABERTO} caracteres.`
            );
        }
        return { tipo: 'aberta', id: null, texto: limpo };
    }

    throw new ErroChat(CodigosErro.CHAT_INVALIDO, `Tipo de mensagem "${tipo}" desconhecido.`);
}

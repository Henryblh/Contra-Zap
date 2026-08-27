// mensagensChat.js
// Catálogo das mensagens prontas do chat "restrito" — o único lugar do back
// onde o texto delas mora. O cliente manda só o `id`; o servidor resolve o
// texto aqui e repassa os dois no broadcast (ver conexao/chat/chat.js e
// EventosServidor.CHAT_MENSAGEM). Mensagem restrita funciona mesmo com
// `chatAberto: false` na sala — é o chat "sempre disponível".
//
// Pra adicionar/trocar: mexa só neste array. `id` é estável (o front referencia
// por ele) — não reaproveite um id removido pra um texto diferente.
export const MENSAGENS_CHAT = [
    { id: 1, texto: 'Vou fazer essa!!' },
    { id: 2, texto: 'Não faça essa!!' },
    { id: 3, texto: 'Deixa essa passar/fazer' },
    { id: 4, texto: 'Vou fazer na próxima!!' },
];

// Devolve o item do catálogo com esse id, ou null se não existe.
export function mensagemPorId(id) {
    return MENSAGENS_CHAT.find(m => m.id === id) ?? null;
}

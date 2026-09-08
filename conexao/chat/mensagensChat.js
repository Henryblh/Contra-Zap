// mensagensChat.js
// Fonte ÚNICA do catálogo de mensagens prontas do chat "restrito" e do
// cooldown de chat — o back importa daqui (conexao/chat/chat.js valida os
// `id`, conexao/SalaManager.js usa o cooldown) e o front também
// (public/app/src/components/Partida.jsx importa este mesmo arquivo pra
// desenhar os botões; ver server.fs.allow em public/app/vite.config.js).
// Não há mais cópia espelhada no front — mexeu aqui, valeu pros dois lados.
//
// O cliente manda só o `id`; o servidor resolve o texto aqui e repassa os
// dois no broadcast (ver EventosServidor.CHAT_MENSAGEM). Mensagem restrita
// funciona mesmo com `chatAberto: false` — é o chat "sempre disponível".
//
// Pra adicionar/trocar: mexa só neste array. `id` é estável — não reaproveite
// um id removido pra um texto diferente.
export const MENSAGENS_CHAT = [
    { id: 1, texto: 'Vou fazer essa!!' },
    { id: 2, texto: 'Não faça essa!!' },
    { id: 3, texto: 'Deixa essa passar/fazer' },
    { id: 4, texto: 'Vou fazer na próxima!!' },
];

// Cooldown entre envios de chat aceitos (qualquer sala, qualquer tipo), em ms.
// No servidor é o limite de verdade (SalaManager.enviarChat -> CHAT_EM_COOLDOWN);
// no front é só cosmético (desabilita os botões na hora). Mesmo valor nos dois
// porque é o mesmo módulo — nada de sincronizar à mão.
export const CHAT_COOLDOWN_MS = 3_000;

// Devolve o item do catálogo com esse id, ou null se não existe.
export function mensagemPorId(id) {
    return MENSAGENS_CHAT.find(m => m.id === id) ?? null;
}

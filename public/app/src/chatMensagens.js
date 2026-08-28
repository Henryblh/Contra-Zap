// Espelho de conexao/chat/mensagensChat.js — só os rótulos dos 4 botões de
// mensagem pronta. A validação e o texto que aparece no feed vêm do servidor
// (evento chatMensagem); isto aqui é só pra desenhar os botões. Se mexer no
// catálogo do back, mexa aqui também (são poucos itens, de propósito).
export const MENSAGENS_PRONTAS = [
    { id: 1, texto: 'Vou fazer essa!!' },
    { id: 2, texto: 'Não faça essa!!' },
    { id: 3, texto: 'Deixa essa passar/fazer' },
    { id: 4, texto: 'Vou fazer na próxima!!' },
];

// Cooldown entre envios de chat (qualquer tipo), em ms.
export const CHAT_COOLDOWN_MS = 3000;

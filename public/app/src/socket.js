// socket.js
// Conexão socket.io-client única, compartilhada por todos os componentes.
// io() sem argumento conecta na mesma origem que serviu a página — funciona
// tanto no build servido pelo Express (npm start, porta 3000) quanto no dev
// server do Vite (porta 5173, que proxia /socket.io pra :3000 — ver
// vite.config.js).
//
// Nenhum token é guardado aqui (nem localStorage, nem cookie, de propósito):
// cada aba do navegador é uma conexão nova, que precisa de "entrar" ou
// "cadastrar" na hora — é isso que permite abrir várias abas e testar vários
// jogadores ao mesmo tempo sem uma aba "roubar" a sessão da outra.
import { io } from 'socket.io-client';

export const socket = io();
if (typeof window !== 'undefined') window.__socket = socket; // debug via console

// Chama um evento do protocolo (ver conexao/PROTOCOLO.md) e devolve o ack;
// lança se o servidor respondeu { ok: false, ... }. Mesmo padrão do
// Main2.js (conexao/PROTOCOLO.md é o contrato, isso aqui só fala com ele).
export function chamar(evento, payload = {}) {
    return new Promise((resolve, reject) => {
        socket.emit(evento, payload, (resposta) => {
            if (resposta?.ok) resolve(resposta);
            else reject(new Error(`[${resposta?.codigo ?? 'ERRO_DESCONHECIDO'}] ${resposta?.mensagem ?? 'Erro sem detalhes.'}`));
        });
    });
}

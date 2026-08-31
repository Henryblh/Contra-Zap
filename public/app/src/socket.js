// socket.js
// Conexão socket.io-client única, compartilhada por todos os componentes.
// io() sem argumento conecta na mesma origem que serviu a página — funciona
// tanto no build servido pelo Express (npm start, porta 3000) quanto no dev
// server do Vite (porta 5173, que proxia /socket.io pra :3000 — ver
// vite.config.js).
//
// Nenhum token é guardado NESTE arquivo (nem aqui, nem em cookie) — a
// persistência entre um F5 e outro mora em sessao.js, via sessionStorage
// (isolado por aba, de propósito: continua dando pra abrir várias abas e
// testar vários jogadores ao mesmo tempo sem uma aba "roubar" a sessão da
// outra — sessionStorage nunca vaza entre abas, diferente de localStorage).
import { io } from 'socket.io-client';

export const socket = io();
if (typeof window !== 'undefined') window.__socket = socket; // debug via console

// Estado de conexão do socket, pra dar feedback visual quando a rede cai
// (ver App.jsx) — antes disso, a única pista de uma queda era uma ação
// qualquer falhando sem explicação nenhuma. `pingInterval`/`pingTimeout`
// no servidor (Server.js) fazem o `disconnect` chegar rápido (~25s no pior
// caso). Reconexão automática é padrão do socket.io-client (dispara
// `connect` nesta mesma instância de novo) — mas isso só reabre o
// transporte: o servidor trata como um socket totalmente novo, sem sessão
// nenhuma. Então "o socket reconectou" é só "a rede voltou", não "o jogo
// continuou sozinho" — é App.jsx quem reage a isso chamando `retomarSessao`
// de novo (ver sessao.js), pra reautenticar sem pedir nome/senha.
let conectado = socket.connected;
const ouvintesDeConexao = new Set();

function definirConectado(valor) {
    if (conectado === valor) return;
    conectado = valor;
    for (const ouvinte of ouvintesDeConexao) ouvinte();
}

socket.on('connect', () => definirConectado(true));
socket.on('disconnect', () => definirConectado(false));

// API no formato que useSyncExternalStore espera (ver App.jsx): subscribe
// devolve a função de cancelar a assinatura; getSnapshot devolve o valor
// atual, sem criar objeto novo a cada chamada (React compara por
// identidade).
export function assinarConexao(ouvinte) {
    ouvintesDeConexao.add(ouvinte);
    return () => ouvintesDeConexao.delete(ouvinte);
}

export function obterConexao() {
    return conectado;
}

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

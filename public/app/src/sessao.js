// sessao.js
// Persistência da sessão (nome + token) e sinalização de quando uma sessão
// foi retomada com sucesso depois de uma reconexão — separado de socket.js
// (que só cuida da conexão em si, transporte) porque isto aqui é sobre
// IDENTIDADE: quem estamos autenticados como, e como recuperar isso sem
// pedir nome/senha de novo (ver evento `retomarSessao` em
// conexao/PROTOCOLO.md).
//
// sessionStorage, não localStorage nem cookie: sobrevive a um F5 dentro da
// MESMA aba, mas nunca vaza pra outras abas nem sobrevive a fechar a aba.
// Preserva a propriedade que o projeto já tinha de propósito (cada aba pode
// logar como um jogador diferente, útil pra testar vários jogadores ao
// mesmo tempo — ver README.md) — só que agora um F5 acidental não te
// desloga sozinho.
const CHAVE_SESSAO = 'contrazap:sessao';

// { nome, token } | null. Falha silenciosa (sessionStorage bloqueado, modo
// anônimo restritivo, etc.) — nesses casos a sessão só não sobrevive a um
// F5, sem quebrar o resto do app.
export function salvarSessao({ nome, token }) {
    try {
        sessionStorage.setItem(CHAVE_SESSAO, JSON.stringify({ nome, token }));
    } catch {
        // ver comentário acima
    }
}

export function lerSessaoSalva() {
    try {
        const bruto = sessionStorage.getItem(CHAVE_SESSAO);
        return bruto ? JSON.parse(bruto) : null;
    } catch {
        return null;
    }
}

export function limparSessaoSalva() {
    try {
        sessionStorage.removeItem(CHAVE_SESSAO);
    } catch {
        // ver comentário acima
    }
}

// Disparado (sem payload) toda vez que uma sessão é retomada com sucesso
// DEPOIS de uma reconexão de rede (ver App.jsx) — diferente do `connect`
// cru do socket.io (socket.js), que dispara ANTES do servidor saber quem
// somos de novo. Componentes que precisam voltar pra uma room específica
// depois de cair (ex.: Partida.jsx, pra reencaixar numa partida em
// andamento via `reconectar`) devem assinar isto, não o `connect` cru —
// senão a tentativa de voltar pra room chega cedo demais e o servidor
// ainda responde NAO_IDENTIFICADO.
const ouvintesDeSessaoRetomada = new Set();

export function avisarSessaoRetomada() {
    for (const ouvinte of ouvintesDeSessaoRetomada) ouvinte();
}

// Devolve a função de cancelar a assinatura (mesmo formato de
// assinarConexao em socket.js).
export function assinarSessaoRetomada(ouvinte) {
    ouvintesDeSessaoRetomada.add(ouvinte);
    return () => ouvintesDeSessaoRetomada.delete(ouvinte);
}

// eventos.js
// Vocabulário compartilhado do protocolo socket.io: nomes de eventos e códigos
// de erro. Nem servidor nem cliente devem usar strings soltas — sempre
// importar daqui, pra um typo virar erro de import e não bug silencioso em runtime.
// Este arquivo não conhece regras de jogo nem sala: é só vocabulário.
//
// Eventos cliente -> servidor são todos request/response via ack do
// socket.io (`socket.emit(evento, payload, callback)`), respondendo sempre
// `{ ok: true, ...resultado }` ou `{ ok: false, codigo, mensagem }`
// (`codigo` é sempre um valor de CodigosErro). Não existe um evento de erro
// separado — o erro vem na própria resposta do ack. Ver PROTOCOLO.md.

export const EventosCliente = {
    ENTRAR: 'entrar',           // { nome, senha } -> ack: { ok, nome, token }
    CRIAR_SALA: 'criarSala',    // { numberPlayers, roundStart, randomShuffle } -> ack: { ok, salaId, numberPlayers }
    ENTRAR_SALA: 'entrarSala',  // { salaId } -> ack: { ok, salaId, numberPlayers, jogadores }
    LISTAR_SALAS: 'listarSalas', // {} -> ack: { ok, salas: [{ salaId, numberPlayers, jogadoresAtual }] }
};

// Único evento de verdade "empurrado" pelo servidor sem ter sido pedido por
// um ack: broadcast pra sala inteira toda vez que a lista de jogadores muda.
export const EventosServidor = {
    LISTA_JOGADORES: 'listaJogadores', // { salaId, jogadores: [{ nome, gameId }] }
};

export const CodigosErro = {
    NAO_IDENTIFICADO: 'NAO_IDENTIFICADO',   // tentou criar/entrar/listar sala sem mandar ENTRAR antes
    NOME_INVALIDO: 'NOME_INVALIDO',         // nome já em uso na mesma sala
    SALA_NAO_ENCONTRADA: 'SALA_NAO_ENCONTRADA',
    SALA_CHEIA: 'SALA_CHEIA',
    SALA_JA_INICIADA: 'SALA_JA_INICIADA',
    JA_ESTA_NA_SALA: 'JA_ESTA_NA_SALA',
    USUARIO_NAO_ENCONTRADO: 'USUARIO_NAO_ENCONTRADO', // login: nome não existe no banco
    SENHA_INCORRETA: 'SENHA_INCORRETA',               // login: nome existe, senha não bate
    ERRO_INTERNO: 'ERRO_INTERNO',                     // exceção inesperada no servidor (não deveria acontecer)
};

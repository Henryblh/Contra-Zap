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
    CADASTRAR: 'cadastrar',     // { nome, senha } -> ack: { ok, nome, token } — já autentica, sem precisar de "entrar" depois
    CRIAR_SALA: 'criarSala',    // { numberPlayers, roundStart, randomShuffle, botNumber } -> ack: { ok, salaId, numberPlayers, jogadores, segundosParaIniciar } — botNumber preenche o resto dos assentos com bots (ver bots/Bot.js); segundosParaIniciar != null se os bots já lotaram a sala
    ENTRAR_SALA: 'entrarSala',  // { salaId } -> ack: { ok, salaId, numberPlayers, jogadores, segundosParaIniciar } — segundosParaIniciar != null se esta entrada lotou a sala
    LISTAR_SALAS: 'listarSalas', // {} -> ack: { ok, salas: [{ salaId, numberPlayers, jogadoresAtual }] }
    FORCAR_INICIO: 'forcarInicio', // { salaId } -> ack: { ok } — só o adm da sala, só com a sala cheia
    SAIR_SALA: 'sairSala',       // { salaId } -> ack: { ok } — só antes da partida começar
    SAIR_DA_PARTIDA: 'sairDaPartida', // { salaId } -> ack: { ok } — abandono voluntário de partida JÁ em andamento; o assento vira bot na hora (reaproveita o caminho da expulsão por inatividade)
    APOSTAR: 'apostar',          // { salaId, valor } -> ack: { ok } — valor é o número de vazas que o jogador acha que vai fazer
    JOGAR_CARTA: 'jogarCarta',   // { salaId, indice } -> ack: { ok } — indice é 0-based, posição na mão
    RECONECTAR: 'reconectar',    // { salaId } -> ack: { ok, mao, suaVez, jogadorDaVez } — sala com partida já em andamento
    MINHA_SALA_ATIVA: 'minhaSalaAtiva', // {} -> ack: { ok, salaId: string | null } — existe uma partida em andamento em que eu ainda tenho assento? pra descobrir sem saber o salaId de antemão (ex.: depois de um refresh de página)
};

// Eventos empurrados pelo servidor sem ter sido pedidos por um ack.
// LISTA_JOGADORES é broadcast de sala; os demais (a partir de
// PARTIDA_INICIANDO_EM) são o andamento da partida, retransmitido do
// GameController — todos broadcast de sala, exceto SUA_MAO, que é privado
// (só o próprio jogador recebe, via sala pessoal `jogador:<id>`).
export const EventosServidor = {
    LISTA_JOGADORES: 'listaJogadores', // { salaId, jogadores: [{ nome }] }
    PARTIDA_INICIANDO_EM: 'partidaIniciandoEm', // { salaId, segundos }
    NOVA_RODADA_INICIADA: 'novaRodadaIniciada', // { salaId, numero, cartas }
    SUA_MAO: 'suaMao',                          // { salaId, mao: string[] } — PRIVADO
    MAOS_REVELADAS: 'maosReveladas',            // { salaId, maos: [{ jogador, mao: string[] }] } — PRIVADO; conjunto de mãos que ESTE jogador pode ver (hoje: rodada de 1 carta / "testa", cada um vê a mão dos outros menos a sua). Genérico — dá pra reusar em showdown, espectador, debug.
    MANILHA_VIRADA: 'manilhaVirada',            // { salaId, vira, viraValor }
    TURNO_APOSTA: 'turnoAposta',                // { salaId, id, jogador } — id de quem tem que apostar agora
    APOSTA_FEITA: 'apostaFeita',                // { salaId, jogador, aposta } — só depois que a aposta foi de fato registrada (real ou timeout)
    TURNO_JOGADOR: 'turnoJogador',              // { salaId, id, jogador } — id de quem tem que jogar
    CARTA_JOGADA: 'cartaJogada',                // { salaId, jogador, carta, status }
    VAZA_FINALIZADA: 'vazaFinalizada',          // { salaId, vencedor, carta }
    RODADA_FINALIZADA: 'rodadaFinalizada',      // { salaId, numero, resultado }
    JOGADORES_ELIMINADOS: 'jogadoresEliminados', // { salaId, eliminados: [{ nome, hp }] }
    JOGO_FINALIZADO: 'jogoFinalizado',          // { salaId, vencedor }
    JOGADA_AUTOMATICA: 'jogadaAutomatica',      // { salaId, id, jogador } — tempoTurnoMs estourou, jogou sozinho
    JOGADOR_RECONECTOU: 'jogadorReconectou',    // { salaId, id, jogador }
    JOGADOR_EXPULSO_POR_INATIVIDADE: 'jogadorExpulsoPorInatividade', // { salaId, id, jogador } — ficou limiteInatividadeMs sem agir; o socket dele já saiu da sala (assento continua, dá pra "reconectar")
};

export const CodigosErro = {
    NAO_IDENTIFICADO: 'NAO_IDENTIFICADO',   // tentou criar/entrar/listar sala sem mandar ENTRAR antes
    NOME_INVALIDO: 'NOME_INVALIDO',         // nome já em uso na mesma sala
    CONFIGURACAO_INVALIDA: 'CONFIGURACAO_INVALIDA', // numberPlayers/roundStart fora do intervalo aceito
    SALA_NAO_ENCONTRADA: 'SALA_NAO_ENCONTRADA',
    SALA_CHEIA: 'SALA_CHEIA',
    SALA_NAO_CHEIA: 'SALA_NAO_CHEIA',       // forcarInicio antes da sala lotar
    SALA_JA_INICIADA: 'SALA_JA_INICIADA',
    SALA_NAO_INICIADA: 'SALA_NAO_INICIADA', // jogarCarta numa sala cuja partida ainda não começou
    JA_ESTA_NA_SALA: 'JA_ESTA_NA_SALA',
    NAO_ESTA_NA_SALA: 'NAO_ESTA_NA_SALA',   // sairSala por quem não está (mais) nessa sala
    NAO_AUTORIZADO: 'NAO_AUTORIZADO',       // forcarInicio por quem não é o adm da sala
    NAO_E_SUA_VEZ: 'NAO_E_SUA_VEZ',         // jogarCarta/apostar fora da sua vez
    CARTA_INVALIDA: 'CARTA_INVALIDA',       // jogarCarta com índice fora da mão
    APOSTA_INVALIDA: 'APOSTA_INVALIDA',     // apostar com valor fora de [0, número de cartas da rodada]
    APOSTA_FECHA_RODADA: 'APOSTA_FECHA_RODADA', // último a apostar não pode escolher o valor que fecha a soma das apostas no número de cartas
    USUARIO_NAO_ENCONTRADO: 'USUARIO_NAO_ENCONTRADO', // login: nome não existe no banco
    SENHA_INCORRETA: 'SENHA_INCORRETA',               // login: nome existe, senha não bate
    CADASTRO_INVALIDO: 'CADASTRO_INVALIDO',           // cadastrar: nome/senha fora do tamanho mínimo aceito
    NOME_JA_CADASTRADO: 'NOME_JA_CADASTRADO',         // cadastrar: nome já existe no banco
    ERRO_INTERNO: 'ERRO_INTERNO',                     // exceção inesperada no servidor (não deveria acontecer)
};

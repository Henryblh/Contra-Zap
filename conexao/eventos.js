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
    VERIFICAR_NOME: 'verificarNome', // { nome } -> ack: { ok, existe: boolean } — pré-autenticação (não precisa de "entrar" antes); decide se o cliente pede senha pra confirmar identidade ou oferece cadastro/convidado. Rate-limit por IP (ver conexao/rateLimiter.js) — estourou, MUITAS_TENTATIVAS
    ENTRAR: 'entrar',           // { nome, senha } -> ack: { ok, nome, token }. Rate-limit de FALHA por IP (5 a cada 20min por padrão, ver conexao/rateLimiter.js) — estourou, MUITAS_TENTATIVAS sem nem tentar o login; a falha que consome a última unidade da janela vem com `ultimaTentativa: true` na resposta de erro
    CADASTRAR: 'cadastrar',     // { nome, senha } -> ack: { ok, nome, token } — já autentica, sem precisar de "entrar" depois
    ENTRAR_COMO_CONVIDADO: 'entrarComoConvidado', // { nome } -> ack: { ok, nome, token } — pseudo-guest: Player só em memória (id negativo), nunca grava no banco; nasce autenticado igual entrar/cadastrar
    RETOMAR_SESSAO: 'retomarSessao', // { token } -> ack: { ok, nome, token } — reautentica o socket a partir de um token já emitido (entrar/cadastrar/entrarComoConvidado/retomarSessao anterior), sem pedir nome/senha de novo; devolve sempre um token NOVO (mesmo id/nome, prazo renovado)
    CRIAR_SALA: 'criarSala',    // { numberPlayers, roundStart, randomShuffle, botNumber, chatAberto } -> ack: { ok, salaId, numberPlayers, jogadores, segundosParaIniciar, chatAberto } — botNumber preenche o resto dos assentos com bots (ver bots/Bot.js); segundosParaIniciar != null se os bots já lotaram a sala; chatAberto (default false) libera o chat de texto livre da sala. Erros de teto: LIMITE_DE_SALAS (global), LIMITE_DE_SALAS_POR_JOGADOR (por pessoa), JA_EM_PARTIDA (já tem assento numa partida em andamento)
    ENTRAR_SALA: 'entrarSala',  // { salaId } -> ack: { ok, salaId, numberPlayers, jogadores, segundosParaIniciar, chatAberto } — segundosParaIniciar != null se esta entrada lotou a sala
    PARTIDA_RAPIDA: 'partidaRapida', // {} -> ack: { ok, salaId, numberPlayers, jogadores, segundosParaIniciar, chatAberto } — mesmo formato de criarSala/entrarSala; entra numa fila compartilhada de sala default (config igual criarSala sem parâmetros), criando-a se não houver nenhuma aberta no momento
    LISTAR_SALAS: 'listarSalas', // {} -> ack: { ok, salas: [{ salaId, numberPlayers, jogadoresAtual, chatAberto }] }
    FORCAR_INICIO: 'forcarInicio', // { salaId } -> ack: { ok } — só o adm da sala, só com a sala cheia
    SAIR_SALA: 'sairSala',       // { salaId } -> ack: { ok } — só antes da partida começar
    SAIR_DA_PARTIDA: 'sairDaPartida', // { salaId } -> ack: { ok } — abandono voluntário de partida JÁ em andamento; o assento vira bot na hora (reaproveita o caminho da expulsão por inatividade), MAS a vaga continua reservada pra reconectar
    DESISTIR: 'desistir',       // { salaId } -> ack: { ok } — desistência DEFINITIVA de uma partida em andamento: perde na hora (hp zerado -> eliminado na virada de rodada) e a vaga expira já (não dá mais pra reconectar), liberando o jogador pra entrar em outra sala. Usado pelo fluxo "desistir e entrar" quando JA_EM_PARTIDA barra a entrada numa segunda sala
    JOGAR_DE_NOVO: 'jogarDeNovo', // { salaId } -> ack: { ok, salaId, numberPlayers, jogadores, segundosParaIniciar, chatAberto } — só o adm da sala TERMINADA (`salaId` é a sala antiga); cria uma sala nova com a mesma config e avisa quem mais estava lá (ver EventosServidor.CONVITE_REVANCHE)
    APOSTAR: 'apostar',          // { salaId, valor } -> ack: { ok } — valor é o número de vazas que o jogador acha que vai fazer
    JOGAR_CARTA: 'jogarCarta',   // { salaId, indice } -> ack: { ok } — indice é 0-based, posição na mão
    RECONECTAR: 'reconectar',    // { salaId } -> ack: { ok, salaId, jogadores, mao, cartasRodada, numeroRodada, maosReveladas, mesa, vira, viraValor, apostas, eliminados, desconectados, ultimoPlacar, suaVez, jogadorDaVez, suaVezDaAposta, jogadorDaVezAposta, finalizada, vencedor, chatAberto } — estado pra remontar a tela inteira de uma partida já em andamento (ver PROTOCOLO.md)
    MINHA_SALA_ATIVA: 'minhaSalaAtiva', // {} -> ack: { ok, salaId: string | null } — existe uma partida em andamento (começou, não terminou) em que eu ainda tenho assento reclamável? pra descobrir sem saber o salaId de antemão (ex.: depois de um refresh de página)
    CHAT: 'chat',                // { salaId, tipo: 'aberta' | 'restrita', texto?, id? } -> ack: { ok } — 'restrita' (id do catálogo, ver conexao/chat/mensagensChat.js) sempre liberada; 'aberta' (texto livre) só se a sala foi criada com chatAberto
};

// Eventos empurrados pelo servidor sem ter sido pedidos por um ack.
// LISTA_JOGADORES é broadcast de sala; os demais (a partir de
// PARTIDA_INICIANDO_EM) são o andamento da partida, retransmitido do
// GameController — todos broadcast de sala, exceto SUA_MAO, que é privado
// (só o próprio jogador recebe, via sala pessoal `jogador:<id>`).
export const EventosServidor = {
    LISTA_JOGADORES: 'listaJogadores', // { salaId, jogadores: [{ nome, adm }] }
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
    PARTIDA_ABORTADA: 'partidaAbortada',        // { salaId, motivo, erro } — erro interno inesperado no motor (invariante quebrada, ex.: baralho vazio); a partida parou e não recupera. GameController.finalizada vira true, igual jogoFinalizado. A sala NÃO é desmontada sozinha — dá pra investigar.
    JOGADA_AUTOMATICA: 'jogadaAutomatica',      // { salaId, id, jogador } — tempoTurnoMs estourou, jogou sozinho
    JOGADOR_RECONECTOU: 'jogadorReconectou',    // { salaId, id, jogador }
    JOGADOR_DESISTIU: 'jogadorDesistiu',        // { salaId, id, jogador } — desistiu de vez (ver EventosCliente.DESISTIR); perde na hora e a vaga expira (um vagaExpirada sai logo em seguida). O socket dele já saiu da room.
    JOGADOR_EXPULSO_POR_INATIVIDADE: 'jogadorExpulsoPorInatividade', // { salaId, id, jogador } — ficou limiteInatividadeMs sem agir; o socket dele já saiu da sala (assento continua, dá pra "reconectar")
    VAGA_EXPIRADA: 'vagaExpirada', // { salaId, id, jogador } — tempoReservaMs sem reconectar depois de virar bot; a vaga não pode mais ser reclamada, esse assento é bot pro resto da partida
    NOVO_ADM: 'novoAdm', // { salaId, id, jogador } — o adm anterior teve a vaga expirada (ver VAGA_EXPIRADA); passa pro próximo jogador de verdade (nem bot original, nem com vaga expirada) na ordem de entrada
    CONVITE_REVANCHE: 'convidadoParaRevanche', // { salaId, novaSalaId, jogador } — broadcast na sala TERMINADA (salaId) quando o adm dela chama jogarDeNovo; jogador é o nome de quem chamou, novaSalaId é onde entrar (via entrarSala normal) se aceitar
    CHAT_MENSAGEM: 'chatMensagem',              // { salaId, jogador, tipo: 'aberta' | 'restrita', id: number | null, texto } — broadcast pra sala inteira, incluindo quem enviou
};

export const CodigosErro = {
    NAO_IDENTIFICADO: 'NAO_IDENTIFICADO',   // tentou criar/entrar/listar sala sem mandar ENTRAR antes
    NOME_INVALIDO: 'NOME_INVALIDO',         // nome já em uso na mesma sala
    CONFIGURACAO_INVALIDA: 'CONFIGURACAO_INVALIDA', // numberPlayers/roundStart fora do intervalo aceito
    LIMITE_DE_SALAS: 'LIMITE_DE_SALAS',     // criarSala com o teto global de salas vivas já atingido — tenta de novo mais tarde
    LIMITE_DE_SALAS_POR_JOGADOR: 'LIMITE_DE_SALAS_POR_JOGADOR', // criarSala por quem já é adm de salas ativas demais ao mesmo tempo (teto por pessoa) — feche/termine alguma antes
    SALA_NAO_ENCONTRADA: 'SALA_NAO_ENCONTRADA',
    SALA_CHEIA: 'SALA_CHEIA',
    SALA_NAO_CHEIA: 'SALA_NAO_CHEIA',       // forcarInicio antes da sala lotar
    SALA_JA_INICIADA: 'SALA_JA_INICIADA',
    SALA_NAO_INICIADA: 'SALA_NAO_INICIADA', // jogarCarta numa sala cuja partida ainda não começou
    SALA_NAO_FINALIZADA: 'SALA_NAO_FINALIZADA', // jogarDeNovo antes de jogoFinalizado disparar na sala
    JA_ESTA_NA_SALA: 'JA_ESTA_NA_SALA',
    JA_EM_PARTIDA: 'JA_EM_PARTIDA',         // criarSala/entrarSala/partidaRapida por quem já tem assento reclamável numa partida em andamento; a resposta traz { salaId } da partida antiga — o cliente oferece reconectar nela ou desistir dela (DESISTIR) antes de entrar em outra
    NAO_ESTA_NA_SALA: 'NAO_ESTA_NA_SALA',   // sairSala por quem não está (mais) nessa sala
    VAGA_EXPIRADA: 'VAGA_EXPIRADA',         // reconectar depois que tempoReservaMs passou sem ninguém voltar — a vaga virou bot pra sempre, não dá mais pra reclamar
    NAO_AUTORIZADO: 'NAO_AUTORIZADO',       // forcarInicio por quem não é o adm da sala
    NAO_E_SUA_VEZ: 'NAO_E_SUA_VEZ',         // jogarCarta/apostar fora da sua vez
    CARTA_INVALIDA: 'CARTA_INVALIDA',       // jogarCarta com índice fora da mão
    APOSTA_INVALIDA: 'APOSTA_INVALIDA',     // apostar com valor fora de [0, número de cartas da rodada]
    APOSTA_FECHA_RODADA: 'APOSTA_FECHA_RODADA', // último a apostar não pode escolher o valor que fecha a soma das apostas no número de cartas
    CHAT_DESABILITADO: 'CHAT_DESABILITADO',   // chat 'aberta' numa sala criada sem chatAberto
    CHAT_INVALIDO: 'CHAT_INVALIDO',           // chat com tipo desconhecido, id fora do catálogo, ou texto vazio/longo demais
    CHAT_EM_COOLDOWN: 'CHAT_EM_COOLDOWN',     // chat antes de chatCooldownMs passar desde o último envio aceito (qualquer sala, qualquer tipo)
    USUARIO_NAO_ENCONTRADO: 'USUARIO_NAO_ENCONTRADO', // login: nome não existe no banco
    SENHA_INCORRETA: 'SENHA_INCORRETA',               // login: nome existe, senha não bate
    CADASTRO_INVALIDO: 'CADASTRO_INVALIDO',           // cadastrar: nome/senha fora do tamanho mínimo aceito
    NOME_JA_CADASTRADO: 'NOME_JA_CADASTRADO',         // cadastrar: nome já existe no banco; ou entrarComoConvidado: nome virou conta registrada entre o verificarNome e esta chamada (corrida com um cadastro concorrente)
    CONVIDADO_INVALIDO: 'CONVIDADO_INVALIDO',         // entrarComoConvidado: nome fora do tamanho mínimo aceito
    TOKEN_INVALIDO: 'TOKEN_INVALIDO',                 // retomarSessao com token que não bate a assinatura, expirou, ou veio ausente/malformado
    MUITAS_TENTATIVAS: 'MUITAS_TENTATIVAS',           // teto de tentativas por IP estourado num evento pré-autenticação (ver conexao/rateLimiter.js) — espere a janela passar
    ERRO_INTERNO: 'ERRO_INTERNO',                     // exceção inesperada no servidor (não deveria acontecer)
};

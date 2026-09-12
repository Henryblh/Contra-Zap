// SalaManager.js
// Camada de sala: sabe criar salas, colocar jogadores nelas e validar as regras
// de entrada (lotação, duplicidade, partida já iniciada). Não sabe nada sobre
// socket.io — recebe e devolve objetos de domínio (Player, Sala), nada de
// socket/transporte aqui. Quem liga isso a sockets é uma camada futura, fora
// deste arquivo. Isso é o que permite testar tudo isto sem precisar de rede.
import { randomUUID } from 'node:crypto';
import { GameController } from '../game/GameController.js';
import { Bot } from '../bots/Bot.js';
import { CodigosErro } from './eventos.js';
import { montarMensagemChat, ErroChat } from './chat/chat.js';
import { CHAT_COOLDOWN_MS } from './chat/mensagensChat.js';

export class ErroSala extends Error {
    // `dados` (opcional) é um objeto que a camada de socket espalha na
    // resposta de erro do ack, além de { codigo, mensagem } — ex.:
    // JA_EM_PARTIDA manda { salaId } da partida antiga, pro cliente já saber
    // onde reconectar / de onde desistir.
    constructor(codigo, mensagem, dados) {
        super(mensagem);
        this.name = 'ErroSala';
        this.codigo = codigo;
        this.dados = dados;
    }
}

const NUMERO_JOGADORES_MIN = 2;
const NUMERO_JOGADORES_MAX = 6;
// Teto de cartas na primeira rodada. Sem isto, um roundStart absurdo (ex.:
// 1e6) faria Rodada montar milhares de baralhos (ver game/Rodada.js ->
// game/Baralho.js) e derrubaria o processo por OOM antes da partida sequer
// começar. 10 é muito mais do que qualquer partida real usa — a rodada só
// cresce +1 carta por vez e a partida costuma acabar em poucas rodadas (ver
// game/GameController.js).
const ROUND_START_MAX = 10;
// maxDeck: teto de baralhos de 40 cartas que a partida pode montar numa
// rodada (ver game/Game.js -> proximaRodada). MIN 1; o topo é tratado como
// "Sem Limite" (50 baralhos = 2000 cartas, inalcançável numa partida real).
const MAX_DECK_MIN = 1;
const MAX_DECK_SEM_LIMITE = 50;
const TEMPO_ESPERA_INICIO_MS_PADRAO = 15_000;
// Teto global de salas vivas ao mesmo tempo. É uma barreira de sanidade
// contra criação em massa (memória, e o do..while de _gerarSalaId começando a
// colidir com o espaço de ids cheio), não um número que uma operação normal
// deva chegar perto. Passou disso, criarSala devolve LIMITE_DE_SALAS.
const MAX_SALAS = 1000;
// Teto de salas vivas que um mesmo jogador pode ter criado ao mesmo tempo
// (conta as em que ele ainda é o adm e a partida não terminou). Sem isto,
// nada impedia um cliente criar dezenas de salas de 1 pessoa e deixar
// largadas até um disconnect podar. Passou disso, criarSala devolve
// LIMITE_DE_SALAS_POR_JOGADOR. Salas finalizadas não contam (o "jogar de
// novo" cria uma sala nova e não pode ser barrado por salas velhas que só
// não foram limpas ainda).
const MAX_SALAS_POR_JOGADOR = 4;

// Quantos baralhos uma rodada com `numberPlayers` e mão de `round` cartas
// precisa — mesma conta de game/Game.js (numCards = jogadores*round + 1).
function baralhosNecessarios(numberPlayers, round) {
    return Math.ceil((numberPlayers * round + 1) / 40);
}

function validarConfig({ numberPlayers, roundStart, botNumber, chatAberto, randomShuffle, maxDeck, seed }) {
    if (!Number.isInteger(numberPlayers) || numberPlayers < NUMERO_JOGADORES_MIN || numberPlayers > NUMERO_JOGADORES_MAX) {
        throw new ErroSala(
            CodigosErro.CONFIGURACAO_INVALIDA,
            `numberPlayers deve ser um número inteiro entre ${NUMERO_JOGADORES_MIN} e ${NUMERO_JOGADORES_MAX}.`
        );
    }
    if (!Number.isInteger(roundStart) || roundStart < 1 || roundStart > ROUND_START_MAX) {
        throw new ErroSala(
            CodigosErro.CONFIGURACAO_INVALIDA,
            `roundStart deve ser um número inteiro entre 1 e ${ROUND_START_MAX}.`
        );
    }
    if (!Number.isInteger(maxDeck) || maxDeck < MAX_DECK_MIN || maxDeck > MAX_DECK_SEM_LIMITE) {
        throw new ErroSala(
            CodigosErro.CONFIGURACAO_INVALIDA,
            `maxDeck deve ser um número inteiro entre ${MAX_DECK_MIN} e ${MAX_DECK_SEM_LIMITE}.`
        );
    }
    // A primeira rodada (mesa cheia) já tem que caber em maxDeck baralhos —
    // depois disso a mão só cresce, então se nem a inicial cabe a partida
    // nunca sairia do lugar. Só morde quando maxDeck é baixo E roundStart alto.
    const baralhosPrimeiraRodada = baralhosNecessarios(numberPlayers, roundStart);
    if (baralhosPrimeiraRodada > maxDeck) {
        throw new ErroSala(
            CodigosErro.CONFIGURACAO_INVALIDA,
            `roundStart ${roundStart} com ${numberPlayers} jogadores precisa de ${baralhosPrimeiraRodada} baralhos, acima do maxDeck ${maxDeck}.`
        );
    }
    // <= numberPlayers - 1 pra sempre sobrar pelo menos o assento de quem
    // está criando a sala — sem isso daria pra criar uma sala sem nenhum
    // jogador de verdade nela.
    if (!Number.isInteger(botNumber) || botNumber < 0 || botNumber > numberPlayers - 1) {
        throw new ErroSala(
            CodigosErro.CONFIGURACAO_INVALIDA,
            `botNumber deve ser um número inteiro entre 0 e ${numberPlayers - 1}.`
        );
    }
    if (typeof chatAberto !== 'boolean') {
        throw new ErroSala(CodigosErro.CONFIGURACAO_INVALIDA, 'chatAberto deve ser true ou false.');
    }
    if (typeof randomShuffle !== 'boolean') {
        throw new ErroSala(CodigosErro.CONFIGURACAO_INVALIDA, 'randomShuffle deve ser true ou false.');
    }
    // seed é opcional (ausente = Math.random de sempre). Quando vem, tem que
    // ser um inteiro não-negativo — vira estado de PRNG (ver game/rng.js).
    if (seed !== undefined && (!Number.isInteger(seed) || seed < 0)) {
        throw new ErroSala(CodigosErro.CONFIGURACAO_INVALIDA, 'seed, se informada, deve ser um número inteiro não-negativo.');
    }
}

// Uma sala = um GameController (que já guarda seus próprios jogadores/config
// de sala de espera). "iniciada" não é uma flag separada de propósito: é derivada de
// `controller.game`, pra não existir um segundo lugar de verdade que possa
// dessincronizar do estado real do controller.
class Sala {
    constructor(salaId, config) {
        this.salaId = salaId;
        this.controller = new GameController(config);
        // Config de sala, não de jogo — o GameController nem vê isso. Libera o
        // chat de texto livre (tipo 'aberta'); as mensagens prontas ('restrita')
        // não dependem dele. Fixo na criação, não muda depois.
        this.chatAberto = config.chatAberto ?? false;
        // Config completa usada pra criar esta sala (incluindo botNumber, que
        // o GameController nem vê — só usado no momento de encher a sala com
        // bots). Guardada só pra "jogar de novo" (ver SalaManager.jogarDeNovo)
        // poder recriar uma sala idêntica sem precisar que o chamador lembre
        // dos valores originais.
        this.configOriginal = {
            numberPlayers: config.numberPlayers,
            roundStart: config.roundStart,
            randomShuffle: config.randomShuffle,
            maxDeck: config.maxDeck,
            botNumber: config.botNumber ?? 0,
            chatAberto: this.chatAberto,
        };
    }

    get numberPlayers() { return this.controller.numberPlayers; }
    get jogadores() { return this.controller.jogadores; }
    get iniciada() { return this.controller.game !== null; }
}

export class SalaManager {
    constructor({ tempoEsperaInicioMs = TEMPO_ESPERA_INICIO_MS_PADRAO, tempoTurnoMs, limiteInatividadeMs, atrasoBotMs, tempoReservaMs, chatCooldownMs = CHAT_COOLDOWN_MS, maxSalasPorJogador = MAX_SALAS_POR_JOGADOR } = {}) {
        this.salas = new Map();
        this.tempoEsperaInicioMs = tempoEsperaInicioMs;
        // Teto de salas vivas não finalizadas que um mesmo jogador pode ter
        // criado ao mesmo tempo (ver _exigirAbaixoDoTetoDeSalas). Injetável
        // pelo mesmo motivo de tempoTurnoMs & cia.: testes que compartilham um
        // SalaManager entre casos precisam poder afrouxar isso.
        this.maxSalasPorJogador = maxSalasPorJogador;
        // undefined = deixa o GameController usar o próprio default (20s).
        // Só existe como opção aqui pra testes conseguirem injetar um valor
        // bem menor sem precisar mexer em GameController diretamente.
        this.tempoTurnoMs = tempoTurnoMs;
        // undefined = deixa o GameController usar o próprio default (90s).
        // Mesmo motivo do tempoTurnoMs acima.
        this.limiteInatividadeMs = limiteInatividadeMs;
        // undefined = deixa o GameController usar o próprio default (2s).
        // Mesmo motivo do tempoTurnoMs acima.
        this.atrasoBotMs = atrasoBotMs;
        // undefined = deixa o GameController usar o próprio default (150s).
        // Mesmo motivo do tempoTurnoMs acima.
        this.tempoReservaMs = tempoReservaMs;
        // Cooldown entre envios de chat aceitos (qualquer sala, qualquer
        // tipo) — ver enviarChat. Diferente dos tempos acima, tem default
        // aqui mesmo (não delegado ao GameController): chat é da camada de
        // conexão, não do jogo (ver conexao/chat/chat.js).
        this.chatCooldownMs = chatCooldownMs;
        // playerId -> Date.now() do último chat aceito por ele — um cooldown
        // só por pessoa, não por sala, pra não dar pra escapar criando uma
        // segunda sala só pra spammar em paralelo.
        this._ultimoChatPorJogador = new Map();
        // salaId da sala "da fila" de partidaRapida (ver método abaixo), ou
        // null se ninguém pediu partida rápida ainda. Não precisa ser
        // invalidado explicitamente quando a sala lota/descarta — partidaRapida
        // sempre confere se ainda está aberta antes de reusar.
        this.salaFilaRapidaId = null;
    }

    // Cria uma sala nova e já coloca o jogador que criou dentro dela. Quem
    // cria vira o adm da sala (pode forçar início antes dos 15s, ver
    // forcarInicio). Lança ErroSala com CONFIGURACAO_INVALIDA se
    // numberPlayers/roundStart/botNumber estiverem fora do intervalo aceito
    // (roundStart vai de 1 a ROUND_START_MAX) ou se chatAberto/randomShuffle
    // não forem boolean — a camada de socket (responder() em socketServer.js)
    // traduz esse throw pro ack de erro, não derruba nada. `botNumber`
    // (default 0) preenche o resto dos assentos com
    // bots (ver bots/Bot.js) assim que a sala nasce — se isso já lotar a
    // sala, a partida é agendada na hora, igual a qualquer entrarSala que
    // lote (ver _entrar).
    //
    // `aoNascer(sala)` (opcional) roda depois que o dono entrou mas ANTES
    // dos bots — é o gancho pra camada de socket ligar a retransmissão dos
    // eventos do controller (e o join na room) antes de um botNumber que
    // lota a sala disparar agendarInicio/partidaIniciandoEm de dentro daqui;
    // sem isso esse primeiro evento se perderia (mesmo motivo do roster vir
    // no próprio ack de criarSala — ver conexao/socketServer.js).
    criarSala(player, config = {}, aoNascer) {
        if (this.salas.size >= MAX_SALAS) {
            throw new ErroSala(
                CodigosErro.LIMITE_DE_SALAS,
                `Limite de ${MAX_SALAS} salas simultâneas atingido — tente de novo daqui a pouco.`
            );
        }
        const numberPlayers = config.numberPlayers ?? 4;
        const roundStart = config.roundStart ?? 3;
        const botNumber = config.botNumber ?? 0;
        const chatAberto = config.chatAberto ?? false;
        const randomShuffle = config.randomShuffle ?? true;
        const maxDeck = config.maxDeck ?? MAX_DECK_SEM_LIMITE;
        // Ausente = Math.random de sempre. Não entra na configOriginal de
        // propósito: "jogar de novo" deve ser uma partida nova, não a repetição
        // carta-por-carta da anterior.
        const seed = config.seed;
        validarConfig({ numberPlayers, roundStart, botNumber, chatAberto, randomShuffle, maxDeck, seed });

        this._exigirSemPartidaEmAndamento(player);
        this._exigirAbaixoDoTetoDeSalas(player);

        const salaId = this._gerarSalaId();
        const sala = new Sala(salaId, {
            numberPlayers,
            roundStart,
            randomShuffle,
            maxDeck,
            seed,
            botNumber,
            chatAberto,
            tempoTurnoMs: this.tempoTurnoMs,
            limiteInatividadeMs: this.limiteInatividadeMs,
            atrasoBotMs: this.atrasoBotMs,
            tempoReservaMs: this.tempoReservaMs,
        });

        this.salas.set(salaId, sala);
        // Não sobrou ninguém real que possa voltar (ver
        // GameController._expirarVaga) — a sala já era, tira ela do sistema
        // na mesma hora. O jogo em si (bot contra bot a essa altura) termina
        // sozinho em segundo plano, sem custo real.
        sala.controller.on('salaAbandonada', () => this.removerSala(salaId));
        this._entrar(sala, player);
        sala.jogadores[0].adm = true;

        aoNascer?.(sala);

        for (let i = 0; i < botNumber; i++) {
            this._entrar(sala, new Bot());
        }

        return sala;
    }

    // "Partida rápida": entra numa fila compartilhada de sala com config
    // default (mesmo resultado de criarSala(player, {}) — 4 jogadores, 3
    // cartas na primeira rodada, sem bots, chat fechado). Quem chama primeiro
    // cria a sala e ela vira "a sala da fila"; todo mundo que chamar depois,
    // enquanto ela continuar aberta (não cheia, não iniciada — mesmo critério
    // de listarAbertas), entra nela, igual um entrarSala manual só que sem
    // precisar saber o salaId. Assim que ela deixa de estar aberta (lotou, ou
    // foi descartada por ficar vazia), a referência guardada fica "velha" —
    // em vez de invalidar isso em algum outro lugar toda vez que o estado da
    // sala muda, a checagem "ainda está aberta?" é feita aqui mesmo, na hora:
    // o próximo chamador simplesmente cria outra sala do zero.
    //
    // `aoNascer` (mesmo gancho de criarSala) só roda quando uma sala nova
    // nasce — reentrar numa já existente não precisa religar nada, o
    // controller já está com os listeners de socket assinados desde que ela
    // nasceu. Devolve { sala, criada } pra quem chamou saber se precisa
    // religar o controller (criada) ou só entrar numa sala já pronta.
    partidaRapida(player, aoNascer) {
        const atual = this.salaFilaRapidaId ? this.salas.get(this.salaFilaRapidaId) : null;
        const aberta = atual && !atual.iniciada && atual.jogadores.length < atual.numberPlayers;

        if (aberta) {
            return { sala: this.entrarSala(atual.salaId, player), criada: false };
        }

        const sala = this.criarSala(player, {}, aoNascer);
        this.salaFilaRapidaId = sala.salaId;
        return { sala, criada: true };
    }

    // "Jogar de novo": só quem é o adm da sala que TERMINOU (jogoFinalizado
    // já disparou, ver GameController.finalizada) pode chamar. Cria uma sala
    // nova com exatamente a mesma config da que terminou (configOriginal, ver
    // Sala acima) e devolve ela já com o próprio dono dentro — mesmo
    // criarSala de sempre, só com a config vindo da sala antiga em vez do
    // cliente. Quem mais estava na sala antiga é avisado por fora daqui (ver
    // EventosServidor.CONVITE_REVANCHE em socketServer.js) — este método só
    // cuida de criar a sala nova.
    jogarDeNovo(salaAntigaId, player, aoNascer) {
        const salaAntiga = this.salas.get(salaAntigaId);
        if (!salaAntiga) {
            throw new ErroSala(CodigosErro.SALA_NAO_ENCONTRADA, `Sala "${salaAntigaId}" não existe.`);
        }
        if (!salaAntiga.controller.finalizada) {
            throw new ErroSala(CodigosErro.SALA_NAO_FINALIZADA, 'A partida desta sala ainda não terminou.');
        }
        if (!salaAntiga.controller.jogadorEhAdm(player.id)) {
            throw new ErroSala(CodigosErro.NAO_AUTORIZADO, 'Só quem criou a sala pode chamar pra jogar de novo.');
        }

        return this.criarSala(player, salaAntiga.configOriginal, aoNascer);
    }

    // Coloca um jogador numa sala existente, validando as regras de entrada.
    // Lança ErroSala (com um código de conexao/eventos.js) se alguma falhar.
    entrarSala(salaId, player) {
        const sala = this.salas.get(salaId);
        if (!sala) {
            throw new ErroSala(CodigosErro.SALA_NAO_ENCONTRADA, `Sala "${salaId}" não existe.`);
        }
        this._exigirSemPartidaEmAndamento(player);
        if (sala.iniciada) {
            throw new ErroSala(CodigosErro.SALA_JA_INICIADA, 'A partida desta sala já começou.');
        }
        if (sala.jogadores.length >= sala.numberPlayers) {
            throw new ErroSala(CodigosErro.SALA_CHEIA, 'Esta sala já está cheia.');
        }
        if (sala.jogadores.some(jogador => jogador.id === player.id)) {
            throw new ErroSala(CodigosErro.JA_ESTA_NA_SALA, 'Você já está nesta sala.');
        }
        if (sala.jogadores.some(jogador => jogador.nome === player.nome)) {
            throw new ErroSala(CodigosErro.NOME_INVALIDO, `O nome "${player.nome}" já está em uso nesta sala.`);
        }

        this._entrar(sala, player);
        return sala;
    }

    // O adm da sala pula a espera de tempoEsperaInicioMs e começa na hora.
    // Só funciona com a sala cheia (senão não tem partida pra começar) e só
    // pra quem criou a sala.
    forcarInicio(salaId, player) {
        const sala = this.salas.get(salaId);
        if (!sala) {
            throw new ErroSala(CodigosErro.SALA_NAO_ENCONTRADA, `Sala "${salaId}" não existe.`);
        }
        if (sala.iniciada) {
            throw new ErroSala(CodigosErro.SALA_JA_INICIADA, 'A partida desta sala já começou.');
        }
        if (sala.jogadores.length < sala.numberPlayers) {
            throw new ErroSala(CodigosErro.SALA_NAO_CHEIA, 'A sala ainda não está cheia.');
        }
        if (!sala.controller.jogadorEhAdm(player.id)) {
            throw new ErroSala(CodigosErro.NAO_AUTORIZADO, 'Só quem criou a sala pode forçar o início.');
        }

        sala.controller.forcarInicio();
        return sala;
    }

    // Joga uma carta em nome do jogador — só vale numa sala com partida em
    // andamento. `indice` é a posição da carta na mão dele (0-based); a
    // validação de "é a vez dele mesmo?" e "esse índice existe na mão dele?"
    // é toda do GameController (jogarCarta) — aqui só traduz o resultado
    // pro vocabulário de erro do protocolo.
    jogarCarta(salaId, player, indice) {
        const sala = this.salas.get(salaId);
        if (!sala) {
            throw new ErroSala(CodigosErro.SALA_NAO_ENCONTRADA, `Sala "${salaId}" não existe.`);
        }
        if (!sala.iniciada) {
            throw new ErroSala(CodigosErro.SALA_NAO_INICIADA, 'A partida desta sala ainda não começou.');
        }

        const resultado = sala.controller.jogarCarta(player.id, indice);
        if (!resultado.ok) {
            if (resultado.motivo === 'NAO_E_SUA_VEZ') {
                throw new ErroSala(CodigosErro.NAO_E_SUA_VEZ, 'Não é a sua vez de jogar.');
            }
            throw new ErroSala(CodigosErro.CARTA_INVALIDA, 'Essa carta não existe na sua mão.');
        }

        return sala;
    }

    // Registra a aposta de um jogador — só vale numa sala com partida em
    // andamento. Mesma tradução de erro que jogarCarta: NAO_E_SUA_VEZ se não
    // for a vez dele de apostar, APOSTA_INVALIDA se o valor estiver fora de
    // [0, número de cartas da rodada], APOSTA_FECHA_RODADA se ele for o
    // último a apostar e o valor fechar a soma de todo mundo no número de
    // cartas (ver GameController.apostar).
    apostar(salaId, player, valor) {
        const sala = this.salas.get(salaId);
        if (!sala) {
            throw new ErroSala(CodigosErro.SALA_NAO_ENCONTRADA, `Sala "${salaId}" não existe.`);
        }
        if (!sala.iniciada) {
            throw new ErroSala(CodigosErro.SALA_NAO_INICIADA, 'A partida desta sala ainda não começou.');
        }

        const resultado = sala.controller.apostar(player.id, valor);
        if (!resultado.ok) {
            if (resultado.motivo === 'NAO_E_SUA_VEZ') {
                throw new ErroSala(CodigosErro.NAO_E_SUA_VEZ, 'Não é a sua vez de apostar.');
            }
            if (resultado.motivo === 'APOSTA_FECHA_RODADA') {
                throw new ErroSala(CodigosErro.APOSTA_FECHA_RODADA, 'Esse valor fecharia a soma das apostas no número de cartas da rodada — escolha outro.');
            }
            throw new ErroSala(CodigosErro.APOSTA_INVALIDA, 'Valor de aposta inválido.');
        }

        return sala;
    }

    // Reencaixa um jogador numa partida já em andamento depois de uma
    // desconexão — diferente de entrarSala, que é só pra sala de espera.
    // Reaproveita os mesmos códigos de erro de sala inexistente/não
    // iniciada; NAO_ESTA_NA_SALA aqui significa "você não faz parte dessa
    // partida" (nunca esteve na sala, ou a sala é de outra pessoa).
    // Devolve { sala, estado } — estado é o que o GameController.estadoDeReconexao
    // devolveu (mão atual + de quem é a vez).
    reconectar(salaId, player) {
        const sala = this.salas.get(salaId);
        if (!sala) {
            throw new ErroSala(CodigosErro.SALA_NAO_ENCONTRADA, `Sala "${salaId}" não existe.`);
        }
        if (!sala.iniciada) {
            throw new ErroSala(CodigosErro.SALA_NAO_INICIADA, 'Essa sala ainda não começou — use entrarSala.');
        }
        if (sala.controller.vagaExpirada(player.id)) {
            throw new ErroSala(CodigosErro.VAGA_EXPIRADA, 'Sua vaga nessa partida expirou — não é mais possível reconectar.');
        }

        const estado = sala.controller.estadoDeReconexao(player.id);
        if (!estado) {
            throw new ErroSala(CodigosErro.NAO_ESTA_NA_SALA, 'Você não faz parte dessa partida.');
        }

        sala.controller.marcarReconectado(player.id);
        return { sala, estado };
    }

    // Abandono voluntário de uma partida JÁ em andamento (botão "Sair da
    // partida" no front) — o par do sairSala, que só vale antes de começar.
    // Reaproveita o caminho da expulsão por inatividade (ver
    // GameController.abandonarPartida): o assento vira bot na hora em vez de
    // esperar limiteInatividadeMs acumular a cada timeout. NAO_ESTA_NA_SALA
    // se quem pediu não faz parte dessa partida.
    abandonarPartida(salaId, player) {
        const sala = this.salas.get(salaId);
        if (!sala) {
            throw new ErroSala(CodigosErro.SALA_NAO_ENCONTRADA, `Sala "${salaId}" não existe.`);
        }
        if (!sala.iniciada) {
            throw new ErroSala(CodigosErro.SALA_NAO_INICIADA, 'A partida desta sala ainda não começou.');
        }
        if (!sala.controller.abandonarPartida(player.id)) {
            throw new ErroSala(CodigosErro.NAO_ESTA_NA_SALA, 'Você não faz parte dessa partida.');
        }
        return sala;
    }

    // Desistência DEFINITIVA de uma partida em andamento (ver
    // GameController.desistir): perde na hora e a vaga expira já, liberando o
    // jogador pra entrar em outra sala — é o que o fluxo "desistir e entrar"
    // da Lobby chama depois de um JA_EM_PARTIDA. NAO_ESTA_NA_SALA se quem
    // pediu não faz parte de uma partida em andamento nessa sala.
    desistir(salaId, player) {
        const sala = this.salas.get(salaId);
        if (!sala) {
            throw new ErroSala(CodigosErro.SALA_NAO_ENCONTRADA, `Sala "${salaId}" não existe.`);
        }
        if (!sala.iniciada) {
            throw new ErroSala(CodigosErro.SALA_NAO_INICIADA, 'A partida desta sala ainda não começou.');
        }
        if (!sala.controller.desistir(player.id)) {
            throw new ErroSala(CodigosErro.NAO_ESTA_NA_SALA, 'Você não faz parte de uma partida em andamento nessa sala.');
        }
        return sala;
    }

    // Tira o jogador da sala antes da partida começar — saída voluntária ou
    // limpeza de desconexão (ver socketServer.js, que chama isto nos dois
    // casos e engole o erro no caso de desconexão, já que não tem cliente
    // pra responder). Se a sala ficar vazia, é descartada — sem isso, salas
    // abandonadas ficariam acumulando pra sempre em memória.
    sairSala(salaId, player) {
        const sala = this.salas.get(salaId);
        if (!sala) {
            throw new ErroSala(CodigosErro.SALA_NAO_ENCONTRADA, `Sala "${salaId}" não existe.`);
        }
        if (sala.iniciada) {
            throw new ErroSala(CodigosErro.SALA_JA_INICIADA, 'Não dá pra sair de uma sala cuja partida já começou.');
        }
        if (!sala.controller.removerJogador(player.id)) {
            throw new ErroSala(CodigosErro.NAO_ESTA_NA_SALA, 'Você não está nesta sala.');
        }

        if (sala.jogadores.length === 0) {
            this.salas.delete(salaId);
        }

        return sala;
    }

    // Chat de sala — vale tanto na sala de espera quanto com a partida em
    // andamento (ver conexao/PROTOCOLO.md). `montarMensagemChat` (ver
    // conexao/chat/chat.js) valida o conteúdo em si (tipo/id/texto) e lança
    // ErroChat; aqui só cuida do que é específico de sala — quem manda
    // precisa estar nela — e do cooldown (chatCooldownMs), pra um cliente
    // customizado não conseguir spammar a sala inteira sem limite nenhum. O
    // relógio do cooldown só anda numa mensagem ACEITA: uma tentativa
    // inválida (CHAT_INVALIDO/CHAT_DESABILITADO) não consome nem estica o
    // prazo de quem já estava dentro dele.
    enviarChat(salaId, player, { tipo, id, texto }) {
        const sala = this.salas.get(salaId);
        if (!sala) {
            throw new ErroSala(CodigosErro.SALA_NAO_ENCONTRADA, `Sala "${salaId}" não existe.`);
        }
        if (!sala.jogadores.some(jogador => jogador.id === player.id)) {
            throw new ErroSala(CodigosErro.NAO_ESTA_NA_SALA, 'Você não está nesta sala.');
        }

        const agora = Date.now();
        const ultimoEnvio = this._ultimoChatPorJogador.get(player.id);
        if (ultimoEnvio !== undefined && agora - ultimoEnvio < this.chatCooldownMs) {
            throw new ErroChat(CodigosErro.CHAT_EM_COOLDOWN, 'Aguarde um pouco antes de mandar outra mensagem.');
        }

        const conteudo = montarMensagemChat({ chatAberto: sala.chatAberto, tipo, id, texto });
        this._ultimoChatPorJogador.set(player.id, agora);
        this._podarCooldownChat(agora);
        return conteudo;
    }

    // Tira do Map as marcas de chat que já passaram do cooldown: uma entrada
    // mais velha que chatCooldownMs nunca mais barra ninguém (a checagem lá em
    // cima só olha `agora - ultimoEnvio < chatCooldownMs`), então guardá-la só
    // vaza memória. Sem isto o Map cresce uma entrada por jogador que já
    // mandou chat alguma vez e nunca encolhe. Roda a cada envio aceito — custo
    // O(n) diluído pelo próprio cooldown de 3s por jogador.
    _podarCooldownChat(agora) {
        for (const [playerId, ts] of this._ultimoChatPorJogador) {
            if (agora - ts >= this.chatCooldownMs) {
                this._ultimoChatPorJogador.delete(playerId);
            }
        }
    }

    obterSala(salaId) {
        return this.salas.get(salaId) ?? null;
    }

    // Descarta a sala do sistema incondicionalmente — chamado quando não
    // sobra mais ninguém real (ver o listener de 'salaAbandonada' em
    // criarSala) ou, de fora (socketServer.js), quando a partida já
    // terminou (`controller.finalizada`) e o último socket saiu dela (ver
    // encerrarSeFinalizadaEVazia). Idempotente: chamar de novo, ou com um
    // salaId que já não existe, não faz nada.
    removerSala(salaId) {
        const sala = this.salas.get(salaId);
        if (!sala) return;
        this.salas.delete(salaId);
        // Teardown do controller: para o loop da partida se ainda estiver no
        // ar, solta os listeners de socket e cancela os timers de reserva —
        // sem isto a sala some do Map mas o GameController continua vivo em
        // segundo plano (ver GameController.destruir). salaFilaRapidaId, se
        // apontar pra esta, continua sendo tratado como "ref velha" por
        // partidaRapida, que já confere se ainda está aberta antes de reusar.
        sala.controller.destruir();
    }

    // Salas que ainda aceitam gente: não iniciadas e não cheias. Resumo
    // enxuto pra listagem (não expõe o controller nem os objetos Player).
    listarAbertas() {
        return [...this.salas.values()]
            .filter(sala => !sala.iniciada && sala.jogadores.length < sala.numberPlayers)
            .map(sala => ({
                salaId: sala.salaId,
                numberPlayers: sala.numberPlayers,
                jogadoresAtual: sala.jogadores.length,
                chatAberto: sala.chatAberto,
            }));
    }

    // Partida em andamento (começou, ainda não terminou) em que esse playerId
    // tem assento reclamável (vaga não expirada). É a fonte única pra duas
    // coisas: `minhaSalaAtiva` (o cliente descobre sozinho onde reconectar,
    // ex.: depois de um refresh) e o guard de entrada (não dá pra ter assento
    // em duas partidas ao mesmo tempo — ver _exigirSemPartidaEmAndamento).
    // Exclusões:
    //  - sala não iniciada: lá "sair" já é de verdade (sairSala), não tem
    //    assento pra descobrir;
    //  - sala finalizada (mas ainda no Map): reconectar numa partida que já
    //    acabou não serve pra nada, e barra o próprio adm de "jogar de novo";
    //  - vaga expirada: virou bot pra sempre (ver GameController._expirarVaga
    //    / desistir), o jogador não está mais preso a ela.
    // Como não dá mais pra acumular assentos (o guard barra), na prática só
    // existe uma — mas a busca continua devolvendo a primeira achada.
    _salaEmAndamentoDoJogador(playerId) {
        for (const sala of this.salas.values()) {
            if (sala.iniciada
                && !sala.controller.finalizada
                && sala.jogadores.some(jogador => jogador.id === playerId && !jogador.vagaExpirada)) {
                return sala;
            }
        }
        return null;
    }

    salaAtivaDoJogador(playerId) {
        return this._salaEmAndamentoDoJogador(playerId)?.salaId ?? null;
    }

    // Barra criarSala/entrarSala/partidaRapida quando o jogador já tem
    // assento reclamável numa partida em andamento — sem isto dava pra
    // acumular assento em várias partidas (e reconectar em todas). O erro
    // carrega o salaId da partida antiga: o cliente oferece reconectar nela
    // ou desistir dela (DESISTIR) antes de entrar noutra.
    _exigirSemPartidaEmAndamento(player) {
        const salaAtiva = this._salaEmAndamentoDoJogador(player.id);
        if (salaAtiva) {
            throw new ErroSala(
                CodigosErro.JA_EM_PARTIDA,
                `Você já está numa partida em andamento (sala ${salaAtiva.salaId}) — reconecte ou desista dela antes de entrar em outra.`,
                { salaId: salaAtiva.salaId }
            );
        }
    }

    // Barra criarSala quando o jogador já é adm de maxSalasPorJogador salas
    // vivas e não finalizadas — teto por pessoa, complementar ao MAX_SALAS
    // global. Uma sala em que ele deixou de ser adm (saiu da sala de espera,
    // ou a vaga expirou na partida) não conta mais contra ele. O `?.` cobre
    // entrada malformada no Map (só acontece em teste que stuba `salas`).
    _exigirAbaixoDoTetoDeSalas(player) {
        let minhas = 0;
        for (const sala of this.salas.values()) {
            if (sala.controller && !sala.controller.finalizada && sala.controller.jogadorEhAdm(player.id)) {
                minhas++;
            }
        }
        if (minhas >= this.maxSalasPorJogador) {
            throw new ErroSala(
                CodigosErro.LIMITE_DE_SALAS_POR_JOGADOR,
                `Você já tem ${this.maxSalasPorJogador} salas ativas — feche ou termine alguma antes de criar outra.`
            );
        }
    }

    _entrar(sala, player) {
        sala.controller.entrarNaSala(player);
        if (sala.jogadores.length === sala.numberPlayers) {
            sala.controller.agendarInicio(this.tempoEsperaInicioMs);
        }
    }

    _gerarSalaId() {
        let id;
        do {
            id = randomUUID().replace(/-/g, '').slice(0, 6).toUpperCase();
        } while (this.salas.has(id));
        return id;
    }
}

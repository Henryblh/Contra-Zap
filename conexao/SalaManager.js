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

export class ErroSala extends Error {
    constructor(codigo, mensagem) {
        super(mensagem);
        this.name = 'ErroSala';
        this.codigo = codigo;
    }
}

const NUMERO_JOGADORES_MIN = 2;
const NUMERO_JOGADORES_MAX = 6;
const TEMPO_ESPERA_INICIO_MS_PADRAO = 15_000;

function validarConfig({ numberPlayers, roundStart, botNumber }) {
    if (!Number.isInteger(numberPlayers) || numberPlayers < NUMERO_JOGADORES_MIN || numberPlayers > NUMERO_JOGADORES_MAX) {
        throw new ErroSala(
            CodigosErro.CONFIGURACAO_INVALIDA,
            `numberPlayers deve ser um número inteiro entre ${NUMERO_JOGADORES_MIN} e ${NUMERO_JOGADORES_MAX}.`
        );
    }
    if (!Number.isInteger(roundStart) || roundStart < 1) {
        throw new ErroSala(CodigosErro.CONFIGURACAO_INVALIDA, 'roundStart deve ser um número inteiro maior ou igual a 1.');
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
}

// Uma sala = um GameController (que já guarda seus próprios jogadores/config
// de sala de espera). "iniciada" não é uma flag separada de propósito: é derivada de
// `controller.game`, pra não existir um segundo lugar de verdade que possa
// dessincronizar do estado real do controller.
class Sala {
    constructor(salaId, config) {
        this.salaId = salaId;
        this.controller = new GameController(config);
    }

    get numberPlayers() { return this.controller.numberPlayers; }
    get jogadores() { return this.controller.jogadores; }
    get iniciada() { return this.controller.game !== null; }
}

export class SalaManager {
    constructor({ tempoEsperaInicioMs = TEMPO_ESPERA_INICIO_MS_PADRAO, tempoTurnoMs, limiteInatividadeMs, atrasoBotMs } = {}) {
        this.salas = new Map();
        this.tempoEsperaInicioMs = tempoEsperaInicioMs;
        // undefined = deixa o GameController usar o próprio default (15s).
        // Só existe como opção aqui pra testes conseguirem injetar um valor
        // bem menor sem precisar mexer em GameController diretamente.
        this.tempoTurnoMs = tempoTurnoMs;
        // undefined = deixa o GameController usar o próprio default (90s).
        // Mesmo motivo do tempoTurnoMs acima.
        this.limiteInatividadeMs = limiteInatividadeMs;
        // undefined = deixa o GameController usar o próprio default (1s).
        // Mesmo motivo do tempoTurnoMs acima.
        this.atrasoBotMs = atrasoBotMs;
    }

    // Cria uma sala nova e já coloca o jogador que criou dentro dela. Quem
    // cria vira o adm da sala (pode forçar início antes dos 15s, ver
    // forcarInicio). Lança ErroSala com CONFIGURACAO_INVALIDA se
    // numberPlayers/roundStart/botNumber estiverem fora do intervalo
    // aceito. `botNumber` (default 0) preenche o resto dos assentos com
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
        const numberPlayers = config.numberPlayers ?? 4;
        const roundStart = config.roundStart ?? 3;
        const botNumber = config.botNumber ?? 0;
        validarConfig({ numberPlayers, roundStart, botNumber });

        const salaId = this._gerarSalaId();
        const sala = new Sala(salaId, {
            numberPlayers,
            roundStart,
            randomShuffle: config.randomShuffle ?? true,
            tempoTurnoMs: this.tempoTurnoMs,
            limiteInatividadeMs: this.limiteInatividadeMs,
            atrasoBotMs: this.atrasoBotMs,
        });

        this.salas.set(salaId, sala);
        this._entrar(sala, player);
        sala.jogadores[0].adm = true;

        aoNascer?.(sala);

        for (let i = 0; i < botNumber; i++) {
            this._entrar(sala, new Bot());
        }

        return sala;
    }

    // Coloca um jogador numa sala existente, validando as regras de entrada.
    // Lança ErroSala (com um código de conexao/eventos.js) se alguma falhar.
    entrarSala(salaId, player) {
        const sala = this.salas.get(salaId);
        if (!sala) {
            throw new ErroSala(CodigosErro.SALA_NAO_ENCONTRADA, `Sala "${salaId}" não existe.`);
        }
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

    obterSala(salaId) {
        return this.salas.get(salaId) ?? null;
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
            }));
    }

    // Acha uma partida já em andamento em que esse playerId ainda tem
    // assento — é o que permite um socket recém-autenticado (ex.: depois de
    // um refresh de página, sem estado nenhum guardado no cliente) descobrir
    // sozinho que existe uma partida esperando por ele, sem saber o salaId
    // de antemão (ver EventosCliente.MINHA_SALA_ATIVA). Salas não iniciadas
    // não contam — lá "sair" já é de verdade (ver sairSala), não tem assento
    // pra descobrir. Se o jogador tiver mais de uma (hoje possível: nada
    // impede criar/entrar numa sala nova depois de sair de outra em
    // andamento), devolve a primeira encontrada — caso raro, não vale a
    // complexidade de devolver uma lista ainda.
    salaAtivaDoJogador(playerId) {
        for (const sala of this.salas.values()) {
            if (sala.iniciada && sala.jogadores.some(jogador => jogador.id === playerId)) {
                return sala.salaId;
            }
        }
        return null;
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

// GameController.js
// Dona da sala de espera (lista de jogadores antes da partida começar) e
// orquestra a partida inteira (Game -> RodadaGame -> Mesa) quando ela
// começa, expondo o andamento como eventos em vez de console.log espalhado.
//
// Isso serve dois consumidores ao mesmo tempo, sem duplicar a lógica de regras:
//  - Main.js: assina os eventos e imprime no console (harness de teste local)
//  - Server.js (futuro): assina os eventos e faz io.emit(...) para os clientes via socket.io
import { EventEmitter } from 'node:events';
import { Game } from './Game.js';
import { PlayerGame } from './PlayerGame.js';

export class GameController extends EventEmitter {
    constructor({ numberPlayers, roundStart, randomShuffle } = {}) {
        super();
        this.numberPlayers = numberPlayers || 4;
        this.roundStart = roundStart || 3;
        this.randomShuffle = randomShuffle;
        this.jogadores = [];
        this.game = null;
        this.rodada = null;
        this.numeroRodada = 0;
        this._timerInicio = null;
    }

    // Sala de espera: transforma o Player que entrou num PlayerGame e guarda
    // na lista até a partida começar. Ordem de chegada é a própria posição
    // no array — nenhum campo à parte guarda isso.
    entrarNaSala(player) {
        this.jogadores.push(new PlayerGame(player));
        this.emit('jogadorEntrou', { id: player.id, nome: player.nome });
        return this;
    }

    // Chamado quando a sala lota: dá um tempo de espera antes de começar de
    // verdade (dá chance de cancelar via forcarInicio, ou simplesmente pra
    // não começar no instante exato que a última pessoa entra). Idempotente
    // — chamar de novo com a partida já agendada ou já iniciada não faz nada.
    agendarInicio(tempoEsperaMs) {
        if (this.game || this._timerInicio) return;

        this._timerInicio = setTimeout(() => this.iniciarPartida(), tempoEsperaMs);
        this._timerInicio.unref?.(); // não deve segurar o processo vivo (testes, shutdown)
        this.emit('partidaIniciandoEm', { segundos: tempoEsperaMs / 1000 });
    }

    // Pura consulta — não lança, não muda estado. Quem decide se isso vira
    // um erro de protocolo (NAO_AUTORIZADO) é a camada de sala, não aqui.
    jogadorEhAdm(playerId) {
        return this.jogadores.some(jogador => jogador.id === playerId && jogador.adm);
    }

    // Sala de espera, ao contrário: tira o jogador da lista. Só faz sentido
    // antes da partida começar (quem chama garante isso, olhando `game`).
    // Se quem saiu era o adm e sobrou gente, o próximo da lista assume — a
    // sala nunca fica sem ninguém que possa forçar início. Cancela um
    // início agendado, já que a sala deixou de estar cheia. Devolve false
    // se o jogador nem estava na lista (chamador decide se isso é erro).
    removerJogador(playerId) {
        const indice = this.jogadores.findIndex(jogador => jogador.id === playerId);
        if (indice === -1) return false;

        const eraAdm = this.jogadores[indice].adm;
        this.jogadores.splice(indice, 1);
        if (eraAdm && this.jogadores.length > 0) {
            this.jogadores[0].adm = true;
        }

        if (this._timerInicio) {
            clearTimeout(this._timerInicio);
            this._timerInicio = null;
        }

        this.emit('jogadorSaiu', { id: playerId });
        return true;
    }

    // Pula a espera de agendarInicio e começa na hora. Quem valida se quem
    // pediu tem permissão é a camada de sala (via jogadorEhAdm), antes de
    // chamar isto.
    forcarInicio() {
        if (this._timerInicio) {
            clearTimeout(this._timerInicio);
            this._timerInicio = null;
        }
        this.iniciarPartida();
    }

    iniciarPartida() {
        if (this.game) return this; // idempotente — evita reiniciar se o timer e um forcarInicio colidirem

        if (this._timerInicio) {
            clearTimeout(this._timerInicio);
            this._timerInicio = null;
        }

        this.game = new Game({
            numberPlayers: this.numberPlayers,
            roundStart: this.roundStart,
            randomShuffle: this.randomShuffle,
            jogadores: [...this.jogadores],
        });
        this.game.setstartsequence();

        this.numeroRodada = 1;
        this.rodada = this.game.newRodada();
        this.emit('novaRodadaIniciada', { numero: this.numeroRodada, cartas: this.rodada.round });

        // A partir daqui a partida roda em segundo plano, pausando pra
        // esperar cada jogada real (ver _aguardarJogada/jogarCarta) — pode
        // levar segundos, minutos, o tempo que for. iniciarPartida() não
        // espera nada disso, só dispara e devolve na hora. O .catch aqui é
        // a mesma filosofia do responder() em socketServer.js: um erro
        // inesperado no meio da partida não pode virar um unhandled
        // rejection e derrubar o processo.
        this._jogarRodadaAtual().catch(erro => {
            console.error('Erro inesperado durante a partida:', erro);
        });
        return this;
    }

    // Devolve uma Promise que só resolve quando jogarCarta(jogador.id, ...)
    // for chamado com sucesso pra esse jogador específico — é a pausa real
    // que faltava. Guardar { jogadorId, resolver } ANTES de emitir
    // turnoJogador (chamado por quem usa isto) é o que permite um listener
    // síncrono (ex.: o auto-play do Main.js) responder na hora, dentro do
    // próprio emit, sem cair numa corrida onde a espera ainda nem existe.
    _aguardarJogada(jogador) {
        return new Promise((resolve) => {
            this._jogadaEsperada = { jogadorId: jogador.id, resolver: resolve };
        });
    }

    // Chamado de fora (via protocolo) quando um jogador manda a carta que
    // quer jogar. `indice` é a posição na mão dele (0-based). Devolve
    // { ok: true } se aceita — e só então o índice é consumido e a espera
    // em _jogarRodadaAtual é liberada — ou { ok: false, motivo } se não for
    // a vez desse jogador ou o índice não existir na mão dele; nesses casos
    // nada muda e a espera continua de pé.
    jogarCarta(playerId, indice) {
        if (!this._jogadaEsperada || this._jogadaEsperada.jogadorId !== playerId) {
            return { ok: false, motivo: 'NAO_E_SUA_VEZ' };
        }

        const jogador = this.jogadores.find(j => j.id === playerId);
        if (!Number.isInteger(indice) || indice < 0 || indice >= jogador.mao.length) {
            return { ok: false, motivo: 'CARTA_INVALIDA' };
        }

        const resolver = this._jogadaEsperada.resolver;
        this._jogadaEsperada = null;
        resolver(indice);
        return { ok: true };
    }

    async _jogarRodadaAtual() {
        const rodada = this.rodada;

        rodada.darCartas();
        this.emit('cartasDistribuidas', rodada.gameOrder.map(j => ({
            id: j.id,
            nome: j.nome,
            mao: j.mao.map(c => c.toString())
        })));

        rodada.virarManilha();
        this.emit('manilhaVirada', { vira: rodada.vira.toString(), viraValor: rodada.viraValor });

        for (const jogador of rodada.gameOrder) {
            jogador.aposta = 1;
            this.emit('apostaFeita', { jogador: jogador.nome, aposta: jogador.aposta });
        }

        for (let v = 0; v < rodada.round; v++) {
            if (v > 0) rodada.novaVaza();

            const ordem = rodada.ordemDaVaza();
            for (const jogador of ordem) {
                const jogadaFeita = this._aguardarJogada(jogador);
                this.emit('turnoJogador', { id: jogador.id, jogador: jogador.nome });
                const indice = await jogadaFeita;

                const carta = jogador.mao.splice(indice, 1)[0];
                const status = rodada.registrarJogada(jogador, carta);
                this.emit('cartaJogada', { jogador: jogador.nome, carta: carta.toString(), status });
            }

            const vencedor = rodada.finalizarVaza();
            this.emit('vazaFinalizada', {
                vencedor: vencedor ? vencedor.nome : null,
                carta: vencedor ? rodada.mesaAtiva.melhorJogada.carta.toString() : null
            });
        }

        const apostas = new Map(rodada.gameOrder.map(j => [j, j.aposta]));
        const steaks = new Map(rodada.gameOrder.map(j => [j, j.steak]));
        rodada.finalizarRodada();
        this.emit('rodadaFinalizada', {
            numero: this.numeroRodada,
            resultado: rodada.gameOrder.map(j => ({
                nome: j.nome,
                aposta: apostas.get(j),
                steak: steaks.get(j),
                diferenca: Math.abs(apostas.get(j) - steaks.get(j)),
                hp: j.hp
            }))
        });

        await this._avancarOuFinalizar();
    }

    async _avancarOuFinalizar() {
        const vivos = this.game.gameOrder.filter(j => j.hp > 0);
        if (vivos.length === 1) {
            this.emit('jogoFinalizado', { vencedor: vivos[0].nome });
            return;
        }
        if (vivos.length === 0) {
            // Todos os jogadores que disputavam a mesa zeraram o hp na mesma rodada.
            // Desempate: vence quem teve a menor diferença entre aposta e steak na última rodada.
            const vencedor = this.rodada.gameOrder.reduce((melhor, jogador) => {
                const diferenca = Math.abs(jogador.aposta - jogador.steak);
                return diferenca < melhor.diferenca ? { jogador, diferenca } : melhor;
            }, { jogador: this.rodada.gameOrder[0], diferenca: Math.abs(this.rodada.gameOrder[0].aposta - this.rodada.gameOrder[0].steak) });
            this.emit('jogoFinalizado', { vencedor: vencedor.jogador.nome });
            return;
        }

        const eliminados = this.game.eliminarZerados();
        if (eliminados.length > 0) {
            this.emit('jogadoresEliminados', { eliminados: eliminados.map(j => ({ nome: j.nome, hp: j.hp })) });
        }
        this.rodada.resetarApostasSteaks();
        this.game.girarOrdem();

        this.numeroRodada++;
        this.rodada = this.game.proximaRodada();
        this.emit('novaRodadaIniciada', { numero: this.numeroRodada, cartas: this.rodada.round });

        await this._jogarRodadaAtual();
    }
}

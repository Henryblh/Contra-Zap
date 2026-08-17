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
    }

    // Sala de espera: transforma o Player que entrou num PlayerGame e guarda
    // na lista até a partida começar. Ordem de chegada é a própria posição
    // no array — nenhum campo à parte guarda isso.
    entrarNaSala(player) {
        this.jogadores.push(new PlayerGame(player));
        this.emit('jogadorEntrou', { id: player.id, nome: player.nome });
        return this;
    }

    iniciarPartida() {
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

        this._jogarRodadaAtual();
        return this;
    }

    _jogarRodadaAtual() {
        const rodada = this.rodada;

        rodada.darCartas();
        this.emit('cartasDistribuidas', rodada.gameOrder.map(j => ({
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
                this.emit('turnoJogador', { jogador: jogador.nome });

                const carta = jogador.mao.pop();
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

        this._avancarOuFinalizar();
    }

    _avancarOuFinalizar() {
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
            this.emit('jogadoresEliminados', eliminados.map(j => ({ nome: j.nome, hp: j.hp })));
        }
        this.rodada.resetarApostasSteaks();
        this.game.girarOrdem();

        this.numeroRodada++;
        this.rodada = this.game.proximaRodada();
        this.emit('novaRodadaIniciada', { numero: this.numeroRodada, cartas: this.rodada.round });

        this._jogarRodadaAtual();
    }
}

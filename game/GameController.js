// GameController.js
// Orquestra uma partida inteira (Looby -> Game -> RodadaGame -> Mesa) e expõe
// o andamento do jogo como eventos, em vez de console.log espalhado.
//
// Isso serve dois consumidores ao mesmo tempo, sem duplicar a lógica de regras:
//  - Main.js: assina os eventos e imprime no console (harness de teste local)
//  - Server.js (futuro): assina os eventos e faz io.emit(...) para os clientes via socket.io
import { EventEmitter } from 'node:events';
import { Looby } from './Looby.js';

export class GameController extends EventEmitter {
    constructor({ numberPlayers, roundStart, randomShuffle } = {}) {
        super();
        this.looby = new Looby(numberPlayers, roundStart, randomShuffle);
        this.game = null;
        this.rodada = null;
        this.numeroRodada = 0;
    }

    entrarNaSala(player) {
        this.looby.addJogador(player);
        this.emit('jogadorEntrou', { id: player.id, nome: player.nome });
        return this;
    }

    iniciarPartida() {
        this.game = this.looby.startgame();
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
        if (vivos.length <= 1) {
            this.emit('jogoFinalizado', { vencedor: vivos[0]?.nome ?? null });
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

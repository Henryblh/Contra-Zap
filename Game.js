import { Player } from './Player.js';
import { PlayerGame } from './PlayerGame.js';
import { Carta } from './Carta.js';
import { Baralho } from './Baralho.js';
import { RodadaGame } from './Rodada.js';
// 1. Apagamos o import do Looby! Quebramos o ciclo aqui.

// 2. Removemos o "extends Looby"
export class Game {
    constructor(settings) {
        // 3. Removemos o super()

        // Agora apenas copiamos os valores do Lobby (que chegaram pela variável settings)
        this.numberPlayers = settings.numberPlayers;
        this.roundStart = settings.roundStart;
        this.randomShuffle = settings.randomShuffle;
        this.jogadores = settings.jogadores;

        this.round = settings.roundStart;
        this.gameOrder = [];

        // Ordem original (fixa) e índice de quem inicia a rodada atual dentro dela.
        // gameOrder é recalculado a cada rodada a partir dessa base, sem nunca sobrescrevê-la.
        this.ordemOriginal = [];
        this.starterIndex = 0;
    }


    setstartsequence() {
        let starterPlayer= Math.floor(Math.random() * this.numberPlayers);
        for (let i = 0; i < this.jogadores.length; i++) {
            const index = (starterPlayer + i) % this.jogadores.length;
            this.gameOrder.push(this.jogadores[index]);
            this.jogadores[index].gameId = index;
        }

        this.ordemOriginal = [...this.gameOrder];
        this.starterIndex = 0;
    }

    // Remove da rotação quem chegou a 0 (ou menos) de hp
    eliminarZerados() {
        const eliminados = this.gameOrder.filter(jogador => jogador.hp <= 0);
        eliminados.forEach(jogador => console.log(`💀 ${jogador.nome} foi eliminado (hp ${jogador.hp})`));

        this.gameOrder = this.gameOrder.filter(jogador => jogador.hp > 0);
        return eliminados;
    }

    // Gira quem começa: sempre um a mais que o início da ordem original,
    // pulando quem já foi eliminado
    girarOrdem() {
        const n = this.ordemOriginal.length;
        this.starterIndex = (this.starterIndex + 1) % n;

        const novaOrdem = [];
        for (let i = 0; i < n; i++) {
            const jogador = this.ordemOriginal[(this.starterIndex + i) % n];
            if (jogador.hp > 0) novaOrdem.push(jogador);
        }
        this.gameOrder = novaOrdem;
    }

    // Fecha a rodada atual e prepara a próxima: mais uma carta por jogador
    proximaRodada() {
        this.round += 1;
        return this.newRodada();
    }

    newRodada(){
        var rodada = new RodadaGame(this);
        return rodada;
    }
}
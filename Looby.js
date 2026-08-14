import { Player } from './Player.js';
import { PlayerGame } from './PlayerGame.js';
import { Carta } from './Carta.js';
import { Baralho } from './Baralho.js';
import {Game} from "./Game.js";

export class Looby {
    constructor(numPla, rostar, ramshu) {
        this.numberPlayers = numPla || 4;
        this.roundStart = rostar || 3;
        this.randomShuffle = ramshu;
        this.jogadores = [];
    }

    checkOrder() {
        this.jogadores = this.jogadores.filter(item => item != null);
        for (let i = 0; i < this.jogadores.length; i++) {
            this.jogadores[i].gameId = i;
        }
    }

    addJogador(valor) {
        this.checkOrder();

        // Garante que não vai quebrar se a sala estiver vazia
        let proximaPosicao = 0;
        if (this.jogadores.length > 0) {
            proximaPosicao = this.jogadores[this.jogadores.length - 1].gameId + 1;
        }

        const insert = new PlayerGame(valor, proximaPosicao);
        this.jogadores.push(insert);
    }

    startgame(){
        var jogo = new Game(this);
        return jogo;
    }

    get numberPlayers() { return this._numberPlayers; }
    get roundStart() { return this._roundStart; }
    get jogadores() { return this._jogadores; }

    set numberPlayers(valor) { this._numberPlayers = valor; }
    set roundStart(valor) { this._roundStart = valor;}
    set jogadores(valor) { this._jogadores = valor; }


}

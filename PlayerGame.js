
import { Player } from './Player.js';

export class PlayerGame extends Player {
    constructor(playerBase, gameposition) {
        super(playerBase.nome, playerBase.senha, playerBase.rate);
        this.id = playerBase.id;

        // Use the setter here by assigning the value directly
        this.gameId = gameposition;

        this.hp = 3;
        this._steak = 0;
        this.mao = [];
        this.aposta = 0;
    }

    comprarCarta(carta) {
        this.mao.push(carta);
    }

    jogarCarta(carta) {
        return carta;
    }


    get gameId() {return this._gameposition;}

    set gameId(valor) {this._gameposition = valor;}

    get aposta() {return this._aposta;}

    set aposta(valor) {this._aposta = valor;}

    get hp() {return this._hp;}
    set hp(valor) {this._hp = valor;}

    get steak() {return this._steak;}
    set steak(valor) {this._steak = valor;}
}
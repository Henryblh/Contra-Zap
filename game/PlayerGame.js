
import { Player } from './Player.js';

export class PlayerGame extends Player {
    constructor(playerBase) {
        super(playerBase.nome, playerBase.senha, playerBase.rate);
        this.id = playerBase.id;

        this.hp = 3;
        this._steak = 0;
        this.mao = [];
        this.aposta = 0;
        this.adm = false;
    }

    comprarCarta(carta) {
        this.mao.push(carta);
    }

    jogarCarta(carta) {
        return carta;
    }


    get aposta() {return this._aposta;}

    set aposta(valor) {this._aposta = valor;}

    get hp() {return this._hp;}
    set hp(valor) {this._hp = valor;}

    get steak() {return this._steak;}
    set steak(valor) {this._steak = valor;}

    // Uso futuro: dono/moderador da sala (kick, forçar início, trocar
    // configuração antes da partida começar). Ninguém seta isso ainda.
    get adm() {return this._adm;}
    set adm(valor) {this._adm = valor;}
}
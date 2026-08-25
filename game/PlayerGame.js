
import { Player } from './Player.js';

export class PlayerGame extends Player {
    constructor(playerBase) {
        super(playerBase.nome, playerBase.senha, playerBase.rate);
        this.id = playerBase.id;
        this.bot = playerBase.bot;

        this.hp = 3;
        this._steak = 0;
        this.mao = [];
        this.aposta = 0;
        this.adm = false;
        this.desconectado = false;
        this.ultimaAcaoEm = Date.now();
        this.expulsoPorInatividade = false;
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

    // true quando a vez dessa pessoa estourou o tempo e o GameController
    // jogou por ela (ver tempoTurnoMs) — sinal de que essa cadeira está no
    // automático até ela reconectar ou jogar de verdade de novo.
    get desconectado() {return this._desconectado;}
    set desconectado(valor) {this._desconectado = valor;}

    // Timestamp (Date.now()) da última ação real dessa pessoa (jogar carta,
    // apostar ou reconectar) — GameController usa isso pra medir inatividade
    // de verdade (tempo, não turnos), já que entre os turnos dela o relógio
    // de tempoTurnoMs não anda.
    get ultimaAcaoEm() {return this._ultimaAcaoEm;}
    set ultimaAcaoEm(valor) {this._ultimaAcaoEm = valor;}

    // true depois que a inatividade dela passou de limiteInatividadeMs e o
    // GameController já expulsou o socket da sala (ver
    // jogadorExpulsoPorInatividade) — evita reemitir esse evento a cada novo
    // timeout enquanto ela continuar sumida. Desliga só numa ação real.
    get expulsoPorInatividade() {return this._expulsoPorInatividade;}
    set expulsoPorInatividade(valor) {this._expulsoPorInatividade = valor;}
}
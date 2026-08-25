export class Carta {
    constructor(id, naipeInt, valorInt, nomeNaipe, nomeValor, numeroBaralho) {
        this.id = id;               // Ex: 0, 1, 2...
        this.naipeInt = naipeInt;   // Ex: 0 (Ouros)
        this.valorInt = valorInt;   // Ex: 0 (Valor 4)

        // Guardamos as strings originais apenas para renderizar na tela depois
        this.nomeNaipe = nomeNaipe; // Ex: 'Ouros'
        this.nomeValor = nomeValor; // Ex: '4'

        // De qual baralho físico essa carta veio (1, 2, 3...) — jogos longos
        // (muitos jogadores/rodadas) juntam mais de um baralho de 40 cartas
        // no monte (ver Baralho.js), então duas cartas com o mesmo naipe/valor
        // podem coexistir. O front vai usar isso pra desenhar um verso de
        // carta diferente por baralho.
        this.numeroBaralho = numeroBaralho;
    }


    toString() {
        return `[${this.nomeValor} de ${this.nomeNaipe}]`;
    }

    get id() { return this._id; }
    get naipeInt() { return this._naipeInt; } // Faltava o return!
    get valorInt() { return this._valorInt; } // Faltava o return!
    get nomeNaipe() { return this._nomeNaipe; } // Faltava o return!
    get nomeValor() { return this._nomeValor; } // Faltava o return!
    get numeroBaralho() { return this._numeroBaralho; }

    set id(valor) {this._id = valor;}
    set naipeInt(valor) {this._naipeInt = valor;}
    set valorInt(valor) {this._valorInt = valor;}
    set nomeNaipe(valor) {this._nomeNaipe = valor;}
    set nomeValor(valor) {this._nomeValor = valor;}
    set numeroBaralho(valor) {this._numeroBaralho = valor;}
}
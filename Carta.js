export class Carta {
    constructor(id, naipeInt, valorInt, nomeNaipe, nomeValor) {
        this.id = id;               // Ex: 0, 1, 2...
        this.naipeInt = naipeInt;   // Ex: 0 (Ouros)
        this.valorInt = valorInt;   // Ex: 0 (Valor 4)

        // Guardamos as strings originais apenas para renderizar na tela depois
        this.nomeNaipe = nomeNaipe; // Ex: 'Ouros'
        this.nomeValor = nomeValor; // Ex: '4'
    }


    toString() {
        return `[${this.nomeValor} de ${this.nomeNaipe}]`;
    }

    get id() { return this._id; }
    get naipeInt() { return this._naipeInt; } // Faltava o return!
    get valorInt() { return this._valorInt; } // Faltava o return!
    get nomeNaipe() { return this._nomeNaipe; } // Faltava o return!
    get nomeValor() { return this._nomeValor; } // Faltava o return!

    set id(valor) {this._id = valor;}
    set naipeInt(valor) {this._naipeInt = valor;}
    set valorInt(valor) {this._valorInt = valor;}
    set nomeNaipe(valor) {this._nomeNaipe = valor;}
    set nomeValor(valor) {this._nomeValor = valor;}
}
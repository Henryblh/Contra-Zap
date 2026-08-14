// Player.js
export class Player {
    constructor(nome, senha) {
        this._id = -1; // Id padrão
        this._nome = nome;
        this._senha = senha;
        this._rate = 0;
    }

    // Getters
    get id() { return this._id; }
    get nome() { return this._nome; }
    get senha() { return this._senha; }
    get rate() { return this._rate; }

    // Setters
    set id(valor) { this._id = valor; }
    set nome(valor) { this._nome = valor; }
    set senha(valor) { this._senha = valor; }
    set rate(valor) { this._rate = valor; }
}
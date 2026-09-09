// Carta.js -- dado puro (sem conceito de conexão/conta), espelhado em
// training/python/motor/carta.py. Campos públicos direto: os getter/setter
// que existiam aqui só faziam `return this._x` / `this._x = valor`, sem
// nenhuma lógica -- puro boilerplate por cima de propriedade pública.
export class Carta {
    constructor(id, naipeInt, valorInt, nomeNaipe, nomeValor, numeroBaralho) {
        this.id = id;               // Ex: 0, 1, 2...
        this.naipeInt = naipeInt;   // Ex: 0 (Ouros)
        this.valorInt = valorInt;   // Ex: 0 (Valor 4)

        // Strings originais, só pra renderizar na tela depois.
        this.nomeNaipe = nomeNaipe; // Ex: 'Ouros'
        this.nomeValor = nomeValor; // Ex: '4'

        // De qual baralho físico essa carta veio (1, 2, 3...) — jogos longos
        // (muitos jogadores/rodadas) juntam mais de um baralho de 40 cartas
        // no monte (ver Baralho.js), então duas cartas com o mesmo naipe/valor
        // podem coexistir. O front usa isso pra desenhar um verso diferente
        // por baralho.
        this.numeroBaralho = numeroBaralho;
    }

    toString() {
        return `[${this.nomeValor} de ${this.nomeNaipe}]`;
    }
}

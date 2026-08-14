// Baralho.js
import { Carta } from './Carta.js';

export class Baralho {
    // Adicionamos numbaralho e a setting randomShuffle no construtor
    constructor(numbaralho, randomShuffle) {
        this.numbaralho = numbaralho;
        this.randomShuffle = randomShuffle;
        this.cartas = []; // O array principal de cartas

        this.montarBaralhos();
    }

    montarBaralhos() {
        let idGeral = 0; // Mantém IDs únicos mesmo em múltiplos baralhos

        for (let b = 0; b < this.numbaralho; b++) {
            // Constrói um baralho de 40 cartas
            let deckAtual = this.construirUmBaralho(idGeral);
            idGeral += 40; // Prepara o ID para o próximo baralho não repetir

            if (!this.randomShuffle) {
                // Se NÃO for shuffle global, embaralhamos esse deck sozinho
                this.embaralharArray(deckAtual);

                // Como o comprar() usa pop() (tira do fim do array),
                // os baralhos mais velhos precisam ficar no final.
                // Colocamos o deckAtual NA FRENTE do que já existe em this.cartas
                this.cartas = deckAtual.concat(this.cartas);
            } else {
                // Se for shuffle global, apenas adicionamos ao montante principal
                this.cartas = this.cartas.concat(deckAtual);
            }
        }

        // Se a opção de misturar tudo estiver ativa, embaralha o array inteiro no final
        if (this.randomShuffle) {
            this.embaralharArray(this.cartas);
        }
    }

    // Função separada que retorna um array de 40 cartas
    construirUmBaralho(idInicial) {
        const naipes = { 'Ouros': 0, 'Espadas': 1, 'Copas': 2, 'Paus': 3 };
        const valores = { '4': 0, '5': 1, '6': 2, '7': 3, 'Q': 4, 'J': 5, 'K': 6, 'A': 7, '2': 8, '3': 9 };

        let deck = [];
        let idCarta = idInicial;

        for (const [nomeNaipe, naipeInt] of Object.entries(naipes)) {
            for (const [nomeValor, valorInt] of Object.entries(valores)) {
                const novaCarta = new Carta(idCarta, naipeInt, valorInt, nomeNaipe, nomeValor);
                deck.push(novaCarta);
                idCarta++;
            }
        }
        return deck;
    }

    embaralharArray(array) {
        for (let i = array.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [array[i], array[j]] = [array[j], array[i]];
        }
    }

    comprar() {
        if (this.cartas.length === 0) {
            console.log("O baralho está vazio!");
            return null;
        }
        return this.cartas.pop();
    }
}
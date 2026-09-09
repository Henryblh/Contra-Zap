// Baralho.js
import { Carta } from './Carta.js';
import { embaralharComRng } from './rng.js';

export class Baralho {
    // numbaralho e a setting randomShuffle vêm do Game via Rodada. `rng` é a
    // fonte de aleatoriedade (ver rng.js): sem seed no Game é Math.random e
    // nada muda; com seed é o PRNG determinístico compartilhado, pra partida
    // reproduzível. Default Math.random pra quem construir Baralho solto.
    constructor(numbaralho, randomShuffle, rng = Math.random) {
        this.numbaralho = numbaralho;
        this.randomShuffle = randomShuffle;
        this.rng = rng;
        this.cartas = []; // O array principal de cartas

        this.montarBaralhos();
    }

    montarBaralhos() {
        let idGeral = 0; // Mantém IDs únicos mesmo em múltiplos baralhos

        for (let b = 0; b < this.numbaralho; b++) {
            // Constrói um baralho de 40 cartas — b+1 porque o baralho é
            // identificado como 1, 2, 3... pro jogador (ver Carta.numeroBaralho)
            let deckAtual = this.construirUmBaralho(idGeral, b + 1);
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

    // Função separada que retorna um array de 40 cartas.
    // naipes/valores são arrays de [nome, int] (não objeto) de propósito: num
    // objeto, JS reordena chaves que parecem inteiro ('4','5',...,'2','3') pra
    // ordem numérica crescente, então a ordem de construção do monte não seria
    // a escrita aqui — e o motor Python (dict, ordem de inserção) montaria
    // diferente. Como array, os dois montam na mesma ordem, então a mesma seed
    // reproduz a mesma partida nos dois (ver rng.js / training/python/motor/
    // baralho.py).
    construirUmBaralho(idInicial, numeroBaralho) {
        const naipes = [['Ouros', 0], ['Espadas', 1], ['Copas', 2], ['Paus', 3]];
        const valores = [['4', 0], ['5', 1], ['6', 2], ['7', 3], ['Q', 4], ['J', 5], ['K', 6], ['A', 7], ['2', 8], ['3', 9]];

        let deck = [];
        let idCarta = idInicial;

        for (const [nomeNaipe, naipeInt] of naipes) {
            for (const [nomeValor, valorInt] of valores) {
                const novaCarta = new Carta(idCarta, naipeInt, valorInt, nomeNaipe, nomeValor, numeroBaralho);
                deck.push(novaCarta);
                idCarta++;
            }
        }
        return deck;
    }

    embaralharArray(array) {
        embaralharComRng(array, this.rng);
    }

    // Baralho vazio NUNCA é situação normal: o monte é dimensionado exato pra
    // rodada (ver Rodada: numCards = jogadores*round + 1 pra vira,
    // numBaralho = ceil(numCards/40)). Se chegou aqui, o cálculo de
    // numCards/numBaralho quebrou (ou gameOrder/round foi corrompido) — é um
    // bug, não um caso a tratar. Lança pra parar a partida na hora, com
    // contexto, em vez de devolver null e explodir num TypeError adiante.
    comprar() {
        if (this.cartas.length === 0) {
            throw new Error(
                `Baralho vazio ao comprar carta (${this.numbaralho} baralho(s) = ` +
                `${this.numbaralho * 40} cartas montadas). Erro no cálculo de ` +
                `numCards/numBaralho em Rodada.`
            );
        }
        return this.cartas.pop();
    }
}
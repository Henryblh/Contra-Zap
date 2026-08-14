export class Mesa {
    constructor(viraValor) {
        this.viraValor = viraValor;
        this.cartasNaMesa = []; // Guarda { carta, jogador }
        this.melhorJogada = null; // A jogada válida que está ganhando
        this.estaEmpatado = false; // True se todas as cartas válidas se anularam
    }

    receberCarta(carta, jogador) {
        const novaJogada = { carta, jogador };
        this.cartasNaMesa.push(novaJogada);

        // Recalcula o estado da mesa considerando todas as cartas jogadas
        this.recalcularMesa();

        return this.gerarStatus();
    }

    recalcularMesa() {
        // 1. Identificar quais jogadas foram anuladas por repetição
        const jogadasValidas = this.cartasNaMesa.filter((jogadaAtual) => {
            const repeticoes = this.cartasNaMesa.filter((outraJogada) =>
                this.saoIdenticas(jogadaAtual.carta, outraJogada.carta)
            );
            // Se houver mais de uma carta com o mesmo valor, todas se anulam
            return repeticoes.length === 1;
        });

        // 2. Se nenhuma carta sobrou válida (todas se anularam)
        if (jogadasValidas.length === 0) {
            this.melhorJogada = null;
            this.estaEmpatado = true;
            return;
        }

        // 3. Encontrar a carta mais forte entre as que NÃO foram anuladas
        let melhor = jogadasValidas[0];

        for (let i = 1; i < jogadasValidas.length; i++) {
            const desafiante = jogadasValidas[i];
            if (this.compararForca(desafiante.carta, melhor.carta) > 0) {
                melhor = desafiante;
            }
        }

        this.melhorJogada = melhor;
        this.estaEmpatado = false;
    }

    // Retorna > 0 se c1 for mais forte que c2, < 0 se c2 for mais forte
    compararForca(c1, c2) {
        const c1EhManilha = c1.valorInt === this.viraValor;
        const c2EhManilha = c2.valorInt === this.viraValor;

        if (c1EhManilha && !c2EhManilha) return 1;
        if (!c1EhManilha && c2EhManilha) return -1;

        if (c1EhManilha && c2EhManilha) {
            return c1.naipeInt - c2.naipeInt;
        }

        // Cartas normais
        return c1.valorInt - c2.valorInt;
    }

    saoIdenticas(c1, c2) {
        if (c1.valorInt !== c2.valorInt) return false;

        // Se for manilha, só anula se o naipe também for idêntico (caso de 2 baralhos)
        if (c1.valorInt === this.viraValor) {
            return c1.naipeInt === c2.naipeInt;
        }

        // Cartas normais anulam apenas pelo valor de face (ex: 6 de Copas e 6 de Paus)
        return true;
    }

    gerarStatus() {
        return {
            vencedorAtual: this.estaEmpatado || !this.melhorJogada ? null : this.melhorJogada.jogador.nome,
            cartaGanhando: this.melhorJogada ? this.melhorJogada.carta.toString() : "Nenhuma (Anuladas)",
            status: this.estaEmpatado ? "MELADO" : "DEFINIDO"
        };
    }
}
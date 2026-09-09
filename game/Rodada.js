// Rodada.js
import { Baralho } from './Baralho.js';
import { Mesa } from './Mesa.js';

export class Rodada {
    constructor(gameSettings) {
        // Puxamos as configurações diretamente da instância do Game que foi passada
        this.gameOrder = gameSettings.gameOrder;
        this.round = gameSettings.round;
        this.randomShuffle = gameSettings.randomShuffle;

        // jogadores vivos * cartas por mao + 1 pra vira. numCards e o total
        // exato consumido na rodada (darCartas + virarManilha).
        this.numCards = (this.gameOrder.length * this.round) + 1;
        // ceil: menor nº de baralhos de 40 que cobre numCards. trunc(x/40 + 1)
        // (o que estava aqui) alocava um baralho a mais quando numCards era
        // multiplo exato de 40.
        this.numBaralho = Math.ceil(this.numCards / 40);

        // Fail-fast: o monte TEM que caber a rodada exata. Se não cabe, algo
        // fora daqui está quebrado (gameOrder/round corrompido, ou a conta
        // acima) — para na construção da Rodada, antes de distribuir a
        // primeira carta, com o quadro completo.
        if (this.numBaralho * 40 < this.numCards) {
            throw new Error(
                `Rodada impossível: ${this.gameOrder.length} jogador(es) x ${this.round} ` +
                `carta(s) + vira = ${this.numCards} cartas, mas só ${this.numBaralho * 40} ` +
                `disponíveis (${this.numBaralho} baralho(s)).`
            );
        }

        this.baralho = new Baralho(this.numBaralho, this.randomShuffle);

        this.vira = null;
        this.viraValor = -1;
        this.mesaAtiva = null;

        // Índice em gameOrder de quem inicia a vaza atual.
        // gameOrder nunca é reordenado; apenas o ponto de partida do loop muda.
        this.indiceInicial = 0;
    }

    darCartas() {
        // baralho.comprar() lança se o monte esvaziar (situação extraordinária,
        // ver Baralho.js) — não precisa checar null aqui.
        for (let j = 0 ; j < this.gameOrder.length; j++) {
            for (let i = 0 ; i < this.round; i++) {
                this.gameOrder[j].comprarCarta(this.baralho.comprar());
            }
        }
    }

    virarManilha() {
        // comprar() lança se não houver carta pra vira (ver Baralho.js) —
        // this.vira nunca é null aqui.
        this.vira = this.baralho.comprar();
        this.viraValor = (this.vira.valorInt === 9) ? 0 : this.vira.valorInt + 1;

        // A primeira vaza da rodada já pode começar com a manilha definida
        this.novaVaza();
    }

    // Cria uma mesa nova para a próxima vaza, reaproveitando o viraValor da rodada.
    // Deve ser chamado sempre que a mesa atual for concluída (todas as cartas jogadas).
    novaVaza() {
        this.mesaAtiva = new Mesa(this.viraValor);
    }

    // Retorna gameOrder reordenado a partir de quem deve iniciar a vaza atual.
    // gameOrder em si não é alterado.
    ordemDaVaza() {
        const n = this.gameOrder.length;
        const ordem = [];
        for (let i = 0; i < n; i++) {
            ordem.push(this.gameOrder[(this.indiceInicial + i) % n]);
        }
        return ordem;
    }

    registrarJogada(jogador, carta) {
        // A mesa processa a carta e já retorna o status atualizado
        return this.mesaAtiva.receberCarta(carta, jogador);
    }

    // Fecha a vaza atual: soma o steak do vencedor e define quem começa a próxima vaza.
    // Se a vaza ficou MELADO (todas as cartas se anularam), não há vencedor:
    // ninguém pontua e quem começa a próxima vaza continua o mesmo.
    finalizarVaza() {
        const vencedor = this.mesaAtiva.melhorJogada?.jogador ?? null;
        if (vencedor) {
            vencedor.steak += 1;
            this.indiceInicial = this.gameOrder.indexOf(vencedor);
        }
        return vencedor;
    }

    // Fecha a rodada: cada jogador perde hp igual à diferença absoluta entre aposta e steak
    finalizarRodada() {
        for (const jogador of this.gameOrder) {
            const diferenca = Math.abs(jogador.aposta - jogador.steak);
            jogador.hp -= diferenca;
        }
    }

    // Zera aposta e steak de todos, preparando os jogadores para a próxima rodada
    resetarApostasSteaks() {
        for (const jogador of this.gameOrder) {
            jogador.aposta = 0;
            jogador.steak = 0;
        }
    }

}




// Rodada.js (ou RodadaGame.js)
import { Carta } from './Carta.js';
import { Baralho } from './Baralho.js';
// Removemos a importação do Game para quebrar a dependência circular!
// import { Game } from "./Game.js";

import { Mesa } from './Mesa.js';

// Removemos o "extends Game"
export class RodadaGame {
    constructor(gameSettings) {
        // Removemos o super() porque não tem mais herança

        // Puxamos as configurações diretamente da instância do Game que foi passada
        this.gameOrder = gameSettings.gameOrder;
        this.round = gameSettings.round;
        this.randomShuffle = gameSettings.randomShuffle;

        this.numCards = (this.gameOrder.length * this.round) + 1;
        this.numBaralho = Math.trunc((this.numCards / 40) + 1);
        this.baralho = new Baralho(this.numBaralho, this.randomShuffle);

        this.vira = null;
        this.viraValor = -1;
        this.mesaAtiva = null;

        // Índice em gameOrder de quem inicia a vaza atual.
        // gameOrder nunca é reordenado; apenas o ponto de partida do loop muda.
        this.indiceInicial = 0;
    }

    darCartas() {
        for (let j = 0 ; j < this.gameOrder.length; j++) {
            for (let i = 0 ; i < this.round; i++) {
                let carta = this.baralho.comprar();
                if (carta) {
                    this.gameOrder[j].comprarCarta(carta);
                }
            }
        }

        // Console log correto para imprimir a mão de todos no final
        for (let i = 0; i < this.gameOrder.length; i++) {
            console.log(`Mão do jogador ${this.gameOrder[i].nome}:`, this.gameOrder[i].mao);
        }
    }

    virarManilha() {
        this.vira = this.baralho.comprar();
        this.viraValor = (this.vira.valorInt === 9) ? 0 : this.vira.valorInt + 1;

        console.log(`\n🃏 Vira: ${this.vira.toString()} | Manilha: ${this.viraValor}`);

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
        console.log(`\n> ${jogador.nome} jogou ${carta.toString()}`);

        // A mesa processa a carta e já retorna o status atualizado
        const statusDaMesa = this.mesaAtiva.receberCarta(carta, jogador);

        console.log(`Status: ${statusDaMesa.status} | Ganhando: ${statusDaMesa.cartaGanhando}`);
        return statusDaMesa;
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
            console.log(`${jogador.nome}: apostou ${jogador.aposta}, fez ${jogador.steak} -> perdeu ${diferenca} hp (hp atual: ${jogador.hp})`);
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




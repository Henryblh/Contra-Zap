import { Player } from './Player.js';
import { PlayerGame } from './PlayerGame.js';
import { Carta } from './Carta.js';
import { Baralho } from './Baralho.js';
import { Looby } from './Looby.js';
import {Game} from "./Game.js";

var player0 = new Player("henrique", 123);
player0.id = 0
var player1 = new Player("piconi", 123);
player1.id = 1
var player2 = new Player("moras", 123);
player2.id = 2
var player3 = new Player("guilherme", 123);
player3.id = 3

var sala = new Looby(4,3);
sala.addJogador(player0);
sala.addJogador(player1);
sala.addJogador(player2);
sala.addJogador(player3);


var game = sala.startgame();

game.setstartsequence();

// Joga uma rodada inteira (dar cartas -> virar manilha -> apostas -> vazas -> fechamento)
function jogarRodada(rodada) {
    rodada.darCartas();
    rodada.virarManilha();

    for (let i = 0; i < rodada.gameOrder.length; i++) {
        console.log(`jogador ${rodada.gameOrder[i].nome}: Apostou 1 rodada`);
        rodada.gameOrder[i].aposta = 1;
    }

    for (let v = 0; v < rodada.round; v++) {
        if (v > 0) {
            rodada.novaVaza(); // nova mesa, mesma manilha da rodada
        }

        const ordem = rodada.ordemDaVaza(); // começa pelo vencedor da vaza anterior

        for (let i = 0; i < ordem.length; i++) {
            console.log(`jogador ${ordem[i].nome}: Selecione uma carta`);
            rodada.registrarJogada(ordem[i], ordem[i].mao.pop());
        }

        const vencedor = rodada.finalizarVaza();
        if (vencedor) {
            console.log(`vencedor da vaza: ${vencedor.nome}, com o: ${rodada.mesaAtiva.melhorJogada.carta}`);
        } else {
            console.log(`vaza melada, ninguém pontuou`);
        }
    }

    rodada.finalizarRodada();

    for (let i = 0; i < rodada.gameOrder.length; i++) {
        console.log(`jogador ${rodada.gameOrder[i].nome} tem ${rodada.gameOrder[i].steak} vazas e ${rodada.gameOrder[i].hp} hp`);
    }
}

var rodada = game.newRodada();
jogarRodada(rodada);

// A partir daqui: fecha a rodada, elimina quem zerou, reinicia apostas/steaks
// e começa a próxima rodada com mais uma carta, girando quem começa
let numeroRodada = 1;
while (game.gameOrder.filter(j => j.hp > 0).length > 1) {
    console.log(`\n===== Fim da rodada ${numeroRodada} =====`);

    game.eliminarZerados();
    rodada.resetarApostasSteaks();
    game.girarOrdem();

    numeroRodada++;
    console.log(`\n===== Início da rodada ${numeroRodada} (${game.round + 1} cartas) =====`);

    rodada = game.proximaRodada();
    jogarRodada(rodada);
}

console.log(`\n🏆 Vencedor: ${game.gameOrder.find(j => j.hp > 0)?.nome}`);




// Main.js
// Harness de teste local: cria jogadores, assina os eventos do GameController
// e imprime o andamento da partida no console. A lógica de regras vive inteira
// no GameController/Game/RodadaGame/Mesa — este arquivo só observa e exibe.
import { Player } from './game/Player.js';
import { GameController } from './game/GameController.js';

const jogadoresBase = [
    new Player("henrique", 123),
    new Player("piconi", 123),
    new Player("moras", 123),
    new Player("guilherme", 123),
];
jogadoresBase.forEach((jogador, i) => { jogador.id = i; });

const controller = new GameController({ numberPlayers: 4, roundStart: 3 });

controller.on('novaRodadaIniciada', ({ numero, cartas }) => {
    console.log(`\n===== Início da rodada ${numero} (${cartas} cartas) =====`);
});

controller.on('cartasDistribuidas', (maos) => {
    for (const { nome, mao } of maos) {
        console.log(`Mão do jogador ${nome}:`, mao);
    }
});

controller.on('manilhaVirada', ({ vira, viraValor }) => {
    console.log(`\n🃏 Vira: ${vira} | Manilha: ${viraValor}`);
});

controller.on('apostaFeita', ({ jogador, aposta }) => {
    console.log(`jogador ${jogador}: Apostou ${aposta} rodada`);
});

controller.on('turnoJogador', ({ jogador }) => {
    console.log(`jogador ${jogador}: Selecione uma carta`);
});

controller.on('cartaJogada', ({ jogador, carta, status }) => {
    console.log(`\n> ${jogador} jogou ${carta}`);
    console.log(`Status: ${status.status} | Ganhando: ${status.cartaGanhando}`);
});

controller.on('vazaFinalizada', ({ vencedor, carta }) => {
    if (vencedor) {
        console.log(`vencedor da vaza: ${vencedor}, com o: ${carta}`);
    } else {
        console.log(`vaza melada, ninguém pontuou`);
    }
});

controller.on('rodadaFinalizada', ({ numero, resultado }) => {
    for (const { nome, aposta, steak, diferenca, hp } of resultado) {
        console.log(`${nome}: apostou ${aposta}, fez ${steak} -> perdeu ${diferenca} hp (hp atual: ${hp})`);
    }
    console.log(`\n===== Fim da rodada ${numero} =====`);
});

controller.on('jogadoresEliminados', ({ eliminados }) => {
    for (const { nome, hp } of eliminados) {
        console.log(`💀 ${nome} foi eliminado (hp ${hp})`);
    }
});

controller.on('jogoFinalizado', ({ vencedor }) => {
    console.log(`\n🏆 Vencedor: ${vencedor}`);
});

jogadoresBase.forEach(jogador => controller.entrarNaSala(jogador));
controller.iniciarPartida();

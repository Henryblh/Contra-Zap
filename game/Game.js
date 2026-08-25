import { RodadaGame } from './Rodada.js';

export class Game {
    constructor(settings) {
        // Apenas copiamos os valores do Lobby (que chegaram pela variável settings)
        this.numberPlayers = settings.numberPlayers;
        this.roundStart = settings.roundStart;
        this.randomShuffle = settings.randomShuffle;
        this.jogadores = settings.jogadores;

        this.round = settings.roundStart;
        this.gameOrder = [];

        // Ordem original (fixa) e índice de quem inicia a rodada atual dentro dela.
        // gameOrder é recalculado a cada rodada a partir dessa base, sem nunca sobrescrevê-la.
        this.ordemOriginal = [];
        this.starterIndex = 0;
    }


    // Embaralha de verdade quem senta ao lado de quem — girar a partir de
    // um índice aleatório (como era antes) só sorteava quem começa, mas a
    // vizinhança continuava sendo a ordem de entrada na sala (rotação não
    // muda adjacência num ciclo). Fisher-Yates aqui garante que a ordem de
    // turno não tem nenhuma relação com a ordem que os jogadores entraram.
    setstartsequence() {
        this.gameOrder = [...this.jogadores];
        for (let i = this.gameOrder.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [this.gameOrder[i], this.gameOrder[j]] = [this.gameOrder[j], this.gameOrder[i]];
        }

        this.ordemOriginal = [...this.gameOrder];
        this.starterIndex = 0;
    }

    // Quem chegou a 0 (ou menos) de hp. Não mexe em gameOrder — quem
    // recalcula gameOrder de verdade é girarOrdem(), chamado logo em
    // seguida em GameController; reatribuir aqui também seria trabalho
    // jogado fora.
    eliminarZerados() {
        return this.gameOrder.filter(jogador => jogador.hp <= 0);
    }

    // Gira quem começa: sempre um a mais que o início da ordem original,
    // pulando quem já foi eliminado
    girarOrdem() {
        const n = this.ordemOriginal.length;
        this.starterIndex = (this.starterIndex + 1) % n;

        const novaOrdem = [];
        for (let i = 0; i < n; i++) {
            const jogador = this.ordemOriginal[(this.starterIndex + i) % n];
            if (jogador.hp > 0) novaOrdem.push(jogador);
        }
        this.gameOrder = novaOrdem;
    }

    // Fecha a rodada atual e prepara a próxima: mais uma carta por jogador
    proximaRodada() {
        this.round += 1;
        return this.newRodada();
    }

    newRodada(){
        var rodada = new RodadaGame(this);
        return rodada;
    }
}
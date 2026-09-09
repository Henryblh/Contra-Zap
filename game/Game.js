import { Rodada } from './Rodada.js';

// Teto de baralhos tratado como "Sem Limite": 50 baralhos = 2000 cartas, mais
// do que qualquer partida real alcança (a mão cresce +1 por rodada e alguém
// morre muito antes disso). Usado como default quando maxDeck não vem na
// config — assim o caminho "sem limite" é só um número grande, sem caso
// especial de Infinity/null pra serializar por socket.
export const MAX_DECK_SEM_LIMITE = 50;

export class Game {
    constructor(settings) {
        // Apenas copiamos os valores do Lobby (que chegaram pela variável settings)
        this.numberPlayers = settings.numberPlayers;
        this.roundStart = settings.roundStart;
        this.randomShuffle = settings.randomShuffle;
        this.jogadores = settings.jogadores;
        // Máximo de baralhos de 40 cartas que a partida pode montar numa
        // rodada. Enquanto a próxima rodada (mão maior) não couber nesse
        // teto, `round` não cresce — ver proximaRodada().
        this.maxDeck = settings.maxDeck ?? MAX_DECK_SEM_LIMITE;

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

    // Gira quem começa: o próximo jogador VIVO depois de quem abriu a rodada
    // anterior, na ordem original.
    //
    // ordemOriginal nunca encolhe (os mortos seguem ocupando slot). Se o
    // avanço fosse só (starterIndex + 1) % n, quando esse slot caísse num
    // jogador morto o próximo vivo virava o abridor — e na rodada seguinte o
    // +1 caía em cima dele de novo, fazendo o mesmo jogador abrir duas
    // rodadas seguidas. Por isso: anda pelo menos 1 e continua pulando slots
    // de mortos até parar num vivo (limitado a n passos, nunca trava; o caso
    // "só sobrou 1 vivo" nem chega aqui — GameController encerra antes).
    girarOrdem() {
        const n = this.ordemOriginal.length;

        for (let passos = 0; passos < n; passos++) {
            this.starterIndex = (this.starterIndex + 1) % n;
            if (this.ordemOriginal[this.starterIndex].hp > 0) break;
        }

        const novaOrdem = [];
        for (let i = 0; i < n; i++) {
            const jogador = this.ordemOriginal[(this.starterIndex + i) % n];
            if (jogador.hp > 0) novaOrdem.push(jogador);
        }
        this.gameOrder = novaOrdem;
    }

    // Quantos baralhos de 40 cartas uma rodada com `numJogadores` vivos e mão
    // de `round` cartas precisaria montar. numCards = jogadores*round + 1 (o
    // +1 é a vira), ver Rodada.
    static baralhosNecessarios(numJogadores, round) {
        return Math.ceil((numJogadores * round + 1) / 40);
    }

    // Fecha a rodada atual e prepara a próxima. A mão normalmente cresce +1
    // carta por rodada — mas só se a próxima rodada ainda couber em maxDeck
    // baralhos. Se não couber, `round` fica congelado no valor atual (a mão
    // não cresce) até alguém morrer: menos jogadores = menos cartas na mesa =
    // volta a caber, e aí o +1 é retomado. Nunca diminui, nunca "pula" pra
    // recuperar rodadas em que ficou parado.
    proximaRodada() {
        const vivos = this.gameOrder.length; // já filtrado por girarOrdem()
        if (Game.baralhosNecessarios(vivos, this.round + 1) <= this.maxDeck) {
            this.round += 1;
        }
        return this.newRodada();
    }

    newRodada(){
        var rodada = new Rodada(this);
        return rodada;
    }
}
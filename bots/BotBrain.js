// BotBrain.js
// Cérebro dos bots — hoje é só um placeholder burro (sempre a última carta
// da mão, sempre aposta 1 quando a regra deixa), mas é o ÚNICO lugar do
// projeto que decide uma jogada automática: tanto o turno normal de um Bot
// de verdade quanto o timeout de um jogador real desconectado passam por
// aqui (ver PlayerGame.bot e game/GameController.js) — antes cada um tinha
// sua própria lógica duplicada. Trocar a estratégia (ou plugar um modelo de
// ML treinado, a ideia lá na frente) é só reimplementar as duas funções
// abaixo; GameController não sabe nem precisa saber como a decisão foi
// tomada.

// `jogador` é o PlayerGame de quem vai jogar; devolve o índice (0-based) da
// carta escolhida na mão dele.
export function escolherCarta(jogador) {
    return jogador.mao.length - 1;
}

// `permiteAposta1` vem de quem chama (só o GameController sabe as apostas
// já feitas pelos outros jogadores da rodada): vem `false` quando apostar 1
// fecharia a soma da rodada exatamente no número de cartas — a regra do
// jogo proíbe isso pro último a apostar (ver GameController.apostar). O bot
// só precisa saber o que evitar, não como essa restrição é calculada.
export function escolherAposta(jogador, { permiteAposta1 }) {
    return permiteAposta1 ? 1 : 0;
}

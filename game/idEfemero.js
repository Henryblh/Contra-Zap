// idEfemero.js
// Fonte única de ids negativos pra Player que não vem de uma linha do banco
// — hoje usada por bots/Bot.js e conexao/convidado.js. Precisa ser uma
// fonte ÚNICA: os dois já tiveram contadores independentes, cada um
// começando em -1, e o primeiro bot e o primeiro convidado do processo
// nasciam com o mesmo id. Numa sala com os dois, o GameController resolve
// jogador por id (jogarCarta, apostar, reconectar, jogadorEhAdm...) via
// `.find`/`.some` — a colisão podia fazer o servidor mutar a mão ou creditar
// a jogada de um jogador no outro. Negativo pra nunca colidir com os ids
// AUTOINCREMENT do SQLite (sempre positivos, começam em 1 — ver conexao/db.js).
let proximoId = -1;

export function proximoIdEfemero() {
    return proximoId--;
}

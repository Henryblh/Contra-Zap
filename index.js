// index.js — ponto de entrada público do módulo.
// Reexporta as peças do jogo para quem for consumir a lib (ex.: Server.js
// ao ligar o GameController nos sockets).
export { GameController } from './game/GameController.js';
export { Game } from './game/Game.js';
export { RodadaGame } from './game/Rodada.js';
export { Mesa } from './game/Mesa.js';
export { Baralho } from './game/Baralho.js';
export { Carta } from './game/Carta.js';
export { Player } from './game/Player.js';
export { PlayerGame } from './game/PlayerGame.js';

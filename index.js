// index.js — ponto de entrada público do módulo.
// Reexporta as peças do jogo para quem for consumir a lib (ex.: Server.js
// ao ligar o GameController nos sockets).
export { GameController } from './GameController.js';
export { Looby } from './Looby.js';
export { Game } from './Game.js';
export { RodadaGame } from './Rodada.js';
export { Mesa } from './Mesa.js';
export { Baralho } from './Baralho.js';
export { Carta } from './Carta.js';
export { Player } from './Player.js';
export { PlayerGame } from './PlayerGame.js';

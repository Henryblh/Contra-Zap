// Exemplo de uso:
import { Player } from './Player.js';
import { PlayerGame } from './PlayerGame.js';

// 1. O jogador faz login
const perfilHenrique = new Player("Henrique", "senha123", 1500);
perfilHenrique.id = 42; // Simula que pegou do banco de dados

// 2. O jogador entra na partida
const jogadorNaPartida = new PlayerGame(perfilHenrique);

console.log(jogadorNaPartida.nome); // Saída: Henrique
console.log(jogadorNaPartida.pontuacao); // Saída: 0


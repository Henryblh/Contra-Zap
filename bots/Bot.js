// Bot.js
// Um "jogador" controlado pelo computador — mesma forma que Player (id,
// nome, senha, rate), então entra numa sala e vira PlayerGame exatamente
// como um jogador de verdade (GameController.entrarNaSala não sabe a
// diferença). A única diferença de verdade é o flag `bot` (herdado de
// Player, ver game/Player.js), que o GameController usa pra saber que esse
// assento nunca vai ter um socket respondendo — quem decide as jogadas dele
// é sempre bots/BotBrain.js, direto, sem esperar timeout nenhum. Um Bot
// nunca se conecta, nunca desconecta e nunca chama jogarCarta/apostar via
// protocolo (não existe socket associado pra isso).
import { Player } from '../game/Player.js';

// Id negativo e contador só deste módulo: garante que nunca colide com um
// id de conta de verdade (autoincrement positivo do banco, ver
// conexao/db.js), mesmo com vários bots em várias salas ao mesmo tempo.
let proximoNumero = 0;

export class Bot extends Player {
    constructor(nome) {
        proximoNumero += 1;
        super(nome ?? `Bot ${proximoNumero}`, null);
        this.id = -proximoNumero;
        this.bot = true;
    }
}

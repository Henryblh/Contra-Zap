// SalaManager.js
// Camada de sala: sabe criar salas, colocar jogadores nelas e validar as regras
// de entrada (lotação, duplicidade, partida já iniciada). Não sabe nada sobre
// socket.io — recebe e devolve objetos de domínio (Player, Sala), nada de
// socket/transporte aqui. Quem liga isso a sockets é uma camada futura, fora
// deste arquivo. Isso é o que permite testar tudo isto sem precisar de rede.
import { randomUUID } from 'node:crypto';
import { GameController } from '../game/GameController.js';
import { CodigosErro } from './eventos.js';

export class ErroSala extends Error {
    constructor(codigo, mensagem) {
        super(mensagem);
        this.name = 'ErroSala';
        this.codigo = codigo;
    }
}

// Uma sala = um GameController (que já guarda seus próprios jogadores/config
// de sala de espera). "iniciada" não é uma flag separada de propósito: é derivada de
// `controller.game`, pra não existir um segundo lugar de verdade que possa
// dessincronizar do estado real do controller.
class Sala {
    constructor(salaId, config) {
        this.salaId = salaId;
        this.controller = new GameController(config);
    }

    get numberPlayers() { return this.controller.numberPlayers; }
    get jogadores() { return this.controller.jogadores; }
    get iniciada() { return this.controller.game !== null; }
}

export class SalaManager {
    constructor() {
        this.salas = new Map();
    }

    // Cria uma sala nova e já coloca o jogador que criou dentro dela.
    criarSala(player, config = {}) {
        const salaId = this._gerarSalaId();
        const sala = new Sala(salaId, {
            numberPlayers: config.numberPlayers ?? 4,
            roundStart: config.roundStart ?? 3,
            randomShuffle: config.randomShuffle ?? true,
        });

        this.salas.set(salaId, sala);
        this._entrar(sala, player);
        return sala;
    }

    // Coloca um jogador numa sala existente, validando as regras de entrada.
    // Lança ErroSala (com um código de conexao/eventos.js) se alguma falhar.
    entrarSala(salaId, player) {
        const sala = this.salas.get(salaId);
        if (!sala) {
            throw new ErroSala(CodigosErro.SALA_NAO_ENCONTRADA, `Sala "${salaId}" não existe.`);
        }
        if (sala.iniciada) {
            throw new ErroSala(CodigosErro.SALA_JA_INICIADA, 'A partida desta sala já começou.');
        }
        if (sala.jogadores.length >= sala.numberPlayers) {
            throw new ErroSala(CodigosErro.SALA_CHEIA, 'Esta sala já está cheia.');
        }
        if (sala.jogadores.some(jogador => jogador.id === player.id)) {
            throw new ErroSala(CodigosErro.JA_ESTA_NA_SALA, 'Você já está nesta sala.');
        }
        if (sala.jogadores.some(jogador => jogador.nome === player.nome)) {
            throw new ErroSala(CodigosErro.NOME_INVALIDO, `O nome "${player.nome}" já está em uso nesta sala.`);
        }

        this._entrar(sala, player);
        return sala;
    }

    obterSala(salaId) {
        return this.salas.get(salaId) ?? null;
    }

    // Salas que ainda aceitam gente: não iniciadas e não cheias. Resumo
    // enxuto pra listagem (não expõe o controller nem os objetos Player).
    listarAbertas() {
        return [...this.salas.values()]
            .filter(sala => !sala.iniciada && sala.jogadores.length < sala.numberPlayers)
            .map(sala => ({
                salaId: sala.salaId,
                numberPlayers: sala.numberPlayers,
                jogadoresAtual: sala.jogadores.length,
            }));
    }

    _entrar(sala, player) {
        sala.controller.entrarNaSala(player);
    }

    _gerarSalaId() {
        let id;
        do {
            id = randomUUID().replace(/-/g, '').slice(0, 6).toUpperCase();
        } while (this.salas.has(id));
        return id;
    }
}

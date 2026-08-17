// socketServer.js
// Liga os eventos do protocolo (conexao/PROTOCOLO.md) a sockets de verdade.
// É a única peça de conexao/ que sabe o que é um socket.io — SalaManager e
// login não sabem nada sobre isso, o que é o que permite testá-los sozinhos.
import { login, ErroLogin } from './login.js';
import { SalaManager, ErroSala } from './SalaManager.js';
import { EventosCliente, EventosServidor, CodigosErro } from './eventos.js';

class ErroProtocolo extends Error {
    constructor(codigo, mensagem) {
        super(mensagem);
        this.name = 'ErroProtocolo';
        this.codigo = codigo;
    }
}

// Registra todos os handlers de conexão no `io` passado. `salaManager` pode
// ser injetado (testes) — por padrão cada chamada ganha o seu, isolado.
export function registrarSocketServer(io, salaManager = new SalaManager()) {
    // socket.id -> Player, só existe depois de um `entrar` bem-sucedido.
    // Vive só em memória, por conexão: some no disconnect (ver TODO(JWT) em login.js).
    const jogadorPorSocket = new Map();

    io.on('connection', (socket) => {
        const exigirJogador = () => {
            const player = jogadorPorSocket.get(socket.id);
            if (!player) {
                throw new ErroProtocolo(CodigosErro.NAO_IDENTIFICADO, 'Envie "entrar" antes de criar, entrar ou listar salas.');
            }
            return player;
        };

        socket.on(EventosCliente.ENTRAR, ({ nome, senha } = {}, ack) => {
            responder(ack, () => {
                const { token, player } = login(nome, senha);
                jogadorPorSocket.set(socket.id, player);
                // Sala pessoal do jogador — endereçável por id de conta (estável),
                // não por socket.id (muda a cada reconexão). É pra cá que vai
                // qualquer informação privada (ex.: SUA_MAO).
                socket.join(`jogador:${player.id}`);
                return { nome: player.nome, token };
            });
        });

        socket.on(EventosCliente.CRIAR_SALA, (config = {}, ack) => {
            responder(ack, () => {
                const player = exigirJogador();
                const sala = salaManager.criarSala(player, config);
                socket.join(sala.salaId);
                ligarControllerASala(io, sala);
                notificarSala(io, sala);
                return { salaId: sala.salaId, numberPlayers: sala.numberPlayers };
            });
        });

        socket.on(EventosCliente.ENTRAR_SALA, ({ salaId } = {}, ack) => {
            responder(ack, () => {
                const player = exigirJogador();
                const sala = salaManager.entrarSala(salaId, player);
                socket.join(sala.salaId);
                notificarSala(io, sala);
                return {
                    salaId: sala.salaId,
                    numberPlayers: sala.numberPlayers,
                    jogadores: resumoJogadores(sala),
                };
            });
        });

        socket.on(EventosCliente.LISTAR_SALAS, (_payload, ack) => {
            responder(ack, () => {
                exigirJogador();
                return { salas: salaManager.listarAbertas() };
            });
        });

        socket.on(EventosCliente.FORCAR_INICIO, ({ salaId } = {}, ack) => {
            responder(ack, () => {
                const player = exigirJogador();
                salaManager.forcarInicio(salaId, player);
                return {};
            });
        });

        socket.on('disconnect', () => {
            jogadorPorSocket.delete(socket.id);
        });
    });

    return salaManager;
}

function resumoJogadores(sala) {
    return sala.jogadores.map(jogador => ({ nome: jogador.nome }));
}

function notificarSala(io, sala) {
    io.to(sala.salaId).emit(EventosServidor.LISTA_JOGADORES, {
        salaId: sala.salaId,
        jogadores: resumoJogadores(sala),
    });
}

// Assina os eventos do GameController da sala e retransmite pros sockets.
// Chamado uma vez só, na criação da sala — o controller vive tanto quanto a
// sala, então essa assinatura vale pro resto da vida dela (espera + partida
// inteira). Todo evento é broadcast pra sala, exceto cartasDistribuidas, que
// é privado por natureza (a mão de cada jogador só pode ir pra ele).
function ligarControllerASala(io, sala) {
    const { salaId, controller } = sala;

    const retransmitir = (evento) => {
        controller.on(evento, (dados) => io.to(salaId).emit(evento, { salaId, ...dados }));
    };

    retransmitir(EventosServidor.PARTIDA_INICIANDO_EM);
    retransmitir(EventosServidor.NOVA_RODADA_INICIADA);
    retransmitir(EventosServidor.MANILHA_VIRADA);
    retransmitir(EventosServidor.APOSTA_FEITA);
    retransmitir(EventosServidor.TURNO_JOGADOR);
    retransmitir(EventosServidor.CARTA_JOGADA);
    retransmitir(EventosServidor.VAZA_FINALIZADA);
    retransmitir(EventosServidor.RODADA_FINALIZADA);
    retransmitir(EventosServidor.JOGADORES_ELIMINADOS);
    retransmitir(EventosServidor.JOGO_FINALIZADO);

    controller.on('cartasDistribuidas', (maos) => {
        for (const { id, mao } of maos) {
            io.to(`jogador:${id}`).emit(EventosServidor.SUA_MAO, { salaId, mao });
        }
    });
}

// Executa `acao` e devolve o resultado pro cliente via ack, sempre no
// formato { ok: true, ...resultado } ou { ok: false, codigo, mensagem }.
// Erros de domínio conhecidos (ErroLogin, ErroSala, ErroProtocolo) viram
// resposta de erro normal; qualquer outra exceção é logada no servidor e
// devolvida como ERRO_INTERNO — nunca deixa a exceção derrubar o socket.
function responder(ack, acao) {
    if (typeof ack !== 'function') return; // cliente não pediu resposta, nada a fazer
    try {
        const resultado = acao();
        ack({ ok: true, ...resultado });
    } catch (erro) {
        if (erro instanceof ErroLogin || erro instanceof ErroSala || erro instanceof ErroProtocolo) {
            ack({ ok: false, codigo: erro.codigo, mensagem: erro.message });
        } else {
            console.error('Erro inesperado num handler de socket:', erro);
            ack({ ok: false, codigo: CodigosErro.ERRO_INTERNO, mensagem: 'Erro interno do servidor.' });
        }
    }
}

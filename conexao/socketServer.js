// socketServer.js
// Liga os eventos do protocolo (conexao/PROTOCOLO.md) a sockets de verdade.
// É a única peça de conexao/ que sabe o que é um socket.io — SalaManager e
// login não sabem nada sobre isso, o que é o que permite testá-los sozinhos.
import { login, ErroLogin } from './login.js';
import { cadastrar, ErroCadastro } from './cadastro.js';
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
    // Vive só em memória, por conexão: some no disconnect.
    const jogadorPorSocket = new Map();
    // socket.id -> salaId, só existe enquanto o socket está numa sala de
    // espera. É o que permite o disconnect saber de qual sala tirar o
    // jogador, sem precisar varrer todas as salas procurando por ele.
    const salaPorSocket = new Map();
    // Player.id -> socket.id do socket autenticado mais recente dele.
    // Reconectar troca de socket.id a cada vez, então isto sempre aponta pro
    // atual — é o que permite achar o socket de alguém a partir do id de
    // jogador que o GameController emite (ex.: jogadorExpulsoPorInatividade),
    // sem varrer jogadorPorSocket inteiro.
    const socketPorJogador = new Map();

    io.on('connection', (socket) => {
        const exigirJogador = () => {
            const player = jogadorPorSocket.get(socket.id);
            if (!player) {
                throw new ErroProtocolo(CodigosErro.NAO_IDENTIFICADO, 'Envie "entrar" antes de criar, entrar ou listar salas.');
            }
            return player;
        };

        // Autentica o socket depois de login()/cadastrar() terem devolvido
        // { token, player } — os dois deixam a conexão pronta do mesmo
        // jeito, é só quem valida os dados que muda.
        const autenticarSocket = (player) => {
            jogadorPorSocket.set(socket.id, player);
            socketPorJogador.set(player.id, socket.id);
            // Sala pessoal do jogador — endereçável por id de conta (estável),
            // não por socket.id (muda a cada reconexão). É pra cá que vai
            // qualquer informação privada (ex.: SUA_MAO).
            socket.join(`jogador:${player.id}`);
        };

        socket.on(EventosCliente.ENTRAR, ({ nome, senha } = {}, ack) => {
            responder(ack, () => {
                const { token, player } = login(nome, senha);
                autenticarSocket(player);
                return { nome: player.nome, token };
            });
        });

        socket.on(EventosCliente.CADASTRAR, ({ nome, senha } = {}, ack) => {
            responder(ack, () => {
                const { token, player } = cadastrar(nome, senha);
                autenticarSocket(player);
                return { nome: player.nome, token };
            });
        });

        socket.on(EventosCliente.CRIAR_SALA, (config = {}, ack) => {
            responder(ack, () => {
                const player = exigirJogador();
                // O join na room e a retransmissão dos eventos do controller
                // vão num callback que roda ANTES dos bots entrarem: com um
                // botNumber que já lota a sala, o agendarInicio (e o
                // partidaIniciandoEm junto) dispara de dentro de criarSala —
                // se o socket ainda não estivesse na room e ligarControllerASala
                // ainda não tivesse assinado os eventos, esse primeiro
                // partidaIniciandoEm se perderia (mesmo motivo do roster vir
                // no próprio ack).
                const sala = salaManager.criarSala(player, config, (salaCriada) => {
                    socket.join(salaCriada.salaId);
                    salaPorSocket.set(socket.id, salaCriada.salaId);
                    ligarControllerASala(io, salaCriada, socketPorJogador, salaPorSocket);
                });
                notificarSala(io, sala);
                // jogadores vai no próprio ack (não só no broadcast de
                // listaJogadores): o broadcast sai daqui dentro do handler,
                // antes do ack — um cliente que só registra o listener
                // depois de processar o ack (ex.: monta a tela da sala só
                // então) perde esse primeiro broadcast pra sempre. Mesma
                // história pro partidaIniciandoEm quando botNumber já lota a
                // sala: o agendarInicio dispara dentro de criarSala, antes
                // do ack — então o "quantos segundos" também vem aqui.
                return {
                    salaId: sala.salaId,
                    numberPlayers: sala.numberPlayers,
                    jogadores: resumoJogadores(sala),
                    segundosParaIniciar: sala.controller.inicioAgendado ? sala.controller.segundosParaIniciar : null,
                };
            });
        });

        socket.on(EventosCliente.ENTRAR_SALA, ({ salaId } = {}, ack) => {
            responder(ack, () => {
                const player = exigirJogador();
                const sala = salaManager.entrarSala(salaId, player);
                socket.join(sala.salaId);
                salaPorSocket.set(socket.id, sala.salaId);
                notificarSala(io, sala);
                return {
                    salaId: sala.salaId,
                    numberPlayers: sala.numberPlayers,
                    jogadores: resumoJogadores(sala),
                    // Se ESTA entrada lotou a sala, o partidaIniciandoEm já
                    // saiu no broadcast (antes deste ack) — quem acabou de
                    // entrar só monta a tela agora e o perderia; por isso o
                    // "quantos segundos" também vem no ack.
                    segundosParaIniciar: sala.controller.inicioAgendado ? sala.controller.segundosParaIniciar : null,
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

        socket.on(EventosCliente.SAIR_SALA, ({ salaId } = {}, ack) => {
            responder(ack, () => {
                const player = exigirJogador();
                const sala = salaManager.sairSala(salaId, player);
                socket.leave(salaId);
                salaPorSocket.delete(socket.id);
                notificarSala(io, sala);
                return {};
            });
        });

        socket.on(EventosCliente.SAIR_DA_PARTIDA, ({ salaId } = {}, ack) => {
            responder(ack, () => {
                const player = exigirJogador();
                // Vira bot na hora (ver GameController.abandonarPartida). O
                // jogadorExpulsoPorInatividade que sai daí já é o que tira o
                // socket dele da room, pelo listener em ligarControllerASala —
                // nada a fazer aqui além de disparar.
                salaManager.abandonarPartida(salaId, player);
                return {};
            });
        });

        socket.on(EventosCliente.APOSTAR, ({ salaId, valor } = {}, ack) => {
            responder(ack, () => {
                const player = exigirJogador();
                salaManager.apostar(salaId, player, valor);
                return {};
            });
        });

        socket.on(EventosCliente.JOGAR_CARTA, ({ salaId, indice } = {}, ack) => {
            responder(ack, () => {
                const player = exigirJogador();
                salaManager.jogarCarta(salaId, player, indice);
                return {};
            });
        });

        socket.on(EventosCliente.RECONECTAR, ({ salaId } = {}, ack) => {
            responder(ack, () => {
                const player = exigirJogador();
                const { estado } = salaManager.reconectar(salaId, player);
                socket.join(salaId);
                salaPorSocket.set(socket.id, salaId);
                return { salaId, ...estado };
            });
        });

        socket.on(EventosCliente.MINHA_SALA_ATIVA, (_payload, ack) => {
            responder(ack, () => {
                const player = exigirJogador();
                return { salaId: salaManager.salaAtivaDoJogador(player.id) };
            });
        });

        socket.on('disconnect', () => {
            const player = jogadorPorSocket.get(socket.id);
            const salaId = salaPorSocket.get(socket.id);
            jogadorPorSocket.delete(socket.id);
            salaPorSocket.delete(socket.id);
            if (player && socketPorJogador.get(player.id) === socket.id) {
                socketPorJogador.delete(player.id);
            }

            // Best-effort: sem cliente do outro lado pra responder erro
            // nenhum. Se a sala já começou, se o jogador já tinha saído, ou
            // se a sala nem existe mais, não há nada a fazer — e é
            // exatamente por isso que não tocamos no estado de uma partida
            // em andamento aqui: só sairSala numa sala ainda em espera tem
            // efeito, então cair no meio do jogo não perde o assento
            // (pré-condição pra reconexão futura).
            if (player && salaId) {
                try {
                    notificarSala(io, salaManager.sairSala(salaId, player));
                } catch (erro) {
                    if (!(erro instanceof ErroSala)) {
                        console.error('Erro inesperado ao limpar sala no disconnect:', erro);
                    }
                }
            }
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
// inteira). Todo evento é broadcast pra sala, exceto cartasDistribuidas e
// maosReveladas, que são privados por natureza (cada jogador recebe só o que
// ele pode ver — a própria mão, ou a dos outros na rodada de 1 carta).
function ligarControllerASala(io, sala, socketPorJogador, salaPorSocket) {
    const { salaId, controller } = sala;

    const retransmitir = (evento) => {
        controller.on(evento, (dados) => io.to(salaId).emit(evento, { salaId, ...dados }));
    };

    retransmitir(EventosServidor.PARTIDA_INICIANDO_EM);
    retransmitir(EventosServidor.NOVA_RODADA_INICIADA);
    retransmitir(EventosServidor.MANILHA_VIRADA);
    retransmitir(EventosServidor.TURNO_APOSTA);
    retransmitir(EventosServidor.APOSTA_FEITA);
    retransmitir(EventosServidor.TURNO_JOGADOR);
    retransmitir(EventosServidor.CARTA_JOGADA);
    retransmitir(EventosServidor.VAZA_FINALIZADA);
    retransmitir(EventosServidor.RODADA_FINALIZADA);
    retransmitir(EventosServidor.JOGADORES_ELIMINADOS);
    retransmitir(EventosServidor.JOGO_FINALIZADO);
    retransmitir(EventosServidor.JOGADA_AUTOMATICA);
    retransmitir(EventosServidor.JOGADOR_RECONECTOU);
    retransmitir(EventosServidor.JOGADOR_EXPULSO_POR_INATIVIDADE);

    // Além do broadcast acima (que avisa a sala toda, inclusive o próprio
    // expulso — o cliente decide navegar pra tela de salas olhando o `id`),
    // o socket dele precisa sair de verdade da room do socket.io, senão
    // continuaria recebendo os eventos da partida numa tela que ele não está
    // mais olhando. A vaga na partida (controller.jogadores) não muda —
    // só a presença do socket na room — então "reconectar" continua
    // funcionando normalmente depois.
    controller.on(EventosServidor.JOGADOR_EXPULSO_POR_INATIVIDADE, ({ id }) => {
        const socketId = socketPorJogador.get(id);
        if (!socketId || salaPorSocket.get(socketId) !== salaId) return;
        io.sockets.sockets.get(socketId)?.leave(salaId);
        salaPorSocket.delete(socketId);
    });

    controller.on('cartasDistribuidas', (maos) => {
        for (const { id, mao } of maos) {
            io.to(`jogador:${id}`).emit(EventosServidor.SUA_MAO, { salaId, mao });
        }
    });

    // Privado como suaMao, mas o recorte muda por destinatário: cada jogador
    // recebe o conjunto de mãos que ele pode ver. Hoje só a rodada de 1 carta
    // usa isto, com `ocultarProprio` — cada um vê a mão dos outros, não a sua.
    // Bots têm id mas nenhuma room `jogador:<id>`, então o emit pra eles só
    // não chega a lugar nenhum.
    controller.on(EventosServidor.MAOS_REVELADAS, ({ maos, ocultarProprio }) => {
        for (const alvo of maos) {
            const visiveis = (ocultarProprio ? maos.filter(m => m.id !== alvo.id) : maos)
                .map(m => ({ jogador: m.nome, mao: m.mao }));
            io.to(`jogador:${alvo.id}`).emit(EventosServidor.MAOS_REVELADAS, { salaId, maos: visiveis });
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
        if (erro instanceof ErroLogin || erro instanceof ErroCadastro || erro instanceof ErroSala || erro instanceof ErroProtocolo) {
            ack({ ok: false, codigo: erro.codigo, mensagem: erro.message });
        } else {
            console.error('Erro inesperado num handler de socket:', erro);
            ack({ ok: false, codigo: CodigosErro.ERRO_INTERNO, mensagem: 'Erro interno do servidor.' });
        }
    }
}

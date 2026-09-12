// socketServer.js
// Liga os eventos do protocolo (conexao/PROTOCOLO.md) a sockets de verdade.
// É a única peça de conexao/ que sabe o que é um socket.io — SalaManager e
// login não sabem nada sobre isso, o que é o que permite testá-los sozinhos.
import { login, ErroLogin } from './login.js';
import { cadastrar, ErroCadastro } from './cadastro.js';
import { entrarComoConvidado, ErroConvidado } from './convidado.js';
import { retomarSessao, ErroSessao } from './retomarSessao.js';
import { usuarioExiste } from './db.js';
import { SalaManager, ErroSala } from './SalaManager.js';
import { ErroChat } from './chat/chat.js';
import { EventosCliente, EventosServidor, CodigosErro } from './eventos.js';
import { criarLimitadorDeTaxa } from './rateLimiter.js';
import { NOME_MAX } from './limites.js';

class ErroProtocolo extends Error {
    constructor(codigo, mensagem) {
        super(mensagem);
        this.name = 'ErroProtocolo';
        this.codigo = codigo;
    }
}

// Teto de tentativas de verificarNome por IP (ver conexao/rateLimiter.js) —
// esse evento roda pré-autenticação (não tem player.id pra chavear) e sem
// limite nenhum é oráculo de enumeração de contas (varre nomes e descobre
// quais existem). Generoso pra uso real: Login.jsx só chama isso uma vez por
// clique em "Continuar", nunca por tecla digitada — um humano de verdade não
// chega nem perto disso numa sessão inteira. Injetável (segundo parâmetro de
// registrarSocketServer) pelo mesmo motivo dos tempos de SalaManager: testes
// que martelam isso não devem esbarrar no teto pensado pra gente de verdade.
const VERIFICAR_NOME_JANELA_MS = 5 * 60_000;
const VERIFICAR_NOME_MAX = 20;

// Teto de tentativas de LOGIN FALHADAS por IP — o brute-force de senha em
// `entrar` (item 1 do backlog): sem isto, o único freio era o custo do
// bcrypt (~70ms), o que ainda dá ~14 tentativas/s por conexão. Conta só as
// falhas (usuário não encontrado OU senha errada — as duas contam igual, ver
// o guard no handler: se só uma contasse, o padrão "é bloqueado ou não" viraria
// um outro jeito de descobrir se o nome existe, o mesmo problema do item 3);
// login com sucesso não gasta a cota de ninguém. Bem mais apertado que o de
// verificarNome de propósito — errar senha é bem mais raro que só checar um
// nome.
const ENTRAR_JANELA_MS = 20 * 60_000;
const ENTRAR_MAX = 5;

// Teto de tentativas de CADASTRO por IP (item 7 do backlog: nenhum evento
// tinha rate-limit — `verificarNome`/`entrar` já foram, este era o buraco
// que sobrou). `cadastrar` não depende de `verificarNome` de jeito nenhum
// (são eventos independentes — nada obriga passar por um antes do outro, e
// pra criar conta nova nem faz sentido checar nome livre antes: um nome
// aleatório quase nunca colide), então sem isto dava pra martelar `cadastrar`
// com nomes inventados sem limite nenhum. E cada tentativa custa um hash de
// bcrypt de verdade — mesmo quando falha por nome já existente, o hash já
// rodou ANTES do INSERT esbarrar na constraint UNIQUE (ver criarUsuario em
// db.js) — competindo pelo mesmo threadpool do libuv que `entrar` de gente
// de verdade usa (ver item 4/5: o threadpool é só 4 threads por padrão,
// compartilhado por TODO bcrypt do processo). Por isso conta TODA tentativa,
// sucesso incluso — diferente de `entrar`, aqui não existe "de graça": uma
// mesma IP cadastrando dezenas de contas num intervalo curto já é fora do
// uso normal (uma pessoa cria conta uma vez).
const CADASTRAR_JANELA_MS = 10 * 60_000;
const CADASTRAR_MAX = 10;

// Registra todos os handlers de conexão no `io` passado. `salaManager` pode
// ser injetado (testes) — por padrão cada chamada ganha o seu, isolado.
export function registrarSocketServer(io, salaManager = new SalaManager(), {
    verificarNomeJanelaMs = VERIFICAR_NOME_JANELA_MS,
    verificarNomeMax = VERIFICAR_NOME_MAX,
    entrarJanelaMs = ENTRAR_JANELA_MS,
    entrarMax = ENTRAR_MAX,
    cadastrarJanelaMs = CADASTRAR_JANELA_MS,
    cadastrarMax = CADASTRAR_MAX,
} = {}) {
    const limiteVerificarNome = criarLimitadorDeTaxa({
        janelaMs: verificarNomeJanelaMs,
        maxPorJanela: verificarNomeMax,
    });
    const limiteEntrar = criarLimitadorDeTaxa({
        janelaMs: entrarJanelaMs,
        maxPorJanela: entrarMax,
    });
    const limiteCadastrar = criarLimitadorDeTaxa({
        janelaMs: cadastrarJanelaMs,
        maxPorJanela: cadastrarMax,
    });
    // ip -> Promise da última tentativa de `entrar` em andamento pra essa
    // chave. Existe só pra fechar uma corrida que apareceu ao medir de
    // verdade o ganho do item 4 (bcrypt assíncrono): como login() não
    // termina mais no mesmo tick, duas tentativas de `entrar` da MESMA IP
    // chegando quase juntas passavam as duas pelo `limiteEntrar.permitido`
    // antes de qualquer uma resolver — furando o teto de 5 falhas/20min (e
    // pior: um ataque de força bruta com várias conexões da mesma IP em
    // paralelo exploraria isso de propósito), OU, no caso oposto (várias
    // pessoas na MESMA rede logando ao mesmo tempo, ex.: mesmo wifi), várias
    // reservas simultâneas estourando o teto sem nenhuma ter dado errado
    // ainda — bloqueando gente de verdade por coincidência de horário.
    // `serializarPorIp` (abaixo) enfileira as tentativas da MESMA IP uma
    // atrás da outra (cada uma só começa quando a anterior termina) sem
    // travar NADA mais: outra IP, ou qualquer outro evento desta mesma IP
    // (jogarCarta, apostar...), roda em paralelo normalmente — só as
    // tentativas de `entrar` entre si, da mesma IP, esperam a vez.
    const filaEntrarPorIp = new Map();
    function serializarPorIp(ip, tarefa) {
        const vez = (filaEntrarPorIp.get(ip) ?? Promise.resolve()).catch(() => {}).then(tarefa);
        filaEntrarPorIp.set(ip, vez);
        // Sai do Map quando não sobra mais ninguém enfileirado atrás desta
        // tentativa pra esta IP — sem isso o Map cresceria uma entrada por
        // IP que já tentou logar alguma vez e nunca encolheria.
        vez.catch(() => {}).finally(() => {
            if (filaEntrarPorIp.get(ip) === vez) filaEntrarPorIp.delete(ip);
        });
        return vez;
    }
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
            // qualquer informação privada (ex.: SUA_MAO). Só dá `join` —
            // nunca `leave` numa room pessoal anterior — por isso é
            // indispensável chamar `exigirMesmaIdentidadeOuNenhuma` antes
            // (ver comentário lá): sem isso, reautenticar como outra conta
            // deixaria o socket recebendo a mão privada das DUAS contas ao
            // mesmo tempo (medido e confirmado — ver DEV.md, item 8).
            socket.join(`jogador:${player.id}`);
        };

        // Guard do item 8 do backlog de segurança: barra um socket já
        // autenticado de virar OUTRA identidade sem desconectar. Só existe
        // porque autenticarSocket nunca dá `leave` na room pessoal anterior
        // (ver comentário acima) — sem este guard, um cliente customizado
        // (a UI normal nunca faz isso) conseguiria: autenticar como conta A,
        // depois como conta B no MESMO socket, e ficar recebendo `suaMao`
        // das duas contas pro resto da conexão — ou pior, entrar com as duas
        // na MESMA sala (`entrarSala` só checa "esse player.id já está
        // aqui?") e jogar dois assentos da mesma mesa vendo as duas mãos.
        //
        // Permite reautenticar como a MESMA conta (mesmo player.id) — não é
        // uma troca de identidade, autenticarSocket é idempotente pra esse
        // caso (reescreve os mesmos mapas, `join` numa room que já pertence
        // é no-op). Essencial na prática, não só teórico: o efeito de
        // restaurar sessão salva do front (App.jsx) roda dentro de um
        // React.StrictMode (ver main.jsx), que em desenvolvimento invoca
        // esse efeito duas vezes de propósito — disparando dois
        // `retomarSessao` REAIS pro mesmo token, no mesmo socket, antes do
        // primeiro ack voltar. Se isso fosse barrado, restaurar sessão
        // quebraria toda vez em `npm run dev`.
        const exigirMesmaIdentidadeOuNenhuma = (player) => {
            const atual = jogadorPorSocket.get(socket.id);
            if (atual && atual.id !== player.id) {
                throw new ErroProtocolo(
                    CodigosErro.JA_AUTENTICADO,
                    'Esta conexão já está autenticada como outra conta — desconecte antes de entrar como outra.'
                );
            }
        };

        // Pré-autenticação: não exige "entrar" antes (é o que decide se o
        // cliente vai pedir senha pra confirmar identidade, ou oferecer
        // cadastro/convidado). Nome vazio/ausente não é erro, só nunca existe.
        // Rate-limit por IP (ver comentário de VERIFICAR_NOME_JANELA_MS
        // acima) — sem isto, dava pra varrer uma lista de nomes e descobrir
        // quais são contas de verdade sem limite nenhum.
        socket.on(EventosCliente.VERIFICAR_NOME, ({ nome } = {}, ack) => {
            responder(ack, () => {
                if (!limiteVerificarNome.permitido(socket.handshake.address)) {
                    throw new ErroProtocolo(CodigosErro.MUITAS_TENTATIVAS, 'Muitas tentativas — espere um pouco antes de tentar de novo.');
                }
                // NOME_MAX: nenhuma conta de verdade pode ter nome tão
                // grande (ver cadastro.js) — barra antes de mandar pro banco
                // (item 6 do backlog). Mesmo formato de resposta de sempre
                // (nunca erro pra nome inválido aqui, só `existe: false`).
                const existe = typeof nome === 'string' && nome.length <= NOME_MAX && usuarioExiste(nome.trim());
                return { existe };
            });
        });

        // Rate-limit de LOGIN FALHADO por IP (ver comentário de
        // ENTRAR_JANELA_MS acima). Desde que login() ficou assíncrono (item
        // 4 — bcrypt não trava mais a thread principal), a reserva da
        // unidade precisa acontecer ANTES do `await login()`, num único
        // passo síncrono (`limiteEntrar.permitido`) — se checasse só
        // "restantes > 0" antes e consumisse só depois da falha (do outro
        // lado do await), duas tentativas da MESMA chave chegando quase
        // juntas passariam as duas pelo check antes de qualquer uma
        // consumir, furando o teto de 5. Reservando já de cara, o login com
        // SUCESSO devolve a unidade (`limiteEntrar.devolver`) — só falha de
        // verdade deveria gastar a cota. Se a unidade que ficou consumida
        // (por ter falhado) era a última da janela, o erro ganha
        // `dados.ultimaTentativa` — responder() espalha isso na resposta, o
        // cliente usa pra avisar "essa foi sua última tentativa" antes do
        // bloqueio de verdade.
        socket.on(EventosCliente.ENTRAR, ({ nome, senha } = {}, ack) => {
            const ip = socket.handshake.address;
            responder(ack, () => serializarPorIp(ip, async () => {
                if (!limiteEntrar.permitido(ip)) {
                    throw new ErroProtocolo(CodigosErro.MUITAS_TENTATIVAS, 'Muitas tentativas de login — espere um pouco antes de tentar de novo.');
                }
                try {
                    const { token, player } = await login(nome, senha);
                    limiteEntrar.devolver(ip); // credenciais corretas — não é falha, não gasta a cota de ninguém
                    exigirMesmaIdentidadeOuNenhuma(player); // item 8: não pode virar outra conta no mesmo socket
                    autenticarSocket(player);
                    return { nome: player.nome, token };
                } catch (erro) {
                    if (erro instanceof ErroLogin && limiteEntrar.restantes(ip) === 0) {
                        erro.dados = { ultimaTentativa: true };
                    }
                    throw erro;
                }
            }));
        });

        // Rate-limit de CADASTRO por IP (ver comentário de CADASTRAR_JANELA_MS
        // acima) — não depende de nenhum `await` anterior (a checagem é
        // síncrona, antes de qualquer coisa), então não tem a corrida que
        // `entrar` teve: mesmo várias tentativas da mesma IP chegando juntas,
        // cada `permitido` roda e consome sua unidade num só passo síncrono
        // antes da próxima começar a ser processada.
        socket.on(EventosCliente.CADASTRAR, ({ nome, senha } = {}, ack) => {
            responder(ack, async () => {
                if (!limiteCadastrar.permitido(socket.handshake.address)) {
                    throw new ErroProtocolo(CodigosErro.MUITAS_TENTATIVAS, 'Muitas tentativas de cadastro — espere um pouco antes de tentar de novo.');
                }
                const { token, player } = await cadastrar(nome, senha);
                // item 8: cadastro sempre cria uma identidade NOVA — nunca
                // pode coincidir com quem este socket já era, então isto
                // aqui equivale a "sempre bloqueia se já autenticado".
                exigirMesmaIdentidadeOuNenhuma(player);
                autenticarSocket(player);
                return { nome: player.nome, token };
            });
        });

        socket.on(EventosCliente.ENTRAR_COMO_CONVIDADO, ({ nome } = {}, ack) => {
            responder(ack, () => {
                const { token, player } = entrarComoConvidado(nome);
                // item 8: convidado sempre nasce com id efêmero novo — mesmo
                // motivo de cadastrar acima, sempre bloqueia se já autenticado.
                exigirMesmaIdentidadeOuNenhuma(player);
                autenticarSocket(player);
                return { nome: player.nome, token };
            });
        });

        socket.on(EventosCliente.RETOMAR_SESSAO, ({ token } = {}, ack) => {
            responder(ack, () => {
                // Mesmo formato de entrar/cadastrar/entrarComoConvidado — a
                // diferença é só de onde vem o Player (decodificado do
                // token em vez de checado contra o banco). autenticarSocket
                // associa este socket.id (novo, se veio de uma reconexão)
                // ao mesmo id de jogador de sempre — é o que permite
                // continuar de onde parou sem pedir nome/senha de novo.
                const { token: novoToken, player } = retomarSessao(token);
                exigirMesmaIdentidadeOuNenhuma(player); // item 8 — mesma conta é permitida (ver comentário na definição)
                autenticarSocket(player);
                return { nome: player.nome, token: novoToken };
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
                    ligarControllerASala(io, salaManager, salaCriada, socketPorJogador, salaPorSocket);
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
                    chatAberto: sala.chatAberto,
                };
            });
        });

        socket.on(EventosCliente.PARTIDA_RAPIDA, (_payload, ack) => {
            responder(ack, () => {
                const player = exigirJogador();
                // Mesmo gancho de timing de criarSala: só é chamado quando a
                // sala é nova de fato (SalaManager.partidaRapida decide isso).
                const { sala, criada } = salaManager.partidaRapida(player, (salaCriada) => {
                    socket.join(salaCriada.salaId);
                    salaPorSocket.set(socket.id, salaCriada.salaId);
                    ligarControllerASala(io, salaManager, salaCriada, socketPorJogador, salaPorSocket);
                });
                // Entrando numa sala já existente, o join precisa acontecer
                // aqui mesmo — o gancho acima só roda no caminho de criação.
                if (!criada) {
                    socket.join(sala.salaId);
                    salaPorSocket.set(socket.id, sala.salaId);
                }
                notificarSala(io, sala);
                return {
                    salaId: sala.salaId,
                    numberPlayers: sala.numberPlayers,
                    jogadores: resumoJogadores(sala),
                    segundosParaIniciar: sala.controller.inicioAgendado ? sala.controller.segundosParaIniciar : null,
                    chatAberto: sala.chatAberto,
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
                    chatAberto: sala.chatAberto,
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

        socket.on(EventosCliente.DESISTIR, ({ salaId } = {}, ack) => {
            responder(ack, () => {
                const player = exigirJogador();
                // Desistência definitiva: perde na hora e a vaga expira (ver
                // GameController.desistir). O jogadorDesistiu que sai daí é o
                // que tira o socket dele da room, pelo listener em
                // ligarControllerASala — nada a fazer aqui além de disparar.
                salaManager.desistir(salaId, player);
                return {};
            });
        });

        socket.on(EventosCliente.JOGAR_DE_NOVO, ({ salaId } = {}, ack) => {
            responder(ack, () => {
                const player = exigirJogador();
                const novaSala = salaManager.jogarDeNovo(salaId, player, (salaCriada) => {
                    socket.join(salaCriada.salaId);
                    salaPorSocket.set(socket.id, salaCriada.salaId);
                    ligarControllerASala(io, salaManager, salaCriada, socketPorJogador, salaPorSocket);
                });
                // Quem chamou jogarDeNovo sai de verdade da sala que
                // terminou — o socket não deve mais receber nada dela
                // (nem o próprio convidadoParaRevanche abaixo, que é pra
                // quem ficou). salaPorSocket já foi sobrescrito pra apontar
                // pra sala nova, dentro do aoNascer acima.
                socket.leave(salaId);
                // A sala antiga já terminou (é pré-condição de jogarDeNovo) —
                // se quem chamou era o último socket ainda conectado nela,
                // pode descartar na hora, sem esperar mais ninguém decidir
                // aceitar/recusar o convite abaixo (ver
                // encerrarSeFinalizadaEVazia).
                encerrarSeFinalizadaEVazia(io, salaManager, salaId);
                notificarSala(io, novaSala);
                // Avisa quem mais estava na sala que terminou (broadcast na
                // room antiga — ninguém saiu dela ainda, exceto quem já tinha
                // sido expulso por inatividade antes do fim da partida).
                io.to(salaId).emit(EventosServidor.CONVITE_REVANCHE, {
                    salaId,
                    novaSalaId: novaSala.salaId,
                    jogador: player.nome,
                });
                return {
                    salaId: novaSala.salaId,
                    numberPlayers: novaSala.numberPlayers,
                    jogadores: resumoJogadores(novaSala),
                    segundosParaIniciar: novaSala.controller.inicioAgendado ? novaSala.controller.segundosParaIniciar : null,
                    chatAberto: novaSala.chatAberto,
                };
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
                const { sala, estado } = salaManager.reconectar(salaId, player);
                socket.join(salaId);
                salaPorSocket.set(socket.id, salaId);
                return { salaId, ...estado, chatAberto: sala.chatAberto };
            });
        });

        socket.on(EventosCliente.MINHA_SALA_ATIVA, (_payload, ack) => {
            responder(ack, () => {
                const player = exigirJogador();
                return { salaId: salaManager.salaAtivaDoJogador(player.id) };
            });
        });

        socket.on(EventosCliente.CHAT, ({ salaId, tipo, id, texto } = {}, ack) => {
            responder(ack, () => {
                const player = exigirJogador();
                // salaManager.enviarChat cuida de sala/membership, cooldown
                // (chatCooldownMs) e conteúdo (tipo/id/texto) — lança
                // ErroSala ou ErroChat, que responder() já traduz pro ack de
                // erro (ver conexao/SalaManager.js e conexao/chat/chat.js).
                const conteudo = salaManager.enviarChat(salaId, player, { tipo, id, texto });
                io.to(salaId).emit(EventosServidor.CHAT_MENSAGEM, {
                    salaId,
                    jogador: player.nome,
                    ...conteudo,
                });
                return {};
            });
        });

        socket.on('disconnect', () => {
            const player = jogadorPorSocket.get(socket.id);
            const salaId = salaPorSocket.get(socket.id);
            jogadorPorSocket.delete(socket.id);
            salaPorSocket.delete(socket.id);
            if (player && socketPorJogador.get(player.id) === socket.id) {
                // Este era o socket "atual" desse jogador. Em cenário multi-aba
                // pode ter sobrado outra conexão autenticada dele — reaponta
                // socketPorJogador pra ela em vez de deixar a entrada sumir e
                // o jogador ficar sem socket endereçável (ex.:
                // jogadorExpulsoPorInatividade não acharia a aba ainda aberta).
                let substituto = null;
                for (const [outroSocketId, outroPlayer] of jogadorPorSocket) {
                    if (outroPlayer.id === player.id) { substituto = outroSocketId; break; }
                }
                if (substituto) {
                    socketPorJogador.set(player.id, substituto);
                } else {
                    socketPorJogador.delete(player.id);
                }
            }

            // Multi-aba / relogin: se ainda sobrou OUTRO socket autenticado
            // deste mesmo jogador apontando pra esta sala, este disconnect é
            // só uma aba fechando entre várias — não pode tirar o assento de
            // quem continua ativo noutra aba. Só quando não sobra nenhum é
            // que a limpeza abaixo faz sentido.
            const outraAbaNaSala = !!player && [...jogadorPorSocket].some(
                ([outroId, outroPlayer]) => outroPlayer.id === player.id && salaPorSocket.get(outroId) === salaId
            );

            // Best-effort: sem cliente do outro lado pra responder erro
            // nenhum. Numa sala ainda em espera, sairSala tira o assento de
            // verdade. Numa partida em andamento (não finalizada), não
            // tocamos em nada — cair no meio do jogo não perde o assento
            // (pré-condição pra reconexão futura); o próprio timeout de
            // turno já cuida de marcar inatividade normalmente. Já numa
            // partida FINALIZADA, não existe mais nenhum turno sendo
            // despachado pra um timeout algum dia pegar essa desconexão —
            // sem isso, fechar a aba depois de ver o resultado nunca
            // reservaria/expiraria a vaga, e a sucessão de adm (ver
            // GameController._transferirAdm) nunca aconteceria pra quem só
            // fechou a aba sem clicar em nada.
            if (player && salaId && !outraAbaNaSala) {
                const sala = salaManager.obterSala(salaId);
                if (sala && sala.controller.finalizada) {
                    if (!sala.controller.vagaExpirada(player.id)) {
                        try {
                            salaManager.abandonarPartida(salaId, player);
                        } catch (erro) {
                            if (!(erro instanceof ErroSala)) {
                                console.error('Erro inesperado ao abandonar partida finalizada no disconnect:', erro);
                            }
                        }
                    }
                } else {
                    try {
                        notificarSala(io, salaManager.sairSala(salaId, player));
                    } catch (erro) {
                        if (!(erro instanceof ErroSala)) {
                            console.error('Erro inesperado ao limpar sala no disconnect:', erro);
                        }
                    }
                }
            }

            // Socket.io já tirou este socket de todas as rooms dele antes de
            // disparar 'disconnect' — se a sala já tinha terminado e essa era
            // a última conexão de verdade nela (ex.: fechou a aba depois de
            // ganhar, sem clicar em nada), pode descartar na hora (ver
            // encerrarSeFinalizadaEVazia).
            if (salaId) {
                encerrarSeFinalizadaEVazia(io, salaManager, salaId);
            }
        });
    });

    return salaManager;
}

function resumoJogadores(sala) {
    return sala.jogadores.map(jogador => ({ nome: jogador.nome, adm: jogador.adm }));
}

function notificarSala(io, sala) {
    io.to(sala.salaId).emit(EventosServidor.LISTA_JOGADORES, {
        salaId: sala.salaId,
        jogadores: resumoJogadores(sala),
    });
}

// Uma sala com partida já finalizada (GameController.finalizada) não serve
// pra mais nada assim que ninguém segue conectado nela: não existe
// "reconectar" pra uma partida que já acabou, e cada jeito de sair dela
// depois do fim (sairDaPartida, recusar/aceitar um convite de revanche, ou
// só fechar a aba) já tira o socket da room — ver os três pontos que chamam
// isto. Só o socket.io sabe se a room está vazia (SalaManager não conhece
// socket nenhum), por isso este helper mora aqui, não em SalaManager.js.
function encerrarSeFinalizadaEVazia(io, salaManager, salaId) {
    const sala = salaManager.obterSala(salaId);
    if (!sala || !sala.controller.finalizada) return;

    const room = io.sockets.adapter.rooms.get(salaId);
    if (!room || room.size === 0) {
        salaManager.removerSala(salaId);
    }
}

// Assina os eventos do GameController da sala e retransmite pros sockets.
// Chamado uma vez só, na criação da sala — o controller vive tanto quanto a
// sala, então essa assinatura vale pro resto da vida dela (espera + partida
// inteira). Todo evento é broadcast pra sala, exceto cartasDistribuidas e
// maosReveladas, que são privados por natureza (cada jogador recebe só o que
// ele pode ver — a própria mão, ou a dos outros na rodada de 1 carta).
function ligarControllerASala(io, salaManager, sala, socketPorJogador, salaPorSocket) {
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
    retransmitir(EventosServidor.PARTIDA_ABORTADA);
    retransmitir(EventosServidor.JOGADA_AUTOMATICA);
    retransmitir(EventosServidor.JOGADOR_RECONECTOU);
    retransmitir(EventosServidor.JOGADOR_EXPULSO_POR_INATIVIDADE);
    retransmitir(EventosServidor.JOGADOR_DESISTIU);
    retransmitir(EventosServidor.VAGA_EXPIRADA);
    retransmitir(EventosServidor.NOVO_ADM);

    // Além do broadcast acima (que avisa a sala toda, inclusive o próprio
    // expulso — o cliente decide navegar pra tela de salas olhando o `id`),
    // o socket dele precisa sair de verdade da room do socket.io, senão
    // continuaria recebendo os eventos da partida numa tela que ele não está
    // mais olhando. A vaga na partida (controller.jogadores) não muda —
    // só a presença do socket na room — então "reconectar" continua
    // funcionando normalmente depois.
    controller.on(EventosServidor.JOGADOR_EXPULSO_POR_INATIVIDADE, ({ id, jogador }) => {
        // Mesmo evento pra inatividade de verdade e pra "Sair da partida"
        // (ver PROTOCOLO.md) — não dá pra saber qual dos dois foi só pelo
        // payload, e a mensagem serve pros dois igual.
        console.log(`[Sala ${salaId}] ${jogador} desconectou — um bot assumiu o lugar dele.`);
        const socketId = socketPorJogador.get(id);
        if (!socketId || salaPorSocket.get(socketId) !== salaId) return;
        io.sockets.sockets.get(socketId)?.leave(salaId);
        salaPorSocket.delete(socketId);
        // Se a partida já tinha terminado (ex.: alguém clicou "Sair" depois
        // de ver o vencedor, ou recusou um convite de revanche) e esse era o
        // último socket ainda na room, a sala não serve mais pra nada — ver
        // encerrarSeFinalizadaEVazia.
        encerrarSeFinalizadaEVazia(io, salaManager, salaId);
    });

    // Desistência definitiva (ver EventosCliente.DESISTIR): mesmo efeito de
    // socket que a expulsão acima — o assento continua na partida (como bot,
    // já eliminado no fim da rodada), mas o socket dele não tem mais nada a
    // ver com esta room. O broadcast de jogadorDesistiu já avisou a sala.
    controller.on(EventosServidor.JOGADOR_DESISTIU, ({ id, jogador }) => {
        console.log(`[Sala ${salaId}] ${jogador} desistiu da partida.`);
        const socketId = socketPorJogador.get(id);
        if (socketId && salaPorSocket.get(socketId) === salaId) {
            io.sockets.sockets.get(socketId)?.leave(salaId);
            salaPorSocket.delete(socketId);
        }
        encerrarSeFinalizadaEVazia(io, salaManager, salaId);
    });

    // jogadorEntrou/jogadorSaiu (sala de espera) não têm evento próprio no
    // protocolo — a lista de jogadores já vai por listaJogadores. Aqui eles
    // viram uma linha de sistema no chat da sala ("Fulano entrou na sala"),
    // pra dar um feedback visível de quem chega e sai antes da partida
    // começar. tipo 'sistema' passa direto, sem cooldown nem chatAberto (não
    // é mensagem de jogador — ver montarMensagemChat).
    const avisoSistema = (nome, texto) => {
        io.to(salaId).emit(EventosServidor.CHAT_MENSAGEM, { salaId, tipo: 'sistema', jogador: nome, id: null, texto });
    };
    controller.on('jogadorEntrou', ({ nome }) => avisoSistema(nome, 'entrou na sala'));
    controller.on('jogadorSaiu', ({ nome }) => avisoSistema(nome, 'saiu da sala'));

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
// Erros de domínio conhecidos (ErroLogin, ErroCadastro, ErroConvidado,
// ErroSessao, ErroSala, ErroChat, ErroProtocolo) viram
// resposta de erro normal; qualquer outra exceção é logada no servidor e
// devolvida como ERRO_INTERNO — nunca deixa a exceção derrubar o socket.
//
// ASSÍNCRONA (desde o item 4 do backlog: login()/cadastrar() agora usam
// bcrypt assíncrono) — `await acao()` funciona igual pra uma `acao` síncrona
// (a maioria dos handlers) e pra uma assíncrona (ENTRAR/CADASTRAR): `await`
// num valor que não é Promise só resolve com ele na hora, sem esperar nada.
// Um `throw` síncrono dentro de `acao` continua caindo no mesmo catch de
// sempre, Promise ou não.
async function responder(ack, acao) {
    if (typeof ack !== 'function') return; // cliente não pediu resposta, nada a fazer
    try {
        const resultado = await acao();
        ack({ ok: true, ...resultado });
    } catch (erro) {
        if (erro instanceof ErroLogin || erro instanceof ErroCadastro || erro instanceof ErroConvidado || erro instanceof ErroSessao || erro instanceof ErroSala || erro instanceof ErroChat || erro instanceof ErroProtocolo) {
            // `erro.dados` (hoje só ErroSala usa — ex.: JA_EM_PARTIDA manda
            // { salaId }) vai junto no ack de erro.
            ack({ ok: false, codigo: erro.codigo, mensagem: erro.message, ...(erro.dados ?? {}) });
        } else {
            console.error('Erro inesperado num handler de socket:', erro);
            ack({ ok: false, codigo: CodigosErro.ERRO_INTERNO, mensagem: 'Erro interno do servidor.' });
        }
    }
}

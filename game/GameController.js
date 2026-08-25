// GameController.js
// Dona da sala de espera (lista de jogadores antes da partida começar) e
// orquestra a partida inteira (Game -> RodadaGame -> Mesa) quando ela
// começa, expondo o andamento como eventos em vez de console.log espalhado.
//
// Isso serve dois consumidores ao mesmo tempo, sem duplicar a lógica de regras:
//  - Main.js: assina os eventos e imprime no console (harness de teste local)
//  - Server.js (futuro): assina os eventos e faz io.emit(...) para os clientes via socket.io
import { EventEmitter } from 'node:events';
import { Game } from './Game.js';
import { PlayerGame } from './PlayerGame.js';

// Placeholder de bot: joga a última carta da mão, igual ao pop() que o
// motor usava antes de esperar jogada real. Só existe pra validar o
// mecanismo de timeout — trocar por uma escolha de verdade é trabalho
// futuro (ver PROTOCOLO.md).
function escolherCartaAutomatica(jogador) {
    return jogador.mao.length - 1;
}

export class GameController extends EventEmitter {
    constructor({ numberPlayers, roundStart, randomShuffle, tempoTurnoMs, limiteInatividadeMs } = {}) {
        super();
        this.numberPlayers = numberPlayers || 4;
        this.roundStart = roundStart || 3;
        this.randomShuffle = randomShuffle;
        // Quanto tempo esperar a jogada real antes de cair pro automático
        // (ver _aguardarJogadaOuTimeout). Campo público de propósito — dá
        // pra ajustar por sala (ex.: testes usam um valor bem menor).
        this.tempoTurnoMs = tempoTurnoMs ?? 15_000;
        // Quanto tempo (real, não em turnos) sem nenhuma ação de verdade até
        // o jogador ser expulso do socket da sala (ver _registrarTimeout /
        // jogadorExpulsoPorInatividade) — a vaga na partida continua, só o
        // socket sai. Campo público pelo mesmo motivo de tempoTurnoMs acima.
        this.limiteInatividadeMs = limiteInatividadeMs ?? 90_000;
        this.jogadores = [];
        this.game = null;
        this.rodada = null;
        this.numeroRodada = 0;
        this._timerInicio = null;
        this._jogadaEsperada = null;
        this._apostaEsperada = null;
    }

    // Sala de espera: transforma o Player que entrou num PlayerGame e guarda
    // na lista até a partida começar. Ordem de chegada é a própria posição
    // no array — nenhum campo à parte guarda isso.
    entrarNaSala(player) {
        this.jogadores.push(new PlayerGame(player));
        this.emit('jogadorEntrou', { id: player.id, nome: player.nome });
        return this;
    }

    // Chamado quando a sala lota: dá um tempo de espera antes de começar de
    // verdade (dá chance de cancelar via forcarInicio, ou simplesmente pra
    // não começar no instante exato que a última pessoa entra). Idempotente
    // — chamar de novo com a partida já agendada ou já iniciada não faz nada.
    agendarInicio(tempoEsperaMs) {
        if (this.game || this._timerInicio) return;

        this._timerInicio = setTimeout(() => this.iniciarPartida(), tempoEsperaMs);
        this._timerInicio.unref?.(); // não deve segurar o processo vivo (testes, shutdown)
        this.emit('partidaIniciandoEm', { segundos: tempoEsperaMs / 1000 });
    }

    // Pura consulta — não lança, não muda estado. Quem decide se isso vira
    // um erro de protocolo (NAO_AUTORIZADO) é a camada de sala, não aqui.
    jogadorEhAdm(playerId) {
        return this.jogadores.some(jogador => jogador.id === playerId && jogador.adm);
    }

    // Sala de espera, ao contrário: tira o jogador da lista. Só faz sentido
    // antes da partida começar (quem chama garante isso, olhando `game`).
    // Se quem saiu era o adm e sobrou gente, o próximo da lista assume — a
    // sala nunca fica sem ninguém que possa forçar início. Cancela um
    // início agendado, já que a sala deixou de estar cheia. Devolve false
    // se o jogador nem estava na lista (chamador decide se isso é erro).
    removerJogador(playerId) {
        const indice = this.jogadores.findIndex(jogador => jogador.id === playerId);
        if (indice === -1) return false;

        const eraAdm = this.jogadores[indice].adm;
        this.jogadores.splice(indice, 1);
        if (eraAdm && this.jogadores.length > 0) {
            this.jogadores[0].adm = true;
        }

        if (this._timerInicio) {
            clearTimeout(this._timerInicio);
            this._timerInicio = null;
        }

        this.emit('jogadorSaiu', { id: playerId });
        return true;
    }

    // Pula a espera de agendarInicio e começa na hora. Quem valida se quem
    // pediu tem permissão é a camada de sala (via jogadorEhAdm), antes de
    // chamar isto.
    forcarInicio() {
        if (this._timerInicio) {
            clearTimeout(this._timerInicio);
            this._timerInicio = null;
        }
        this.iniciarPartida();
    }

    iniciarPartida() {
        if (this.game) return this; // idempotente — evita reiniciar se o timer e um forcarInicio colidirem

        if (this._timerInicio) {
            clearTimeout(this._timerInicio);
            this._timerInicio = null;
        }

        this.game = new Game({
            numberPlayers: this.numberPlayers,
            roundStart: this.roundStart,
            randomShuffle: this.randomShuffle,
            jogadores: [...this.jogadores],
        });
        this.game.setstartsequence();

        // O relógio de inatividade só passa a valer a partir daqui — tempo
        // parado na sala de espera não deve contar contra ninguém.
        const agora = Date.now();
        for (const jogador of this.jogadores) {
            jogador.ultimaAcaoEm = agora;
            jogador.expulsoPorInatividade = false;
        }

        this.numeroRodada = 1;
        this.rodada = this.game.newRodada();
        this.emit('novaRodadaIniciada', { numero: this.numeroRodada, cartas: this.rodada.round });

        // A partir daqui a partida roda em segundo plano, pausando pra
        // esperar cada jogada real (ver _aguardarJogada/jogarCarta) — pode
        // levar segundos, minutos, o tempo que for. iniciarPartida() não
        // espera nada disso, só dispara e devolve na hora. O .catch aqui é
        // a mesma filosofia do responder() em socketServer.js: um erro
        // inesperado no meio da partida não pode virar um unhandled
        // rejection e derrubar o processo.
        this._jogarRodadaAtual().catch(erro => {
            console.error('Erro inesperado durante a partida:', erro);
        });
        return this;
    }

    // Devolve uma Promise que só resolve quando jogarCarta(jogador.id, ...)
    // for chamado com sucesso pra esse jogador específico — é a pausa real
    // que faltava. Guardar { jogadorId, resolver } ANTES de emitir
    // turnoJogador (chamado por quem usa isto) é o que permite um listener
    // síncrono (ex.: o auto-play do Main.js) responder na hora, dentro do
    // próprio emit, sem cair numa corrida onde a espera ainda nem existe.
    _aguardarJogada(jogador) {
        return new Promise((resolve) => {
            this._jogadaEsperada = { jogadorId: jogador.id, resolver: resolve };
        });
    }

    // Chamado sempre que um jogador faz alguma ação real (jogar carta,
    // apostar ou reconectar) — desliga a flag de "no automático" e reseta o
    // relógio de inatividade usado por _registrarTimeout, pra turnos que já
    // não são mais dele não contarem contra ele.
    _registrarAtividade(jogador) {
        jogador.desconectado = false;
        jogador.expulsoPorInatividade = false;
        jogador.ultimaAcaoEm = Date.now();
    }

    // Chamado por todo timeout de turno (aposta ou carta): liga desconectado
    // (jogada automática já em curso) e, só na primeira vez que a
    // inatividade real dele passar de limiteInatividadeMs, expulsa o socket
    // da sala — ver jogadorExpulsoPorInatividade, tratado em
    // conexao/socketServer.js. A vaga na partida não muda, só a presença do
    // socket na room; o guard de expulsoPorInatividade evita reemitir isso a
    // cada novo timeout enquanto ele continuar sumido.
    _registrarTimeout(jogador) {
        jogador.desconectado = true;
        if (!jogador.expulsoPorInatividade && Date.now() - jogador.ultimaAcaoEm >= this.limiteInatividadeMs) {
            jogador.expulsoPorInatividade = true;
            this.emit('jogadorExpulsoPorInatividade', { id: jogador.id, jogador: jogador.nome });
        }
    }

    // Igual _aguardarJogada, mas com prazo: se tempoTurnoMs passar sem
    // jogarCarta() de verdade, joga por conta própria (placeholder de bot,
    // ver escolherCartaAutomatica) e liga jogador.desconectado — é o sinal
    // de que essa cadeira está no automático até reconectar ou jogar de
    // novo (ver marcarReconectado / jogarCarta). O guard dentro do timeout
    // existe pra não resolver duas vezes se o timer disparar bem na hora
    // que uma jogada real também chegou.
    async _aguardarJogadaOuTimeout(jogador) {
        const jogadaFeita = this._aguardarJogada(jogador);
        this.emit('turnoJogador', { id: jogador.id, jogador: jogador.nome });

        const timer = setTimeout(() => {
            if (this._jogadaEsperada?.jogadorId !== jogador.id) return;
            this._registrarTimeout(jogador);
            const resolver = this._jogadaEsperada.resolver;
            this._jogadaEsperada = null;
            this.emit('jogadaAutomatica', { id: jogador.id, jogador: jogador.nome });
            resolver(escolherCartaAutomatica(jogador));
        }, this.tempoTurnoMs);
        timer.unref?.();

        const indice = await jogadaFeita;
        clearTimeout(timer);
        return indice;
    }

    // Chamado de fora (via protocolo) quando um jogador manda a carta que
    // quer jogar. `indice` é a posição na mão dele (0-based). Devolve
    // { ok: true } se aceita — e só então o índice é consumido e a espera
    // em _jogarRodadaAtual é liberada — ou { ok: false, motivo } se não for
    // a vez desse jogador ou o índice não existir na mão dele; nesses casos
    // nada muda e a espera continua de pé.
    jogarCarta(playerId, indice) {
        if (!this._jogadaEsperada || this._jogadaEsperada.jogadorId !== playerId) {
            return { ok: false, motivo: 'NAO_E_SUA_VEZ' };
        }

        const jogador = this.jogadores.find(j => j.id === playerId);
        if (!Number.isInteger(indice) || indice < 0 || indice >= jogador.mao.length) {
            return { ok: false, motivo: 'CARTA_INVALIDA' };
        }

        this._registrarAtividade(jogador); // jogou de verdade — claramente está de volta
        const resolver = this._jogadaEsperada.resolver;
        this._jogadaEsperada = null;
        resolver(indice);
        return { ok: true };
    }

    // Fixa a aposta de um jogador e avisa a sala — chamado tanto por uma
    // aposta real (apostar) quanto pelo timeout (valor default). Único lugar
    // que escreve em jogador.aposta, pra sempre emitir apostaFeita junto.
    _registrarAposta(jogador, valor) {
        jogador.aposta = valor;
        this.emit('apostaFeita', { jogador: jogador.nome, aposta: valor });
    }

    // Mesma ideia de _aguardarJogada, mas pra aposta: só resolve quando
    // apostar(jogador.id, ...) for chamado com sucesso pra esse jogador.
    _aguardarAposta(jogador) {
        return new Promise((resolve) => {
            this._apostaEsperada = { jogadorId: jogador.id, resolver: resolve };
        });
    }

    // Soma das apostas já registradas pelos outros jogadores da rodada (o
    // próprio `jogador` fica de fora da soma, apostado ou não). Só faz
    // sentido chamar isso pelo último a apostar — pros demais, ainda tem
    // gente sem apostar (valor default 0), então a soma não representaria
    // "todo mundo menos eu".
    _somaApostasDosOutros(jogador) {
        return this.rodada.gameOrder.reduce((soma, j) => j === jogador ? soma : soma + j.aposta, 0);
    }

    // true só pro último jogador a apostar na rodada (ordem de
    // rodada.gameOrder, a mesma em que _jogarRodadaAtual pede as apostas) —
    // é o único cuja aposta fecha (ou não) a soma de todo mundo, porque
    // todos os outros já apostaram quando chega a vez dele.
    _ehUltimoAApostar(jogador) {
        const ordem = this.rodada.gameOrder;
        return ordem[ordem.length - 1] === jogador;
    }

    // Aposta usada quando o timeout estoura: 1, igual sempre foi. Só cai pra
    // 0 se 1 violar a regra de fechamento (só pode acontecer com o último a
    // apostar) — 0 sempre é uma alternativa válida nesse caso, porque só
    // existe um valor proibido por vez (ver apostar()).
    _apostaPadrao(jogador) {
        if (this._ehUltimoAApostar(jogador) && this._somaApostasDosOutros(jogador) + 1 === this.rodada.round) {
            return 0;
        }
        return 1;
    }

    // Igual _aguardarJogadaOuTimeout: emite turnoAposta e dá tempoTurnoMs
    // pra uma aposta real chegar; estourou, registra a aposta padrão (ver
    // _apostaPadrao) e liga desconectado.
    async _aguardarApostaOuTimeout(jogador) {
        const apostaFeita = this._aguardarAposta(jogador);
        this.emit('turnoAposta', { id: jogador.id, jogador: jogador.nome });

        const timer = setTimeout(() => {
            if (this._apostaEsperada?.jogadorId !== jogador.id) return;
            this._registrarTimeout(jogador);
            const resolver = this._apostaEsperada.resolver;
            this._apostaEsperada = null;
            this._registrarAposta(jogador, this._apostaPadrao(jogador));
            resolver();
        }, this.tempoTurnoMs);
        timer.unref?.();

        await apostaFeita;
        clearTimeout(timer);
    }

    // Chamado de fora (via protocolo) quando um jogador manda a aposta dele.
    // Mesmo formato de retorno de jogarCarta: { ok: true } se aceita, ou
    // { ok: false, motivo } se não for a vez dele ou o valor for inválido.
    // Dois limites: `valor` tem que estar entre 0 e o número de cartas da
    // rodada (fora disso, não faz sentido apostar mais vazas do que existem
    // cartas pra fazer); e o ÚLTIMO a apostar não pode escolher o valor que
    // fecha a soma de todo mundo exatamente no número de cartas — isso
    // garantiria que alguém acerta a aposta sem perder vida, o que não pode
    // (é justamente por isso que a ordem de aposta precisa ser aleatória:
    // ser o último é uma desvantagem real, então não pode ser sempre a
    // mesma pessoa por ter entrado por último na sala).
    apostar(playerId, valor) {
        if (!this._apostaEsperada || this._apostaEsperada.jogadorId !== playerId) {
            return { ok: false, motivo: 'NAO_E_SUA_VEZ' };
        }

        const numCartas = this.rodada.round;
        if (!Number.isInteger(valor) || valor < 0 || valor > numCartas) {
            return { ok: false, motivo: 'APOSTA_INVALIDA' };
        }

        const jogador = this.jogadores.find(j => j.id === playerId);
        if (this._ehUltimoAApostar(jogador) && this._somaApostasDosOutros(jogador) + valor === numCartas) {
            return { ok: false, motivo: 'APOSTA_FECHA_RODADA' };
        }

        this._registrarAtividade(jogador); // apostou de verdade — claramente está de volta
        const resolver = this._apostaEsperada.resolver;
        this._apostaEsperada = null;
        this._registrarAposta(jogador, valor);
        resolver();
        return { ok: true };
    }

    // Estado mínimo pra alguém que estava fora reencaixar numa partida já em
    // andamento: a própria mão atual e de quem é a vez agora — tanto pra
    // jogar carta quanto pra apostar, porque as duas esperas (_jogadaEsperada
    // e _apostaEsperada) nunca coexistem (a rodada só chega na vaza depois
    // que todo mundo já apostou), então no máximo uma das duas está de pé
    // quando isto é chamado. null se esse playerId não faz parte de uma
    // partida em andamento aqui (sala ainda não começou, ou ele nunca esteve
    // nela).
    estadoDeReconexao(playerId) {
        if (!this.game) return null;
        const jogador = this.jogadores.find(j => j.id === playerId);
        if (!jogador) return null;

        const idDaVez = this._jogadaEsperada?.jogadorId ?? null;
        const idDaVezAposta = this._apostaEsperada?.jogadorId ?? null;
        return {
            mao: jogador.mao.map(c => c.toString()),
            cartasRodada: this.rodada.round,
            suaVez: idDaVez === playerId,
            jogadorDaVez: idDaVez ? this.jogadores.find(j => j.id === idDaVez)?.nome ?? null : null,
            suaVezDaAposta: idDaVezAposta === playerId,
            jogadorDaVezAposta: idDaVezAposta ? this.jogadores.find(j => j.id === idDaVezAposta)?.nome ?? null : null,
        };
    }

    // Chamado quando o jogador reconecta de verdade (ver conexao/SalaManager.js)
    // — só desliga a flag de "jogando no automático". O resto do estado
    // (mão, hp, vez) já sobrevive à desconexão por natureza, não precisa
    // reconstruir nada.
    marcarReconectado(playerId) {
        const jogador = this.jogadores.find(j => j.id === playerId);
        if (!jogador) return false;

        this._registrarAtividade(jogador);
        this.emit('jogadorReconectou', { id: jogador.id, nome: jogador.nome });
        return true;
    }

    async _jogarRodadaAtual() {
        const rodada = this.rodada;

        rodada.darCartas();
        this.emit('cartasDistribuidas', rodada.gameOrder.map(j => ({
            id: j.id,
            nome: j.nome,
            mao: j.mao.map(c => c.toString())
        })));

        rodada.virarManilha();
        this.emit('manilhaVirada', { vira: rodada.vira.toString(), viraValor: rodada.viraValor });

        // Ordem da rodada, um de cada vez — a resposta de quem aposta antes
        // pode (e deve) influenciar quem vem depois, então não dá pra
        // paralelizar isso: cada apostaFeita só sai depois da anterior.
        for (const jogador of rodada.gameOrder) {
            await this._aguardarApostaOuTimeout(jogador);
        }

        for (let v = 0; v < rodada.round; v++) {
            if (v > 0) rodada.novaVaza();

            const ordem = rodada.ordemDaVaza();
            for (const jogador of ordem) {
                const indice = await this._aguardarJogadaOuTimeout(jogador);

                const carta = jogador.mao.splice(indice, 1)[0];
                const status = rodada.registrarJogada(jogador, carta);
                this.emit('cartaJogada', { jogador: jogador.nome, carta: carta.toString(), status });
            }

            const vencedor = rodada.finalizarVaza();
            this.emit('vazaFinalizada', {
                vencedor: vencedor ? vencedor.nome : null,
                carta: vencedor ? rodada.mesaAtiva.melhorJogada.carta.toString() : null
            });
        }

        const apostas = new Map(rodada.gameOrder.map(j => [j, j.aposta]));
        const steaks = new Map(rodada.gameOrder.map(j => [j, j.steak]));
        rodada.finalizarRodada();
        this.emit('rodadaFinalizada', {
            numero: this.numeroRodada,
            resultado: rodada.gameOrder.map(j => ({
                nome: j.nome,
                aposta: apostas.get(j),
                steak: steaks.get(j),
                diferenca: Math.abs(apostas.get(j) - steaks.get(j)),
                hp: j.hp
            }))
        });

        await this._avancarOuFinalizar();
    }

    async _avancarOuFinalizar() {
        const vivos = this.game.gameOrder.filter(j => j.hp > 0);
        if (vivos.length === 1) {
            this.emit('jogoFinalizado', { vencedor: vivos[0].nome });
            return;
        }
        if (vivos.length === 0) {
            // Todos os jogadores que disputavam a mesa zeraram o hp na mesma rodada.
            // Desempate: vence quem teve a menor diferença entre aposta e steak na última rodada.
            const vencedor = this.rodada.gameOrder.reduce((melhor, jogador) => {
                const diferenca = Math.abs(jogador.aposta - jogador.steak);
                return diferenca < melhor.diferenca ? { jogador, diferenca } : melhor;
            }, { jogador: this.rodada.gameOrder[0], diferenca: Math.abs(this.rodada.gameOrder[0].aposta - this.rodada.gameOrder[0].steak) });
            this.emit('jogoFinalizado', { vencedor: vencedor.jogador.nome });
            return;
        }

        const eliminados = this.game.eliminarZerados();
        if (eliminados.length > 0) {
            this.emit('jogadoresEliminados', { eliminados: eliminados.map(j => ({ nome: j.nome, hp: j.hp })) });
        }
        this.rodada.resetarApostasSteaks();
        this.game.girarOrdem();

        this.numeroRodada++;
        this.rodada = this.game.proximaRodada();
        this.emit('novaRodadaIniciada', { numero: this.numeroRodada, cartas: this.rodada.round });

        await this._jogarRodadaAtual();
    }
}

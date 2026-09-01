// env_bridge.js
// Ambiente de treino por self-play: sobe um GameController headless (sem
// socket, sem Server.js — mesmo espírito do Main.js) e conversa com o
// processo Python via stdin/stdout, uma linha JSON por mensagem. O motor de
// regras (GameController -> Game -> RodadaGame -> Mesa -> Baralho) é o
// mesmo de produção — nada é reimplementado aqui, só a "cola" que troca
// "decide pela última carta" (Main.js) por "pergunta pro Python".
//
// Rodar sozinho não faz sentido — quem fala com isto é
// training/python/env_client.py, via subprocess (Python é quem dá spawn
// neste arquivo, não o contrário).
//
// Protocolo (uma linha = um JSON):
//   Node -> Python:
//     { type: "step", episode, seat, kind: "aposta"|"carta"|"final",
//       reward, done, actionRequired, obs, legalMask }
//     - reward: soma de tudo que esse `seat` ganhou desde a última mensagem
//       que ele recebeu (0 se nada resolveu desde então) — mesma semântica
//       de retorno de step() do Gym, só que multi-agente via `seat`.
//     - done: true só na mensagem final de cada `seat` (jogoFinalizado) —
//       nesse caso actionRequired é sempre false, kind é "final", obs/
//       legalMask vêm null.
//   Python -> Node:
//     { action: <int> }  — só quando actionRequired foi true, e só depois
//     dessa linha chegar Node continua a partida.
//
// Um novo episódio começa sozinho, sem round-trip nenhum, assim que o
// anterior termina — Python detecta a fronteira pelo campo `episode` mudar
// (ou por done=true chegando pros 4 assentos).
import { createInterface } from 'node:readline';
import { Player } from '../game/Player.js';
import { GameController } from '../game/GameController.js';

// A avaliação pode fixar uma seed sem interferir no servidor nem no treino
// normal: este arquivo sempre roda em um subprocesso próprio. Assim, mesma
// seed + mesmas políticas produz a mesma sequência de embaralhamentos.
function instalarAleatoriedadeDeterministica() {
    const textoSeed = process.env.EVAL_SEED;
    if (textoSeed === undefined) return;

    const seed = Number(textoSeed);
    if (!Number.isInteger(seed)) throw new Error('EVAL_SEED deve ser um inteiro.');

    let estado = seed >>> 0;
    Math.random = () => {
        estado += 0x6D2B79F5;
        let t = estado;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
    };
}

instalarAleatoriedadeDeterministica();

const NUM_SEATS = 4;
const ROUND_START = 3;
// Liga/desliga a flag "já apostou" (ver construirObs) — precisa concordar
// com COM_FLAG_APOSTOU em training/python/model.py (o tamanho da observação
// tem que bater com o tamanho de entrada da rede). Existe só pra poder
// continuar treinando o baseline antigo (66 números) em paralelo com a
// versão nova (70), pra comparação — não é config de produção nenhuma.
const COM_FLAG_APOSTOU = process.env.COM_FLAG_APOSTOU !== '0';
// Teto de cartas representadas na observação e no espaço de ação de aposta
// — tem que bater com MAX_HAND em training/python/model.py. O jogo raramente
// chega perto disso (hp=3 e diferença>=1 é comum, então a partida costuma
// acabar em poucas rodadas); se algum dia estourar, as cartas excedentes
// simplesmente não entram na observação — aceitável pra este experimento.
const MAX_HAND = 12;
const MAX_APOSTA = MAX_HAND;
const NUM_RANKS = 10;  // Carta.valorInt vai de 0 a 9
const NUM_NAIPES = 4;
const WIN_BONUS = 5;
const LOSE_BONUS = -1;

// Nunca deve disparar durante treino — Python sempre responde antes disso.
// Só existe pra o timer interno do GameController não segurar a promise
// pra sempre (e olha que ele já dá .unref(), então nem segura o processo).
const TEMPO_TURNO_MS = 1000 * 60 * 60 * 24;

// --- fila de linhas de stdin: permite `await proximaLinha()` de qualquer lugar ---
const linhasPendentes = [];
const esperando = [];
createInterface({ input: process.stdin, terminal: false }).on('line', (linha) => {
    if (esperando.length > 0) esperando.shift()(linha);
    else linhasPendentes.push(linha);
});
function proximaLinha() {
    if (linhasPendentes.length > 0) return Promise.resolve(linhasPendentes.shift());
    return new Promise((resolve) => esperando.push(resolve));
}

function enviar(msg) {
    process.stdout.write(JSON.stringify(msg) + '\n');
}

async function pedirAcao(msg) {
    enviar({ ...msg, actionRequired: true });
    const { action } = JSON.parse(await proximaLinha());
    return action;
}

// --- codificação de estado: tudo vira número, a estratégia fica por conta da rede ---

function codificarCarta(carta, viraValor) {
    return [
        carta.valorInt / (NUM_RANKS - 1),
        carta.naipeInt / (NUM_NAIPES - 1),
        carta.valorInt === viraValor ? 1 : 0,
    ];
}
const CARTA_VAZIA = [0, 0, 0];

function codificarMao(mao, viraValor) {
    const out = [];
    for (let i = 0; i < MAX_HAND; i++) out.push(...(i < mao.length ? codificarCarta(mao[i], viraValor) : CARTA_VAZIA));
    return out;
}

// Observação sempre relativa a quem está decidindo ("eu, o próximo, o
// próximo depois dele...") pra a mesma rede servir qualquer assento em
// self-play sem precisar aprender "eu sou o assento 2" como parte do estado.
function ordemRelativa(jogadores, euId) {
    const indice = jogadores.findIndex(j => j.id === euId);
    const n = jogadores.length;
    const ordem = [];
    for (let i = 0; i < n; i++) ordem.push(jogadores[(indice + i) % n]);
    return ordem;
}

function codificarMesa(mesaAtiva, ordemRel, viraValor) {
    const jogadasPorId = new Map((mesaAtiva?.cartasNaMesa ?? []).map(j => [j.jogador.id, j.carta]));
    const out = [];
    for (const jogador of ordemRel) {
        const carta = jogadasPorId.get(jogador.id);
        out.push(...(carta ? codificarCarta(carta, viraValor) : CARTA_VAZIA), carta ? 1 : 0);
    }
    return out;
}

// `apostaram` (Set de ids) diz quem já apostou NESTA rodada — sem isso,
// `aposta === 0` fica ambíguo entre "ainda não decidiu" e "decidiu que é
// zero" pra quem ainda não teve seu turnoAposta (ver jogarEpisodio, que
// zera o Set a cada novaRodadaIniciada e adiciona o id logo depois de cada
// resposta de aposta).
function construirObs(controller, jogador, apostaram) {
    const rodada = controller.rodada;
    const ordemRel = ordemRelativa(controller.jogadores, jogador.id);

    const hpApostaSteak = [];
    for (const j of ordemRel) {
        hpApostaSteak.push(j.hp / 3, j.aposta / MAX_APOSTA, j.steak / MAX_HAND);
        if (COM_FLAG_APOSTOU) hpApostaSteak.push(apostaram.has(j.id) ? 1 : 0);
    }

    return {
        mao: codificarMao(jogador.mao, rodada.viraValor),
        mesa: codificarMesa(rodada.mesaAtiva, ordemRel, rodada.viraValor),
        hpApostaSteak,
        viraValor: rodada.viraValor / (NUM_RANKS - 1),
        cartasRodada: rodada.round / MAX_HAND,
    };
}

// --- máscaras de ação legal: estrutura do jogo, não estratégia (ver PROTOCOLO.md) ---

function somaApostasDosOutros(rodada, jogador) {
    return rodada.gameOrder.reduce((soma, j) => (j === jogador ? soma : soma + j.aposta), 0);
}
function ehUltimoAApostar(rodada, jogador) {
    const ordem = rodada.gameOrder;
    return ordem[ordem.length - 1] === jogador;
}
// Espelha a validação de GameController.apostar (valor 0..numCartas, e pro
// último a apostar, não pode fechar a soma) — a checagem de verdade continua
// dentro do GameController; isto é só o mesmo cálculo, feito de fora, pra
// poder mascarar a ação antes de perguntar pro Python (ver discussão sobre
// não gastar treino em restrição estrutural).
function maskAposta(rodada, jogador) {
    const numCartas = rodada.round;
    const proibido = ehUltimoAApostar(rodada, jogador) ? numCartas - somaApostasDosOutros(rodada, jogador) : null;
    const mask = new Array(MAX_APOSTA + 1).fill(0);
    for (let v = 0; v <= Math.min(numCartas, MAX_APOSTA); v++) {
        if (v !== proibido) mask[v] = 1;
    }
    return mask;
}
function maskCarta(tamanhoMao) {
    const mask = new Array(MAX_HAND).fill(0);
    for (let i = 0; i < Math.min(tamanhoMao, MAX_HAND); i++) mask[i] = 1;
    return mask;
}

// --- um episódio inteiro (uma partida de 4 assentos) ---

async function jogarEpisodio(numeroEpisodio) {
    const jogadoresBase = [];
    for (let i = 0; i < NUM_SEATS; i++) {
        const p = new Player(`agente${i}`, null);
        p.id = i;
        jogadoresBase.push(p);
    }

    const controller = new GameController({
        numberPlayers: NUM_SEATS,
        roundStart: ROUND_START,
        tempoTurnoMs: TEMPO_TURNO_MS,
        atrasoBotMs: 0,
    });

    // Reward acumulado desde a última mensagem enviada pra cada assento —
    // flusha (e zera) toda vez que mandamos um novo `step` pra ele.
    const pendente = new Array(NUM_SEATS).fill(0);
    // Métricas exatas da partida. O treino atual ignora esses campos extras,
    // mas o avaliador usa o resumo final para não inferir erro de aposta de
    // mensagens de reward (que também podem ser zero em outros turnos).
    const metricasPorSeat = Array.from({ length: NUM_SEATS }, (_, seat) => ({
        seat,
        rodadasJogadas: 0,
        apostasExatas: 0,
        erroAbsolutoTotal: 0,
        totalApostado: 0,
        totalVazas: 0,
    }));
    let vencedorId = null;
    const fimDeJogo = new Promise((resolve) => {
        controller.on('jogoFinalizado', ({ vencedor }) => {
            vencedorId = controller.jogadores.find(j => j.nome === vencedor).id;
            resolve();
        });
    });

    controller.on('rodadaFinalizada', ({ resultado }) => {
        for (const { nome, aposta, steak, diferenca } of resultado) {
            const jogador = controller.jogadores.find(j => j.nome === nome);
            pendente[jogador.id] += -diferenca;
            const metricas = metricasPorSeat[jogador.id];
            metricas.rodadasJogadas += 1;
            metricas.apostasExatas += diferenca === 0 ? 1 : 0;
            metricas.erroAbsolutoTotal += diferenca;
            metricas.totalApostado += aposta;
            metricas.totalVazas += steak;
        }
    });

    // Quem já apostou nesta rodada — zera a cada rodada nova, antes de
    // qualquer turnoAposta dela (ver construirObs).
    let apostaram = new Set();
    controller.on('novaRodadaIniciada', () => { apostaram = new Set(); });

    controller.on('turnoAposta', async ({ id }) => {
        const jogador = controller.jogadores.find(j => j.id === id);
        const reward = pendente[id]; pendente[id] = 0;
        const action = await pedirAcao({
            type: 'step', episode: numeroEpisodio, seat: id, kind: 'aposta',
            reward, done: false,
            obs: construirObs(controller, jogador, apostaram), legalMask: maskAposta(controller.rodada, jogador),
        });
        apostaram.add(id);
        const resultado = controller.apostar(id, action);
        if (!resultado.ok) throw new Error(`aposta inválida do assento ${id}: ${resultado.motivo} (ação=${action})`);
    });

    controller.on('turnoJogador', async ({ id }) => {
        const jogador = controller.jogadores.find(j => j.id === id);
        const reward = pendente[id]; pendente[id] = 0;
        const action = await pedirAcao({
            type: 'step', episode: numeroEpisodio, seat: id, kind: 'carta',
            reward, done: false,
            obs: construirObs(controller, jogador, apostaram), legalMask: maskCarta(jogador.mao.length),
        });
        const resultado = controller.jogarCarta(id, action);
        if (!resultado.ok) throw new Error(`carta inválida do assento ${id}: ${resultado.motivo} (ação=${action})`);
    });

    jogadoresBase.forEach(j => controller.entrarNaSala(j));
    controller.iniciarPartida();
    await fimDeJogo;

    // Ninguém mais vai receber turnoAposta/turnoJogador neste episódio —
    // manda o reward pendente de cada assento (incluindo quem já tinha sido
    // eliminado antes) junto com o bônus terminal de vencer/perder, mais um
    // resumo legível pra quem quiser acompanhar o progresso sem decodificar
    // observação (ver training/python/train.py --render-every).
    const resumo = {
        vencedor: vencedorId,
        rodadas: controller.numeroRodada,
        hpFinal: controller.jogadores.map(j => j.hp),
        metricasPorSeat,
    };
    for (let seat = 0; seat < NUM_SEATS; seat++) {
        const bonus = seat === vencedorId ? WIN_BONUS : LOSE_BONUS;
        enviar({
            type: 'step', episode: numeroEpisodio, seat, kind: 'final',
            reward: pendente[seat] + bonus, done: true, actionRequired: false,
            obs: null, legalMask: null, resumo,
        });
    }
}

let episodio = 0;
// eslint-disable-next-line no-constant-condition
while (true) {
    await jogarEpisodio(episodio);
    episodio++;
}

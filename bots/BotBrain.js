// BotBrain.js
// Cerebro dos bots. E o UNICO lugar do projeto que decide uma jogada
// automatica: turno de um Bot de verdade e timeout de jogador real
// desconectado passam os dois por aqui (ver PlayerGame.bot e
// game/GameController.js). GameController nao sabe nem precisa saber como a
// decisao foi tomada -- so passa `jogador` e, agora, o `controller` pra dar
// acesso ao estado da rodada (mao dos outros na rodada cega, mesa, manilha,
// memoria de cartas). Sem `controller` (ou se os modelos nao carregarem) cai
// no heuristico burro de sempre.
//
// Estrategia atual: duas redes treinadas por self-play/RL (training/), com
// os pesos exportados pra bots/models/*.json (ver training/python/
// export_weights.py) e o forward pass reimplementado em JS puro (bots/nn.js):
//   - round 1 (rodada cega, aposta 0/1 sem ver a propria carta): round1.json
//   - round >= 2 (aposta e escolha de carta): noite1.json
// A escolha de carta no round 1 e forcada (1 carta so), nao usa rede.
import { RedeAtorCritico, argmaxMascarado } from './nn.js';

const MAX_HAND = 12;      // teto de cartas na observacao / espaco de aposta (== MAX_HAND do treino)
const MAX_APOSTA = MAX_HAND;
const NUM_RANKS = 10;
const NUM_NAIPES = 4;

// --- carrega os modelos uma vez; falha vira "sem modelo", nunca derruba o servidor ---
let REDE_NOITE = null;
let REDE_ROUND1 = null;
try {
    REDE_NOITE = RedeAtorCritico.carregar('noite1.json');
    REDE_ROUND1 = RedeAtorCritico.carregar('round1.json');
} catch (erro) {
    console.warn(`[BotBrain] modelos nao carregados (${erro.message}) -- usando heuristico burro`);
    REDE_NOITE = null;
    REDE_ROUND1 = null;
}

// --- codificacao de estado (porte fiel de training/env_bridge.js:construirObs
//     e training/python/harness_round1.py:construir_obs_round1) ---

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
    for (let i = 0; i < MAX_HAND; i++) {
        out.push(...(i < mao.length ? codificarCarta(mao[i], viraValor) : CARTA_VAZIA));
    }
    return out;
}

// Ordem sempre relativa a quem decide ("eu, o proximo, ...") pela ordem de
// assento fixa (controller.jogadores), nao pela gameOrder que gira por rodada.
function ordemRelativa(jogadores, euId) {
    const n = jogadores.length;
    const indice = jogadores.findIndex(j => j.id === euId);
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

function codificarMemoria(cartasJogadas) {
    const out = new Array(NUM_RANKS * NUM_NAIPES).fill(0);
    for (const chave of cartasJogadas) out[chave] = 1;
    return out;
}

// Set de ids que ja apostaram nesta rodada. Aposta acontece em ordem de
// rodada.gameOrder: quem vem antes de `jogador` ja apostou, o resto (e ele
// mesmo) nao. Na fase de carta, todos ja apostaram.
function idsQueApostaram(controller, jogador, faseAposta) {
    const ordem = controller.rodada.gameOrder;
    if (!faseAposta) return new Set(ordem.map(j => j.id));
    const meuIndice = ordem.findIndex(j => j === jogador);
    return new Set(ordem.slice(0, meuIndice < 0 ? 0 : meuIndice).map(j => j.id));
}

function construirObs110(controller, jogador, faseAposta) {
    const rodada = controller.rodada;
    const ordemRel = ordemRelativa(controller.jogadores, jogador.id);
    const apostaram = idsQueApostaram(controller, jogador, faseAposta);
    const cartasJogadas = controller._cartasJogadasRodada ?? new Set();

    const hpApostaSteak = [];
    for (const j of ordemRel) {
        hpApostaSteak.push(j.hp / 3, j.aposta / MAX_APOSTA, j.steak / MAX_HAND, apostaram.has(j.id) ? 1 : 0);
    }

    return [
        ...codificarMao(jogador.mao, rodada.viraValor),
        ...codificarMesa(rodada.mesaAtiva, ordemRel, rodada.viraValor),
        ...hpApostaSteak,
        rodada.viraValor / (NUM_RANKS - 1),
        rodada.round / MAX_HAND,
        ...codificarMemoria(cartasJogadas),
    ];
}

// Round 1 (rodada cega): ve as 3 cartas dos outros, nao a propria.
function construirObsRound1(controller, jogador) {
    const rodada = controller.rodada;
    const ordemRel = ordemRelativa(controller.jogadores, jogador.id);
    const apostaram = idsQueApostaram(controller, jogador, true);

    const vec = [];
    for (const outro of ordemRel.slice(1)) {
        vec.push(...codificarCarta(outro.mao[0], rodada.viraValor));
    }
    for (const j of ordemRel) {
        vec.push(j.hp / 3, j.aposta / 1, apostaram.has(j.id) ? 1 : 0);
    }
    vec.push(rodada.viraValor / (NUM_RANKS - 1));
    return vec;
}

// --- mascaras de acao legal (mesma regra estrutural de env_bridge / GameController) ---

function maskAposta(rodada, jogador) {
    const numCartas = rodada.round;
    const somaOutros = rodada.gameOrder.reduce((s, j) => (j === jogador ? s : s + j.aposta), 0);
    const ehUltimo = rodada.gameOrder[rodada.gameOrder.length - 1] === jogador;
    const proibido = ehUltimo ? numCartas - somaOutros : null;
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

// --- ponto de plugue: as duas funcoes que o GameController chama ---

// Indice (0-based) da carta escolhida na mao do jogador.
export function escolherCarta(jogador, controller) {
    const heuristico = () => jogador.mao.length - 1;
    if (!REDE_NOITE || !controller?.rodada) return heuristico();
    // Round 1 tem 1 carta: jogada forcada, nao gasta rede.
    if (controller.rodada.round === 1 || jogador.mao.length <= 1) return 0;
    try {
        const obs = construirObs110(controller, jogador, false);
        const logits = REDE_NOITE.logitsCarta(obs);
        const escolha = argmaxMascarado(logits, maskCarta(jogador.mao.length));
        return escolha >= 0 && escolha < jogador.mao.length ? escolha : heuristico();
    } catch (erro) {
        console.warn(`[BotBrain] escolherCarta caiu no heuristico: ${erro.message}`);
        return heuristico();
    }
}

// `permiteAposta1` vem do GameController (so ele sabe as apostas ja feitas):
// false quando apostar 1 fecharia a soma da rodada no numero de cartas (regra
// do ultimo a apostar). Devolve o valor apostado (== indice da acao).
export function escolherAposta(jogador, { permiteAposta1, controller } = {}) {
    const heuristico = () => (permiteAposta1 ? 1 : 0);
    if (!controller?.rodada) return heuristico();

    try {
        if (controller.rodada.round === 1) {
            if (!REDE_ROUND1) return heuristico();
            const obs = construirObsRound1(controller, jogador);
            const logits = REDE_ROUND1.logitsAposta(obs);
            const mask = [1, permiteAposta1 ? 1 : 0];
            const escolha = argmaxMascarado(logits, mask);
            return escolha >= 0 ? escolha : heuristico();
        }
        if (!REDE_NOITE) return heuristico();
        const obs = construirObs110(controller, jogador, true);
        const logits = REDE_NOITE.logitsAposta(obs);
        const escolha = argmaxMascarado(logits, maskAposta(controller.rodada, jogador));
        return escolha >= 0 ? escolha : heuristico();
    } catch (erro) {
        console.warn(`[BotBrain] escolherAposta caiu no heuristico: ${erro.message}`);
        return heuristico();
    }
}

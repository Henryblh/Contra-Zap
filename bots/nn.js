// nn.js
// Forward pass minimalista das redes de treino (training/python/model.py e
// model_round1.py), reimplementado em JS puro pra rodar dentro do servidor
// sem torch. As redes sao pequenas (tronco de 2 Linear+ReLU e cabecas
// lineares), entao um loop de multiplicacao de matriz resolve.
//
// Os .json vem de training/python/export_weights.py. Formato:
//   { obs_dim, hidden, trunk0_w:[hidden][obs_dim], trunk0_b:[hidden],
//     trunk2_w:[hidden][hidden], trunk2_b:[hidden],
//     aposta_w, aposta_b, value_w, value_b, (carta_w, carta_b) }
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const AQUI = dirname(fileURLToPath(import.meta.url));

// y = W x + b, com W no layout [out][in] (mesmo do nn.Linear.weight do torch).
function linear(x, W, b) {
    const out = new Array(W.length);
    for (let o = 0; o < W.length; o++) {
        const linha = W[o];
        let soma = b[o];
        for (let i = 0; i < linha.length; i++) soma += linha[i] * x[i];
        out[o] = soma;
    }
    return out;
}

function reluInplace(v) {
    for (let i = 0; i < v.length; i++) if (v[i] < 0) v[i] = 0;
    return v;
}

export class RedeAtorCritico {
    constructor(dados) {
        this.obsDim = dados.obs_dim;
        this.hidden = dados.hidden;
        this.t0w = dados.trunk0_w; this.t0b = dados.trunk0_b;
        this.t2w = dados.trunk2_w; this.t2b = dados.trunk2_b;
        this.apw = dados.aposta_w; this.apb = dados.aposta_b;
        this.caw = dados.carta_w ?? null; this.cab = dados.carta_b ?? null;
        this.fonte = dados.fonte ?? null;
    }

    static carregar(nomeArquivo) {
        const caminho = join(AQUI, 'models', nomeArquivo);
        return new RedeAtorCritico(JSON.parse(readFileSync(caminho, 'utf-8')));
    }

    _tronco(obs) {
        if (obs.length !== this.obsDim) {
            throw new Error(`obs de ${obs.length} valores, rede espera ${this.obsDim}`);
        }
        const h1 = reluInplace(linear(obs, this.t0w, this.t0b));
        return reluInplace(linear(h1, this.t2w, this.t2b));
    }

    // logits crus da cabeca de aposta (indice = valor apostado).
    logitsAposta(obs) {
        return linear(this._tronco(obs), this.apw, this.apb);
    }

    // logits crus da cabeca de carta (indice = posicao na mao). Null se a
    // rede nao tem cabeca de carta (a de round 1 nao tem).
    logitsCarta(obs) {
        if (!this.caw) return null;
        return linear(this._tronco(obs), this.caw, this.cab);
    }
}

// argmax so entre indices com mask[i] verdadeiro. -1 se nada e legal.
export function argmaxMascarado(logits, mask) {
    let melhor = -1;
    let melhorValor = -Infinity;
    for (let i = 0; i < logits.length; i++) {
        if (mask[i] && logits[i] > melhorValor) {
            melhorValor = logits[i];
            melhor = i;
        }
    }
    return melhor;
}

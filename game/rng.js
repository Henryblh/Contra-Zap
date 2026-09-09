// rng.js
// Fonte de aleatoriedade dos embaralhamentos (Game.setstartsequence,
// Baralho.embaralharArray). Sem seed, é o Math.random de sempre — nada muda.
// COM seed, é um PRNG determinístico (mulberry32): mesma seed = mesma
// sequência de embaralhamentos, então uma partida vira reproduzível pra
// debug e pra teste de paridade com o motor Python (training/python/motor/
// rng.py usa exatamente o mesmo algoritmo).
//
// mulberry32 é o mesmo gerador que training/env_bridge.js já usava pra fixar
// EVAL_SEED (mesma constante 0x6D2B79F5) — runs antigos com EVAL_SEED
// continuam produzindo a mesma sequência.

// Devolve uma função () => number em [0, 1), igual em contrato ao Math.random.
// `seed` null/undefined => o próprio Math.random (comportamento de hoje).
export function criarRng(seed) {
    if (seed === null || seed === undefined) return Math.random;

    let estado = seed >>> 0;
    return () => {
        estado = (estado + 0x6D2B79F5) >>> 0;
        let t = estado;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
    };
}

// Fisher-Yates in-place usando o rng dado. Extraído pra Game e Baralho
// embaralharem do mesmo jeito (e o motor Python fazer bit a bit igual).
export function embaralharComRng(array, rng) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
}

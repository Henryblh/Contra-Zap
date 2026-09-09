# rng.py -- espelho de game/rng.js. Fonte de aleatoriedade dos
# embaralhamentos (jogo.set_start_sequence, baralho._montar_baralhos).
#
# Sem seed: usa o modulo `random` global -- comportamento historico do motor
# Python, nada muda no treino. COM seed: mulberry32 deterministico, o MESMO
# algoritmo de game/rng.js e da mesma constante 0x6D2B79F5, entao a mesma
# seed produz a MESMA sequencia de embaralhamentos nos dois motores (base pro
# teste de paridade JS x Python -- item 41 do README).
import random

_MASK32 = 0xFFFFFFFF


def criar_rng(seed):
    """Devolve uma funcao () -> float em [0, 1). seed None => random.random."""
    if seed is None:
        return random.random

    estado = seed & _MASK32

    def proximo():
        nonlocal estado
        estado = (estado + 0x6D2B79F5) & _MASK32
        t = estado
        t = (t ^ (t >> 15)) * (t | 1) & _MASK32
        t ^= (t + ((t ^ (t >> 7)) * (t | 61) & _MASK32)) & _MASK32
        t &= _MASK32
        return ((t ^ (t >> 14)) & _MASK32) / 4294967296.0

    return proximo


def embaralhar_com_rng(lista, rng):
    """Fisher-Yates in-place, bit a bit igual a embaralharComRng de game/rng.js."""
    for i in range(len(lista) - 1, 0, -1):
        j = int(rng() * (i + 1))
        lista[i], lista[j] = lista[j], lista[i]
    return lista

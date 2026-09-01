# baralho.py -- porte direto de game/Baralho.js. A ordem de naipe/valor e a
# lógica de "misturar cada baralho e empilhar o mais novo por cima" (quando
# randomShuffle=False) é copiada tal e qual -- muda o resultado de quem
# compra o quê primeiro, então não é detalhe cosmético.
import random

from .carta import Carta

NAIPES = {"Ouros": 0, "Espadas": 1, "Copas": 2, "Paus": 3}
VALORES = {"4": 0, "5": 1, "6": 2, "7": 3, "Q": 4, "J": 5, "K": 6, "A": 7, "2": 8, "3": 9}


class Baralho:
    def __init__(self, numbaralho, random_shuffle):
        self.numbaralho = numbaralho
        self.random_shuffle = random_shuffle
        self.cartas = []
        self._montar_baralhos()

    def _construir_um_baralho(self, id_inicial, numero_baralho):
        deck = []
        id_carta = id_inicial
        for nome_naipe, naipe_int in NAIPES.items():
            for nome_valor, valor_int in VALORES.items():
                deck.append(Carta(id_carta, naipe_int, valor_int, nome_naipe, nome_valor, numero_baralho))
                id_carta += 1
        return deck

    def _montar_baralhos(self):
        id_geral = 0
        for b in range(self.numbaralho):
            deck_atual = self._construir_um_baralho(id_geral, b + 1)
            id_geral += 40
            if not self.random_shuffle:
                random.shuffle(deck_atual)
                self.cartas = deck_atual + self.cartas
            else:
                self.cartas = self.cartas + deck_atual
        if self.random_shuffle:
            random.shuffle(self.cartas)

    def comprar(self):
        if not self.cartas:
            return None
        return self.cartas.pop()

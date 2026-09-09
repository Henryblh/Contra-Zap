# baralho.py -- porte direto de game/Baralho.js. A ordem de naipe/valor e a
# lógica de "misturar cada baralho e empilhar o mais novo por cima" (quando
# randomShuffle=False) é copiada tal e qual -- muda o resultado de quem
# compra o quê primeiro, então não é detalhe cosmético.
import random

from .carta import Carta
from .rng import embaralhar_com_rng

# Listas [nome, int] (não dict) pra a ordem de construção do monte ser
# EXATAMENTE esta nos dois motores -- game/Baralho.js usa array pelo mesmo
# motivo (num objeto, JS reordenaria '4','5',...,'2','3' pra ordem numérica).
# Só importa quando há seed (ver rng.py): a mesma seed reproduz a mesma
# partida em JS e Python só se o monte pré-embaralho for idêntico.
NAIPES = [("Ouros", 0), ("Espadas", 1), ("Copas", 2), ("Paus", 3)]
VALORES = [("4", 0), ("5", 1), ("6", 2), ("7", 3), ("Q", 4), ("J", 5), ("K", 6), ("A", 7), ("2", 8), ("3", 9)]


class Baralho:
    def __init__(self, numbaralho, random_shuffle, rng=None):
        self.numbaralho = numbaralho
        self.random_shuffle = random_shuffle
        # rng None => embaralha com random.shuffle (comportamento historico).
        # rng dado (Jogo com seed) => Fisher-Yates explicito bit a bit igual ao
        # de game/Baralho.js, pra a seed reproduzir a mesma sequencia nos dois
        # motores.
        self.rng = rng
        self.cartas = []
        self._montar_baralhos()

    def _embaralhar(self, lista):
        if self.rng is None:
            random.shuffle(lista)
        else:
            embaralhar_com_rng(lista, self.rng)

    def _construir_um_baralho(self, id_inicial, numero_baralho):
        deck = []
        id_carta = id_inicial
        for nome_naipe, naipe_int in NAIPES:
            for nome_valor, valor_int in VALORES:
                deck.append(Carta(id_carta, naipe_int, valor_int, nome_naipe, nome_valor, numero_baralho))
                id_carta += 1
        return deck

    def _montar_baralhos(self):
        id_geral = 0
        for b in range(self.numbaralho):
            deck_atual = self._construir_um_baralho(id_geral, b + 1)
            id_geral += 40
            if not self.random_shuffle:
                self._embaralhar(deck_atual)
                self.cartas = deck_atual + self.cartas
            else:
                self.cartas = self.cartas + deck_atual
        if self.random_shuffle:
            self._embaralhar(self.cartas)

    def comprar(self):
        # Espelha game/Baralho.js: baralho vazio NUNCA é situação normal (o
        # monte é dimensionado exato pra rodada -- ver rodada.py). Se chegou
        # aqui, o cálculo de num_cards/num_baralho quebrou -- é bug, levanta
        # pra parar tudo com contexto em vez de devolver None.
        if not self.cartas:
            raise RuntimeError(
                f"Baralho vazio ao comprar carta ({self.numbaralho} baralho(s) = "
                f"{self.numbaralho * 40} cartas montadas). Erro no cálculo de "
                f"num_cards/num_baralho em Rodada."
            )
        return self.cartas.pop()

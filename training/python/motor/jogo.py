# jogo.py -- porte direto de game/Game.js: quantos jogadores, ordem de
# assento inicial (embaralhada de verdade, não só quem começa), girar quem
# inicia a cada rodada pulando quem já foi eliminado, e avançar pra próxima
# rodada (mão cresce 1 carta por vez, nunca desce -- mesmo formato do jogo
# de verdade, não é a "pirâmide" clássica de fodinha).
import math
import random

from .rodada import Rodada

# Teto de baralhos tratado como "Sem Limite" (game/Game.js: MAX_DECK_SEM_LIMITE).
MAX_DECK_SEM_LIMITE = 50


def baralhos_necessarios(num_jogadores, round_):
    # numCards = jogadores*round + 1 (o +1 é a vira), ver rodada.py.
    return math.ceil((num_jogadores * round_ + 1) / 40)


class Jogo:
    def __init__(self, number_players, round_start, random_shuffle, jogadores,
                 max_deck=MAX_DECK_SEM_LIMITE):
        self.number_players = number_players
        self.round_start = round_start
        self.random_shuffle = random_shuffle
        self.jogadores = jogadores
        # Máximo de baralhos de 40 cartas por rodada. Enquanto a próxima
        # rodada (mão maior) não couber, `round` não cresce -- ver
        # proxima_rodada().
        self.max_deck = max_deck
        self.round = round_start
        self.game_order = []
        self.ordem_original = []
        self.starter_index = 0

    def set_start_sequence(self):
        self.game_order = list(self.jogadores)
        random.shuffle(self.game_order)
        self.ordem_original = list(self.game_order)
        self.starter_index = 0

    def eliminar_zerados(self):
        return [j for j in self.game_order if j.hp <= 0]

    def girar_ordem(self):
        # O próximo jogador VIVO depois de quem abriu a rodada anterior, na
        # ordem original. ordem_original nunca encolhe (mortos seguem ocupando
        # slot); avançar só com (starter_index + 1) % n cairia em slot de
        # morto e o vivo seguinte acabava abrindo duas rodadas em sequência.
        # Por isso: anda pelo menos 1 e pula slots de mortos até parar num
        # vivo (limitado a n passos; "só sobrou 1 vivo" nem chega aqui).
        n = len(self.ordem_original)
        for _ in range(n):
            self.starter_index = (self.starter_index + 1) % n
            if self.ordem_original[self.starter_index].hp > 0:
                break
        self.game_order = [
            self.ordem_original[(self.starter_index + i) % n]
            for i in range(n)
            if self.ordem_original[(self.starter_index + i) % n].hp > 0
        ]

    def nova_rodada(self):
        return Rodada(self.game_order, self.round, self.random_shuffle)

    def proxima_rodada(self):
        # A mão cresce +1 por rodada, mas só se a próxima rodada ainda couber
        # em max_deck baralhos. Se não couber, `round` fica congelado até
        # alguém morrer (menos jogadores = menos cartas na mesa = volta a
        # caber). Nunca diminui, nunca "pula" pra recuperar o atraso.
        vivos = len(self.game_order)  # já filtrado por girar_ordem()
        if baralhos_necessarios(vivos, self.round + 1) <= self.max_deck:
            self.round += 1
        return self.nova_rodada()

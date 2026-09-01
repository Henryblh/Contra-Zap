# jogo.py -- porte direto de game/Game.js: quantos jogadores, ordem de
# assento inicial (embaralhada de verdade, não só quem começa), girar quem
# inicia a cada rodada pulando quem já foi eliminado, e avançar pra próxima
# rodada (mão cresce 1 carta por vez, nunca desce -- mesmo formato do jogo
# de verdade, não é a "pirâmide" clássica de fodinha).
import random

from .rodada import Rodada


class Jogo:
    def __init__(self, number_players, round_start, random_shuffle, jogadores):
        self.number_players = number_players
        self.round_start = round_start
        self.random_shuffle = random_shuffle
        self.jogadores = jogadores
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
        n = len(self.ordem_original)
        self.starter_index = (self.starter_index + 1) % n
        self.game_order = [
            self.ordem_original[(self.starter_index + i) % n]
            for i in range(n)
            if self.ordem_original[(self.starter_index + i) % n].hp > 0
        ]

    def nova_rodada(self):
        return Rodada(self.game_order, self.round, self.random_shuffle)

    def proxima_rodada(self):
        self.round += 1
        return self.nova_rodada()

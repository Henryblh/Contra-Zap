# rodada.py -- porte direto de game/Rodada.js (RodadaGame): distribuir
# cartas, virar manilha, ordem da vaza, fechar vaza/rodada e a perda de hp
# (|aposta - steak|). Igual ao original, `num_baralho` cresce sozinho quando
# a rodada precisa de mais de 40 cartas (jogo grande/rodada avançada).
import math

from .baralho import Baralho
from .mesa import Mesa


class Rodada:
    def __init__(self, game_order, round_, random_shuffle):
        self.game_order = game_order
        self.round = round_
        self.random_shuffle = random_shuffle
        # jogadores vivos * cartas por mão + 1 pra vira. num_cards é o total
        # exato consumido na rodada (dar_cartas + virar_manilha).
        num_cards = (len(game_order) * round_) + 1
        # ceil: menor nº de baralhos de 40 que cobre num_cards. (num_cards // 40) + 1
        # (o que estava aqui) alocava um baralho a mais quando num_cards era
        # múltiplo exato de 40.
        num_baralho = math.ceil(num_cards / 40)

        # Fail-fast: o monte TEM que caber a rodada exata. Se não cabe, algo
        # fora daqui está quebrado (game_order/round corrompido, ou a conta
        # acima) -- para na construção da Rodada, antes de distribuir carta.
        if num_baralho * 40 < num_cards:
            raise RuntimeError(
                f"Rodada impossível: {len(game_order)} jogador(es) x {round_} "
                f"carta(s) + vira = {num_cards} cartas, mas só {num_baralho * 40} "
                f"disponíveis ({num_baralho} baralho(s))."
            )

        self.baralho = Baralho(num_baralho, random_shuffle)
        self.vira = None
        self.vira_valor = -1
        self.mesa_ativa = None
        self.indice_inicial = 0  # índice em game_order de quem inicia a vaza atual

    def dar_cartas(self):
        # baralho.comprar() levanta se o monte esvaziar (situação
        # extraordinária, ver baralho.py) -- não precisa checar None aqui.
        for jogador in self.game_order:
            for _ in range(self.round):
                jogador.mao.append(self.baralho.comprar())

    def virar_manilha(self):
        # comprar() levanta se não houver carta pra vira (ver baralho.py) --
        # self.vira nunca é None aqui.
        self.vira = self.baralho.comprar()
        self.vira_valor = 0 if self.vira.valor_int == 9 else self.vira.valor_int + 1
        self.nova_vaza()

    def nova_vaza(self):
        self.mesa_ativa = Mesa(self.vira_valor)

    def ordem_da_vaza(self):
        n = len(self.game_order)
        return [self.game_order[(self.indice_inicial + i) % n] for i in range(n)]

    def registrar_jogada(self, jogador, carta):
        self.mesa_ativa.receber_carta(carta, jogador)

    def finalizar_vaza(self):
        vencedor = self.mesa_ativa.melhor_jogada[1] if self.mesa_ativa.melhor_jogada else None
        if vencedor:
            vencedor.steak += 1
            self.indice_inicial = self.game_order.index(vencedor)
        return vencedor

    def finalizar_rodada(self):
        for jogador in self.game_order:
            diferenca = abs(jogador.aposta - jogador.steak)
            jogador.hp -= diferenca

    def resetar_apostas_steaks(self):
        for jogador in self.game_order:
            jogador.aposta = 0
            jogador.steak = 0

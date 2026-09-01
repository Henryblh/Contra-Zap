# rodada.py -- porte direto de game/Rodada.js (RodadaGame): distribuir
# cartas, virar manilha, ordem da vaza, fechar vaza/rodada e a perda de hp
# (|aposta - steak|). Igual ao original, `numBaralho` cresce sozinho quando
# a rodada precisa de mais de 40 cartas (jogo grande/rodada avançada).
from .baralho import Baralho
from .mesa import Mesa


class Rodada:
    def __init__(self, game_order, round_, random_shuffle):
        self.game_order = game_order
        self.round = round_
        self.random_shuffle = random_shuffle
        num_cards = (len(game_order) * round_) + 1
        num_baralho = (num_cards // 40) + 1
        self.baralho = Baralho(num_baralho, random_shuffle)
        self.vira = None
        self.vira_valor = -1
        self.mesa_ativa = None
        self.indice_inicial = 0  # índice em game_order de quem inicia a vaza atual

    def dar_cartas(self):
        for jogador in self.game_order:
            for _ in range(self.round):
                carta = self.baralho.comprar()
                if carta:
                    jogador.mao.append(carta)

    def virar_manilha(self):
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

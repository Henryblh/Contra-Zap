# mesa.py -- porte direto de game/Mesa.js: quem ganha a vaza. É o coração da
# regra do jogo (manilha bate tudo, naipe só desempata entre manilhas,
# cartas repetidas se anulam -- "melado"). Sem toString/status de UI, que só
# existiam pra exibição no cliente.
class Mesa:
    def __init__(self, vira_valor):
        self.vira_valor = vira_valor
        self.cartas_na_mesa = []   # lista de (carta, jogador), na ordem que foram jogadas
        self.melhor_jogada = None  # (carta, jogador) ou None se melado
        self.esta_empatado = False

    def receber_carta(self, carta, jogador):
        self.cartas_na_mesa.append((carta, jogador))
        self._recalcular_mesa()

    def _sao_identicas(self, c1, c2):
        if c1.valor_int != c2.valor_int:
            return False
        if c1.valor_int == self.vira_valor:
            # manilha só anula com naipe igual (caso de 2+ baralhos)
            return c1.naipe_int == c2.naipe_int
        return True

    def _comparar_forca(self, c1, c2):
        # > 0 se c1 é mais forte, < 0 se c2 é mais forte
        c1_manilha = c1.valor_int == self.vira_valor
        c2_manilha = c2.valor_int == self.vira_valor
        if c1_manilha and not c2_manilha:
            return 1
        if not c1_manilha and c2_manilha:
            return -1
        if c1_manilha and c2_manilha:
            return c1.naipe_int - c2.naipe_int
        return c1.valor_int - c2.valor_int

    def _recalcular_mesa(self):
        jogadas_validas = [
            jogada for jogada in self.cartas_na_mesa
            if sum(1 for outra in self.cartas_na_mesa if self._sao_identicas(jogada[0], outra[0])) == 1
        ]
        if not jogadas_validas:
            self.melhor_jogada = None
            self.esta_empatado = True
            return
        melhor = jogadas_validas[0]
        for desafiante in jogadas_validas[1:]:
            if self._comparar_forca(desafiante[0], melhor[0]) > 0:
                melhor = desafiante
        self.melhor_jogada = melhor
        self.esta_empatado = False

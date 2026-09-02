# partida.py -- o miolo de game/GameController.js, sem a parte de
# sala/socket/reconexão (isso é concern de conexão, não de regra -- ver
# discussão). O que sobra: distribuir a rodada inteira (aposta -> vazas ->
# hp), decidir fim de jogo/desempate, e validar aposta/carta exatamente como
# GameController.apostar()/jogarCarta() fazem hoje.
#
# Onde o JS usa await/Promise pra "pausar até alguém decidir", aqui é um
# generator: cada `yield` pausa a função exatamente no ponto da decisão até
# quem está chamando mandar a ação de volta com `.send(valor)`. Sem thread,
# sem subprocess, sem fila -- é tudo uma chamada de função no mesmo processo.
#
# Este arquivo NÃO sabe nada de reward, observação pra rede, ou self-play --
# isso é responsabilidade de quem consome o generator (o harness de treino),
# igual training/env_bridge.js hoje não reimplementa regra nenhuma, só fala
# com o GameController de verdade.
from .jogo import Jogo


class PlayerGame:
    # Só o que é estado de jogo de verdade -- sem senha/rate/bot/adm/
    # desconectado/reconexão, que são conceito de conta e conexão.
    def __init__(self, id_, nome, hp=3):
        self.id = id_
        self.nome = nome
        self.hp = hp
        self.steak = 0
        self.mao = []
        self.aposta = 0


class Partida:
    # `on_*` são o equivalente aos eventos do GameController (rodadaFinalizada,
    # jogoFinalizado, novaRodadaIniciada) -- fatos que o motor relata, sem
    # saber nada de reward/treino. Opcionais: None = não notifica ninguém.
    # `hp_inicial` é configurável pra dar cobertura de treino a diferentes
    # situações de hp (ver discussão sobre variar hp pra melhorar o fim de jogo).
    def __init__(self, number_players=4, round_start=3, random_shuffle=True, hp_inicial=3,
                 on_nova_rodada=None, on_rodada_finalizada=None, on_jogo_finalizado=None):
        self.jogadores = [PlayerGame(i, f"agente{i}", hp=hp_inicial) for i in range(number_players)]
        self.jogo = Jogo(number_players, round_start, random_shuffle, self.jogadores)
        self.rodada = None
        self.numero_rodada = 0
        self.finalizada = False
        self.vencedor = None
        self._on_nova_rodada = on_nova_rodada
        self._on_rodada_finalizada = on_rodada_finalizada
        self._on_jogo_finalizado = on_jogo_finalizado

    def _soma_apostas_dos_outros(self, jogador):
        return sum(j.aposta for j in self.rodada.game_order if j is not jogador)

    def _eh_ultimo_a_apostar(self, jogador):
        return self.rodada.game_order[-1] is jogador

    def _aplicar_aposta(self, jogador, valor):
        # Espelha GameController.apostar(): 0..numCartas, e pro último a
        # apostar, não pode fechar a soma no total de cartas da rodada.
        num_cartas = self.rodada.round
        if not isinstance(valor, int) or valor < 0 or valor > num_cartas:
            raise ValueError(f"aposta inválida do assento {jogador.id}: fora de 0..{num_cartas} (valor={valor!r})")
        if self._eh_ultimo_a_apostar(jogador) and self._soma_apostas_dos_outros(jogador) + valor == num_cartas:
            raise ValueError(f"aposta inválida do assento {jogador.id}: fecharia a soma da rodada (valor={valor})")
        jogador.aposta = valor

    def _aplicar_carta(self, jogador, indice):
        # Espelha GameController.jogarCarta(): índice tem que existir na mão.
        if not isinstance(indice, int) or indice < 0 or indice >= len(jogador.mao):
            raise ValueError(f"carta inválida do assento {jogador.id}: índice fora da mão (indice={indice!r}, mao={len(jogador.mao)})")
        carta = jogador.mao.pop(indice)
        self.rodada.registrar_jogada(jogador, carta)

    def jogar(self):
        """Generator: cada passo dá `yield ('aposta', jogador)` ou
        `yield ('carta', jogador)` e espera `.send(valor)` com a ação
        escolhida. Levanta ValueError se a ação enviada for inválida (mesma
        regra do motor de produção). Termina quando a partida acaba --
        depois disso, checar `self.finalizada`/`self.vencedor`."""
        self.jogo.set_start_sequence()
        self.numero_rodada = 1
        self.rodada = self.jogo.nova_rodada()
        yield from self._jogar_rodada_atual()

    def _jogar_rodada_atual(self):
        rodada = self.rodada
        if self._on_nova_rodada:
            self._on_nova_rodada(self.numero_rodada, rodada.round)
        rodada.dar_cartas()
        rodada.virar_manilha()

        # Ordem de aposta: um de cada vez, porque quem aposta depois pode
        # (e deve) ver o que os outros já apostaram -- não dá pra paralelizar.
        for jogador in rodada.game_order:
            valor = yield ("aposta", jogador)
            self._aplicar_aposta(jogador, valor)

        for v in range(rodada.round):
            if v > 0:
                rodada.nova_vaza()
            for jogador in rodada.ordem_da_vaza():
                indice = yield ("carta", jogador)
                self._aplicar_carta(jogador, indice)
            rodada.finalizar_vaza()

        rodada.finalizar_rodada()
        if self._on_rodada_finalizada:
            self._on_rodada_finalizada([
                {"jogador": j, "aposta": j.aposta, "steak": j.steak, "diferenca": abs(j.aposta - j.steak), "hp": j.hp}
                for j in rodada.game_order
            ])
        yield from self._avancar_ou_finalizar()

    def _avancar_ou_finalizar(self):
        vivos = [j for j in self.jogo.game_order if j.hp > 0]
        if len(vivos) == 1:
            self.finalizada = True
            self.vencedor = vivos[0]
            if self._on_jogo_finalizado:
                self._on_jogo_finalizado(self.vencedor)
            return
        if len(vivos) == 0:
            # Todos zeraram hp na mesma rodada: desempate por menor
            # diferença entre aposta e steak na última rodada.
            self.vencedor = min(self.rodada.game_order, key=lambda j: abs(j.aposta - j.steak))
            self.finalizada = True
            if self._on_jogo_finalizado:
                self._on_jogo_finalizado(self.vencedor)
            return

        self.rodada.resetar_apostas_steaks()
        self.jogo.girar_ordem()

        self.numero_rodada += 1
        self.rodada = self.jogo.proxima_rodada()
        yield from self._jogar_rodada_atual()

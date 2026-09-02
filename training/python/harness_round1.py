# harness_round1.py
# Harness só pra treinar a decisão de aposta da rodada cega (round==1, a
# "testa"): própria carta escondida, as dos outros visíveis. Cada episódio
# é literalmente só a rodada 1 -- o motor até continuaria pra rodada 2
# sozinho (ninguém pode morrer perdendo no máximo 1 hp numa rodada de 1
# carta), mas a gente abandona o gerador assim que a rodada 1 fecha, porque
# o reward dela já está 100% decidido nesse ponto (não depende de nada que
# viria depois) -- não tem mismatch de treinar "fora do jogo de verdade",
# é literalmente a rodada 1 de verdade, só sem gastar tempo simulando o
# resto de um jogo que a gente não vai usar.
import random

from motor.partida import Partida

NUM_SEATS = 4
NUM_RANKS = 10
NUM_NAIPES = 4
MAX_APOSTA = 1  # rodada de 1 carta -- aposta só pode ser 0 ou 1


def _codificar_carta(carta, vira_valor):
    return (
        carta.valor_int / (NUM_RANKS - 1),
        carta.naipe_int / (NUM_NAIPES - 1),
        1.0 if carta.valor_int == vira_valor else 0.0,
    )


def _ordem_relativa(jogadores, eu_id):
    indice = next(i for i, j in enumerate(jogadores) if j.id == eu_id)
    n = len(jogadores)
    return [jogadores[(indice + i) % n] for i in range(n)]


def construir_obs_round1(partida, jogador, apostaram):
    rodada = partida.rodada
    ordem_rel = _ordem_relativa(partida.jogadores, jogador.id)  # [eu, prox, prox+1, prox+2]

    vec = []
    # as OUTRAS 3 cartas -- a minha (ordem_rel[0]) fica de fora de propósito,
    # é essa a regra: eu não sei qual é a minha.
    for outro in ordem_rel[1:]:
        vec.extend(_codificar_carta(outro.mao[0], rodada.vira_valor))
    for j in ordem_rel:
        vec.append(j.hp / 3)
        vec.append(j.aposta / MAX_APOSTA)
        vec.append(1.0 if j.id in apostaram else 0.0)
    vec.append(rodada.vira_valor / (NUM_RANKS - 1))
    return vec


def _soma_apostas_dos_outros(rodada, jogador):
    return sum(j.aposta for j in rodada.game_order if j is not jogador)


def _eh_ultimo_a_apostar(rodada, jogador):
    return rodada.game_order[-1] is jogador


def mask_aposta_round1(rodada, jogador):
    proibido = None
    if _eh_ultimo_a_apostar(rodada, jogador):
        proibido = 1 - _soma_apostas_dos_outros(rodada, jogador)
    mask = [0, 0]
    for v in (0, 1):
        if v != proibido:
            mask[v] = 1
    return mask


class _SlotRound1:
    def __init__(self, worker_id):
        self.worker_id = worker_id
        self._proximo_episodio = 0
        self._fila_saida = []
        self._decisao_pendente = None
        self._iniciar_novo_episodio()

    def _iniciar_novo_episodio(self):
        self.numero_episodio = self._proximo_episodio
        self._proximo_episodio += 1
        self.pendente = [0.0] * NUM_SEATS
        self.apostaram = set()
        self.rodada1_fechou = False
        self.partida = Partida(
            number_players=NUM_SEATS, round_start=1, random_shuffle=True, hp_inicial=3,
            on_rodada_finalizada=self._on_rodada_finalizada,
        )
        self.gen = self.partida.jogar()
        self._avancar(None)

    def _on_rodada_finalizada(self, resultado):
        # Só existe rodada 1 nesse harness -- qualquer chamada aqui é dela.
        for r in resultado:
            self.pendente[r["jogador"].id] = -r["diferenca"]
        self.rodada1_fechou = True

    def _avancar(self, valor_enviado):
        try:
            decisao = self.gen.send(valor_enviado)
        except StopIteration:
            self._iniciar_novo_episodio()
            return

        if self.rodada1_fechou:
            # A rodada 1 fechou durante esse .send() -- a decisão que
            # voltou já é da rodada 2 (o motor seguiria sozinho, mas a
            # gente não quer). Descarta, despacha as finais, emenda outro.
            for seat in range(NUM_SEATS):
                self._fila_saida.append({
                    "episode": self.numero_episodio, "seat": seat, "kind": "final",
                    "reward": self.pendente[seat], "done": True, "actionRequired": False,
                    "obs": None, "legalMask": None, "resumo": {"rodadas": 1},
                })
            self._iniciar_novo_episodio()
            return

        kind, jogador = decisao
        if kind == "carta":
            # única carta da mão -- decisão forçada, não gasta rede nenhuma.
            self._avancar(0)
            return

        seat = jogador.id
        mask = mask_aposta_round1(self.partida.rodada, jogador)
        obs = construir_obs_round1(self.partida, jogador, self.apostaram)
        self._decisao_pendente = jogador
        self._fila_saida.append({
            "episode": self.numero_episodio, "seat": seat, "kind": "aposta",
            "reward": 0.0, "done": False, "actionRequired": True,
            "obs": obs, "legalMask": mask,
        })

    def drenar_saida(self):
        saida, self._fila_saida = self._fila_saida, []
        return saida

    def responder(self, valor):
        jogador = self._decisao_pendente
        self._decisao_pendente = None
        self.apostaram.add(jogador.id)
        self._avancar(valor)


class VecEnvRound1Nativo:
    def __init__(self, num_workers, **_ignorados):
        self.slots = [_SlotRound1(i) for i in range(num_workers)]

    def get_batch(self):
        msgs = []
        for slot in self.slots:
            for msg in slot.drenar_saida():
                msgs.append((slot.worker_id, msg))
        return msgs

    def send_action(self, worker_id, action):
        self.slots[worker_id].responder(action)

    def close(self):
        pass

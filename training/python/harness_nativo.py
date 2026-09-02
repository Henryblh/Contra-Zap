# harness_nativo.py
# Harness de treino 100% Python: sem subprocess, sem Node, sem JSON, sem
# pipe -- fala direto com training/python/motor/ (o porte do motor de
# regras) dentro do mesmo processo Python. Mesma observação/reward/máscara
# de training/env_bridge.js, só que chamada de função em vez de protocolo
# entre processos. Expõe a MESMA interface pública de VecEnvBridge
# (get_batch/send_action/close) -- train.py troca de um pro outro sem
# precisar saber a diferença.
#
# Troca real feita aqui: mais rápido (sem IPC), ao custo de ter a regra do
# jogo duplicada em duas linguagens (JS de produção + este motor). Ver
# discussão sobre esse trade-off antes de usar isto além de experimento.
import os
import random

from motor.partida import Partida

NUM_SEATS = 4
# Mudança de default (era 3): começar em 2 dá mais variedade de round-size
# cedo, sem acionar a regra especial de round==1 (carta própria escondida --
# ver harness_round1.py, esse caso continua fora daqui de propósito).
ROUND_START = int(os.environ.get("ROUND_START", "2"))
# hp inicial sorteado por episódio em vez de sempre 3 -- dá mais cobertura
# de situações de "quase morrendo" pro modelo ver durante o treino. 3/4 de
# chance de 3, 1/4 de chance de 2 (ver discussão sobre variar hp).
HP_ALEATORIO = os.environ.get("HP_ALEATORIO", "1") != "0"
MAX_HAND = 12
MAX_APOSTA = MAX_HAND
NUM_RANKS = 10
NUM_NAIPES = 4
WIN_BONUS = 5
LOSE_BONUS = -1


def sortear_hp_inicial():
    if not HP_ALEATORIO:
        return 3
    return random.choices([3, 2], weights=[3, 1])[0]
# Mesmo padrão de env_bridge.js/model.py -- precisa concordar com os dois.
COM_FLAG_APOSTOU = os.environ.get("COM_FLAG_APOSTOU", "1") != "0"
COM_MEMORIA_CARTAS = os.environ.get("COM_MEMORIA_CARTAS", "1") != "0"


# --- codificação de estado: cópia fiel de training/env_bridge.js:construirObs ---

def _codificar_carta(carta, vira_valor):
    return (
        carta.valor_int / (NUM_RANKS - 1),
        carta.naipe_int / (NUM_NAIPES - 1),
        1.0 if carta.valor_int == vira_valor else 0.0,
    )


_CARTA_VAZIA = (0.0, 0.0, 0.0)


def _codificar_mao(mao, vira_valor, vec):
    for i in range(MAX_HAND):
        vec.extend(_codificar_carta(mao[i], vira_valor) if i < len(mao) else _CARTA_VAZIA)


def _ordem_relativa(jogadores, eu_id):
    indice = next(i for i, j in enumerate(jogadores) if j.id == eu_id)
    n = len(jogadores)
    return [jogadores[(indice + i) % n] for i in range(n)]


def _codificar_mesa(mesa_ativa, ordem_rel, vira_valor, vec):
    jogadas_por_id = {}
    if mesa_ativa is not None:
        for carta, jogador in mesa_ativa.cartas_na_mesa:
            jogadas_por_id[jogador.id] = carta
    for jogador in ordem_rel:
        carta = jogadas_por_id.get(jogador.id)
        vec.extend(_codificar_carta(carta, vira_valor) if carta else _CARTA_VAZIA)
        vec.append(1.0 if carta else 0.0)


def construir_obs(partida, jogador, apostaram, cartas_jogadas):
    # `partida.jogadores` (lista ESTÁVEL, nunca encolhe) -- não usar
    # rodada.game_order/jogo.game_order aqui, esses filtram eliminados.
    rodada = partida.rodada
    ordem_rel = _ordem_relativa(partida.jogadores, jogador.id)

    vec = []
    _codificar_mao(jogador.mao, rodada.vira_valor, vec)
    _codificar_mesa(rodada.mesa_ativa, ordem_rel, rodada.vira_valor, vec)
    for j in ordem_rel:
        vec.append(j.hp / 3)
        vec.append(j.aposta / MAX_APOSTA)
        vec.append(j.steak / MAX_HAND)
        if COM_FLAG_APOSTOU:
            vec.append(1.0 if j.id in apostaram else 0.0)
    vec.append(rodada.vira_valor / (NUM_RANKS - 1))
    vec.append(rodada.round / MAX_HAND)
    if COM_MEMORIA_CARTAS:
        for i in range(NUM_RANKS * NUM_NAIPES):
            vec.append(1.0 if i in cartas_jogadas else 0.0)
    return vec


# --- máscaras de ação legal: cópia fiel de maskAposta/maskCarta ---

def _soma_apostas_dos_outros(rodada, jogador):
    return sum(j.aposta for j in rodada.game_order if j is not jogador)


def _eh_ultimo_a_apostar(rodada, jogador):
    return rodada.game_order[-1] is jogador


def mask_aposta(rodada, jogador):
    num_cartas = rodada.round
    proibido = None
    if _eh_ultimo_a_apostar(rodada, jogador):
        proibido = num_cartas - _soma_apostas_dos_outros(rodada, jogador)
    mask = [0] * (MAX_APOSTA + 1)
    for v in range(min(num_cartas, MAX_APOSTA) + 1):
        if v != proibido:
            mask[v] = 1
    return mask


def mask_carta(tamanho_mao):
    mask = [0] * MAX_HAND
    for i in range(min(tamanho_mao, MAX_HAND)):
        mask[i] = 1
    return mask


# --- um "slot" = uma partida sempre rodando, emenda a próxima sozinha quando acaba ---

class _Slot:
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
        self.cartas_jogadas = set()
        self.partida = Partida(
            number_players=NUM_SEATS, round_start=ROUND_START, random_shuffle=True,
            hp_inicial=sortear_hp_inicial(),
            on_nova_rodada=self._on_nova_rodada,
            on_rodada_finalizada=self._on_rodada_finalizada,
            on_jogo_finalizado=self._on_jogo_finalizado,
        )
        self.gen = self.partida.jogar()
        self._processar_proxima_decisao(self.gen.send(None))

    def _on_nova_rodada(self, numero_rodada, tamanho_rodada):
        self.apostaram = set()
        self.cartas_jogadas = set()

    def _on_rodada_finalizada(self, resultado):
        for r in resultado:
            self.pendente[r["jogador"].id] += -r["diferenca"]

    def _on_jogo_finalizado(self, vencedor):
        resumo = {
            "vencedor": vencedor.id,
            "rodadas": self.partida.numero_rodada,
            "hpFinal": [j.hp for j in self.partida.jogadores],
        }
        for seat in range(NUM_SEATS):
            bonus = WIN_BONUS if seat == vencedor.id else LOSE_BONUS
            self._fila_saida.append({
                "episode": self.numero_episodio, "seat": seat, "kind": "final",
                "reward": self.pendente[seat] + bonus, "done": True, "actionRequired": False,
                "obs": None, "legalMask": None, "resumo": resumo,
            })

    def _processar_proxima_decisao(self, decisao):
        kind, jogador = decisao
        seat = jogador.id
        reward = self.pendente[seat]
        self.pendente[seat] = 0.0
        mask = mask_aposta(self.partida.rodada, jogador) if kind == "aposta" else mask_carta(len(jogador.mao))
        obs = construir_obs(self.partida, jogador, self.apostaram, self.cartas_jogadas)
        self._decisao_pendente = (kind, jogador)
        self._fila_saida.append({
            "episode": self.numero_episodio, "seat": seat, "kind": kind,
            "reward": reward, "done": False, "actionRequired": True,
            "obs": obs, "legalMask": mask,
        })

    def drenar_saida(self):
        saida, self._fila_saida = self._fila_saida, []
        return saida

    def responder(self, valor):
        kind, jogador = self._decisao_pendente
        self._decisao_pendente = None
        # Mesma ordem de env_bridge.js: registra a escolha ANTES de aplicá-la
        # no motor (carta ainda está na mão nesse instante).
        if kind == "aposta":
            self.apostaram.add(jogador.id)
        else:
            if 0 <= valor < len(jogador.mao):
                carta = jogador.mao[valor]
                self.cartas_jogadas.add(carta.valor_int * NUM_NAIPES + carta.naipe_int)
        try:
            decisao = self.gen.send(valor)
        except StopIteration:
            # A partida acabou -- as 4 mensagens finais já foram pra fila
            # dentro de _on_jogo_finalizado. Emenda o próximo episódio na
            # hora, sem round-trip nenhum (mesmo espírito do while(true) de
            # jogarEpisodio em env_bridge.js).
            self._iniciar_novo_episodio()
            return
        self._processar_proxima_decisao(decisao)


class VecEnvNativo:
    # Mesma interface pública de VecEnvBridge (env_client.py) -- train.py
    # não precisa saber qual dos dois está usando.
    def __init__(self, num_workers, **_ignorados):
        self.slots = [_Slot(i) for i in range(num_workers)]

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

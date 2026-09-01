# model.py
# Rede compartilhada por self-play: um tronco comum (o "entendimento do
# estado") e duas cabeças de ação (aposta e carta), mais uma cabeça de valor
# pro PPO. Todos os 4 assentos usam a MESMA rede — em self-play simétrico não
# há razão pra treinar populações separadas (ver discussão do plano).
#
# As dimensões abaixo têm que bater exatamente com training/env_bridge.js:
#   MAX_HAND = 12 cartas representadas, cada uma [rank, naipe, é_manilha] (3)
#   -> mao: 12*3 = 36
#   mesa: 4 assentos (ordem relativa) * [rank, naipe, é_manilha, já_jogou] = 16
#   hpApostaSteak: 4 assentos * [hp, aposta, steak] (+ já_apostou, se
#     COM_FLAG_APOSTOU) = 12 ou 16
#   viraValor (1) + cartasRodada (1)
#   total = 36 + 16 + (12 ou 16) + 1 + 1 = 66 ou 70
#
# COM_FLAG_APOSTOU precisa concordar com a mesma variável de ambiente em
# training/env_bridge.js — existe só pra poder continuar treinando o
# baseline antigo (checkpoint de 66 entradas) em paralelo com a versão nova
# (70), pra comparação; não é config de produção.
import os

import torch
import torch.nn as nn

NUM_SEATS = 4
MAX_HAND = 12
COM_FLAG_APOSTOU = os.environ.get('COM_FLAG_APOSTOU', '1') != '0'
OBS_DIM = MAX_HAND * 3 + NUM_SEATS * 4 + NUM_SEATS * (4 if COM_FLAG_APOSTOU else 3) + 1 + 1
APOSTA_ACTIONS = MAX_HAND + 1  # aposta vai de 0 até o número de cartas da rodada
CARTA_ACTIONS = MAX_HAND


class ActorCritic(nn.Module):
    def __init__(self, hidden=128):
        super().__init__()
        self.trunk = nn.Sequential(
            nn.Linear(OBS_DIM, hidden), nn.ReLU(),
            nn.Linear(hidden, hidden), nn.ReLU(),
        )
        self.aposta_head = nn.Linear(hidden, APOSTA_ACTIONS)
        self.carta_head = nn.Linear(hidden, CARTA_ACTIONS)
        self.value_head = nn.Linear(hidden, 1)

    def forward(self, obs):
        h = self.trunk(obs)
        return self.aposta_head(h), self.carta_head(h), self.value_head(h).squeeze(-1)

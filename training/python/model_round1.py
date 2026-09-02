# model_round1.py -- rede minúscula só pra decisão de aposta da rodada
# cega (round==1): aposta 0 ou 1, própria carta escondida. Não tem cabeça
# de carta -- com 1 carta só, jogar é forçado, não tem decisão real ali.
NUM_SEATS = 4
NUM_RANKS = 10
NUM_NAIPES = 4
# outras 3 cartas visíveis [rank,naipe,manilha] (3*3=9) + hp/aposta/apostou
# dos 4 assentos, incluindo eu mesmo (4*3=12) + viraValor (1)
OBS_DIM = (NUM_SEATS - 1) * 3 + NUM_SEATS * 3 + 1
APOSTA_ACTIONS = 2  # 0 ou 1 -- só existe isso numa rodada de 1 carta

import torch
import torch.nn as nn


class ModeloRound1(nn.Module):
    def __init__(self, hidden=32):
        super().__init__()
        self.trunk = nn.Sequential(
            nn.Linear(OBS_DIM, hidden), nn.ReLU(),
            nn.Linear(hidden, hidden), nn.ReLU(),
        )
        self.aposta_head = nn.Linear(hidden, APOSTA_ACTIONS)
        self.value_head = nn.Linear(hidden, 1)

    def forward(self, obs):
        h = self.trunk(obs)
        return self.aposta_head(h), self.value_head(h).squeeze(-1)

# export_weights.py -- despeja checkpoints .pt em JSON que bots/nn.js carrega.
# Sem torch do lado do jogo: a rede vira matriz de float e o forward pass é
# reimplementado em JS (redes minusculas, 2 camadas + cabecas).
#
# Rodar:
#   training\.venv\Scripts\python.exe training\python\export_weights.py
import json
from pathlib import Path

import torch

RAIZ = Path(__file__).resolve().parent.parent.parent
CK = RAIZ / "training" / "checkpoints"
SAIDA = RAIZ / "bots" / "models"

# (checkpoint, arquivo de saida, tem cabeca de carta?)
ALVOS = [
    (CK / "noite1_G.melhor.pt", SAIDA / "noite1.json", True),
    (CK / "round1pbt_D.melhor.pt", SAIDA / "round1.json", False),
]


def tolist(t):
    return t.detach().cpu().tolist()


def exportar(ckpt_path, saida_path, com_carta):
    sd = torch.load(ckpt_path, map_location="cpu", weights_only=True)
    hidden, obs_dim = sd["trunk.0.weight"].shape
    dados = {
        "fonte": ckpt_path.name,
        "obs_dim": obs_dim,
        "hidden": hidden,
        "trunk0_w": tolist(sd["trunk.0.weight"]),  # [hidden][obs_dim]
        "trunk0_b": tolist(sd["trunk.0.bias"]),
        "trunk2_w": tolist(sd["trunk.2.weight"]),  # [hidden][hidden]
        "trunk2_b": tolist(sd["trunk.2.bias"]),
        "aposta_w": tolist(sd["aposta_head.weight"]),
        "aposta_b": tolist(sd["aposta_head.bias"]),
        "value_w": tolist(sd["value_head.weight"]),
        "value_b": tolist(sd["value_head.bias"]),
    }
    if com_carta:
        dados["carta_w"] = tolist(sd["carta_head.weight"])
        dados["carta_b"] = tolist(sd["carta_head.bias"])
    saida_path.parent.mkdir(parents=True, exist_ok=True)
    with open(saida_path, "w", encoding="utf-8") as f:
        json.dump(dados, f)
    kb = saida_path.stat().st_size / 1024
    print(f"{ckpt_path.name:26s} -> {saida_path.relative_to(RAIZ)}  "
          f"(obs_dim={obs_dim}, hidden={hidden}, {kb:.0f} KB)")


if __name__ == "__main__":
    for ckpt, saida, com_carta in ALVOS:
        exportar(ckpt, saida, com_carta)

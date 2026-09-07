"""Checkpoints atômicos e retomáveis para os workers de treino."""
from __future__ import annotations

import os
import random
import copy
from pathlib import Path

import numpy as np
import torch


def atomic_save(value, path):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(path.suffix + ".tmp")
    torch.save(value, temp)
    os.replace(temp, path)


def _load_trusted_training_state(path):
    # Estados completos contêm tuplas/arrays dos RNGs e, no PyTorch 2.6+,
    # portanto não cabem no modo weights_only. Estes arquivos são criados
    # localmente pela própria run, não aceitos de uma fonte remota.
    try:
        return torch.load(path, map_location="cpu", weights_only=False)
    except TypeError:  # PyTorch antigo
        return torch.load(path, map_location="cpu")


def finite_state_dict(state_dict):
    return isinstance(state_dict, dict) and all(torch.is_tensor(x) and torch.isfinite(x).all().item() for x in state_dict.values())


def rng_state():
    return {"python": random.getstate(), "numpy": np.random.get_state(), "torch": torch.get_rng_state()}


def restore_rng(value):
    if not value:
        return
    random.setstate(value["python"])
    np.random.set_state(value["numpy"])
    torch.set_rng_state(value["torch"])


def independent_rng_state(seed):
    """Cria RNGs reprodutíveis sem alterar o processo que faz a clonagem."""
    py_rng = random.Random(int(seed))
    np_rng = np.random.RandomState(int(seed) % (2 ** 32))
    torch_rng = torch.Generator(device="cpu")
    torch_rng.manual_seed(int(seed))
    return {"python": py_rng.getstate(), "numpy": np_rng.get_state(), "torch": torch_rng.get_state()}


def save_training_state(path, *, model, optimizer, update, args, metadata=None):
    state = {
        "schema_version": 1,
        "model_state": model.state_dict(),
        "optimizer_state": optimizer.state_dict(),
        "update": int(update),
        "hparams": {k: v for k, v in vars(args).items() if isinstance(v, (str, int, float, bool, type(None)))},
        "rng": rng_state(),
        "metadata": metadata or {},
    }
    atomic_save(state, path)


def load_training_state(path, model, optimizer=None):
    data = _load_trusted_training_state(path)
    # Checkpoints legados são somente state_dict.
    if "model_state" not in data:
        model.load_state_dict(data)
        return {"update": 0, "legacy": True, "metadata": {}}
    if not finite_state_dict(data["model_state"]):
        raise ValueError(f"checkpoint inválido/não finito: {path}")
    model.load_state_dict(data["model_state"])
    if optimizer is not None and data.get("optimizer_state"):
        optimizer.load_state_dict(data["optimizer_state"])
    restore_rng(data.get("rng"))
    return data


def clone_training_state(source, destination, *, seed, lr, hparams=None, metadata=None):
    """Clona modelo+otimizador, aplicando LR e RNG novos ao descendente PBT."""
    data = _load_trusted_training_state(source)
    if not isinstance(data, dict) or "model_state" not in data or "optimizer_state" not in data:
        raise ValueError(f"estado de treino completo exigido para clonagem: {source}")
    if not finite_state_dict(data["model_state"]):
        raise ValueError(f"checkpoint inválido/não finito: {source}")
    cloned = copy.deepcopy(data)
    for group in cloned["optimizer_state"].get("param_groups", []):
        group["lr"] = float(lr)
    cloned.setdefault("hparams", {}).update(hparams or {})
    cloned["hparams"]["lr"] = float(lr)
    cloned["rng"] = independent_rng_state(seed)
    cloned["metadata"] = {**cloned.get("metadata", {}), **(metadata or {})}
    atomic_save(cloned, destination)
    return cloned

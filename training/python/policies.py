"""Políticas reutilizáveis pelo avaliador offline.

Uma política recebe somente a observação e a máscara da própria vez, exatamente
como uma rede treinada recebe. Estratégias novas podem ser expostas ao CLI com
``strategy=meu_modulo:MinhaClasse`` e devem implementar ``act``.
"""
from __future__ import annotations

import importlib
import numbers
from dataclasses import dataclass
from pathlib import Path

import torch

from model import APOSTA_ACTIONS, CARTA_ACTIONS, ActorCritic


class PolicyError(ValueError):
    """Erro de configuração ou de decisão de uma política."""


def legal_actions(legal_mask):
    actions = [index for index, permitido in enumerate(legal_mask) if permitido]
    if not actions:
        raise PolicyError("A máscara recebida não possui nenhuma ação legal.")
    return actions


def validate_action(action, legal_mask, policy_name):
    if isinstance(action, bool) or not isinstance(action, numbers.Integral):
        raise PolicyError(f"{policy_name} devolveu uma ação não inteira: {action!r}.")
    action = int(action)
    if action < 0 or action >= len(legal_mask) or not legal_mask[action]:
        raise PolicyError(f"{policy_name} devolveu ação ilegal: {action}.")
    return action


class Policy:
    """Contrato mínimo para estratégias carregadas pelo avaliador."""

    def act(self, kind, obs, legal_mask, rng):  # pragma: no cover - interface
        raise NotImplementedError


class HeuristicPolicy(Policy):
    """Espelho exato da estratégia atual de bots/BotBrain.js."""

    def act(self, kind, obs, legal_mask, rng):
        actions = legal_actions(legal_mask)
        if kind == "aposta":
            return 1 if len(legal_mask) > 1 and legal_mask[1] else 0
        if kind == "carta":
            return actions[-1]
        raise PolicyError(f"Tipo de decisão desconhecido: {kind!r}.")


class RandomPolicy(Policy):
    def act(self, kind, obs, legal_mask, rng):
        return rng.choice(legal_actions(legal_mask))


def flatten_for_obs_dim(obs, obs_dim):
    """Achatamento compatível com checkpoints de 70 e do baseline de 66."""
    hand = list(obs["mao"])
    table = list(obs["mesa"])
    players = list(obs["hpApostaSteak"])

    if len(players) != 16:
        raise PolicyError(f"Observação inválida: hpApostaSteak tem {len(players)} valores; esperado 16.")

    if obs_dim == 70:
        player_values = players
    elif obs_dim == 66:
        # Remove o quarto valor de cada jogador: a flag "já apostou" que não
        # existia no baseline antigo.
        player_values = []
        for index in range(0, len(players), 4):
            player_values.extend(players[index:index + 3])
    else:
        raise PolicyError(f"Checkpoint usa observação de {obs_dim} valores; suportados: 66 e 70.")

    values = hand + table + player_values + [obs["viraValor"], obs["cartasRodada"]]
    if len(values) != obs_dim:
        raise PolicyError(f"Observação montada tem {len(values)} valores; checkpoint exige {obs_dim}.")
    return values


def _model_from_state_dict(state_dict, path, device):
    if not isinstance(state_dict, dict):
        raise PolicyError(f"Checkpoint inválido em {path}: esperado um state_dict.")

    required = {
        "trunk.0.weight", "trunk.0.bias", "trunk.2.weight", "trunk.2.bias",
        "aposta_head.weight", "aposta_head.bias", "carta_head.weight", "carta_head.bias",
        "value_head.weight", "value_head.bias",
    }
    missing = sorted(required.difference(state_dict))
    if missing:
        raise PolicyError(f"Checkpoint incompatível em {path}: faltam {', '.join(missing)}.")

    first = state_dict["trunk.0.weight"]
    second = state_dict["trunk.2.weight"]
    if first.ndim != 2 or second.ndim != 2:
        raise PolicyError(f"Checkpoint incompatível em {path}: camadas do tronco inválidas.")
    hidden, obs_dim = first.shape

    expected_shapes = {
        "trunk.0.bias": (hidden,),
        "trunk.2.weight": (hidden, hidden),
        "trunk.2.bias": (hidden,),
        "aposta_head.weight": (APOSTA_ACTIONS, hidden),
        "aposta_head.bias": (APOSTA_ACTIONS,),
        "carta_head.weight": (CARTA_ACTIONS, hidden),
        "carta_head.bias": (CARTA_ACTIONS,),
        "value_head.weight": (1, hidden),
        "value_head.bias": (1,),
    }
    for key, expected in expected_shapes.items():
        tensor = state_dict[key]
        if tuple(tensor.shape) != expected:
            raise PolicyError(
                f"Checkpoint incompatível em {path}: {key} tem formato {tuple(tensor.shape)}, esperado {expected}."
            )

    if obs_dim not in (66, 70):
        raise PolicyError(f"Checkpoint incompatível em {path}: entrada {obs_dim}; suportadas 66 e 70.")
    if not all(torch.is_tensor(value) and torch.isfinite(value).all().item() for value in state_dict.values()):
        raise PolicyError(f"Checkpoint inválido em {path}: contém pesos não finitos.")

    model = ActorCritic(hidden=hidden, obs_dim=obs_dim).to(device)
    try:
        model.load_state_dict(state_dict, strict=True)
    except RuntimeError as error:
        raise PolicyError(f"Checkpoint incompatível em {path}: {error}") from error
    model.eval()
    return model, obs_dim


class CheckpointPolicy(Policy):
    def __init__(self, model, obs_dim, *, sample_models=False, device="cpu"):
        self.model = model
        self.obs_dim = obs_dim
        self.sample_models = sample_models
        self.device = torch.device(device)

    def act(self, kind, obs, legal_mask, rng):
        legal_actions(legal_mask)
        vector = flatten_for_obs_dim(obs, self.obs_dim)
        obs_tensor = torch.tensor(vector, dtype=torch.float32, device=self.device).unsqueeze(0)
        mask_tensor = torch.tensor(legal_mask, dtype=torch.bool, device=self.device)

        with torch.inference_mode():
            aposta_logits, carta_logits, _ = self.model(obs_tensor)
            logits = aposta_logits[0] if kind == "aposta" else carta_logits[0] if kind == "carta" else None
            if logits is None:
                raise PolicyError(f"Tipo de decisão desconhecido: {kind!r}.")
            if len(legal_mask) != logits.numel():
                raise PolicyError(
                    f"Máscara de {len(legal_mask)} ações incompatível com a cabeça {kind} de {logits.numel()} ações."
                )
            masked_logits = logits.masked_fill(~mask_tensor, float("-inf"))
            if self.sample_models:
                probabilities = torch.softmax(masked_logits, dim=0).cpu().tolist()
                return rng.choices(range(len(probabilities)), weights=probabilities, k=1)[0]
            return int(torch.argmax(masked_logits).item())


@dataclass(frozen=True)
class PolicyHandle:
    spec: str
    label: str
    policy: Policy


class PolicyFactory:
    """Resolve descritores e compartilha modelos idênticos em memória."""

    def __init__(self, *, sample_models=False, device="cpu"):
        self.sample_models = sample_models
        self.device = device
        self._model_cache = {}

    def create(self, spec):
        spec = spec.strip()
        if spec == "heuristic":
            return PolicyHandle(spec=spec, label="heuristic", policy=HeuristicPolicy())
        if spec == "random":
            return PolicyHandle(spec=spec, label="random", policy=RandomPolicy())
        if spec.startswith("checkpoint="):
            return self._checkpoint(spec, spec.removeprefix("checkpoint="))
        if spec.startswith("strategy="):
            return self._strategy(spec, spec.removeprefix("strategy="))
        raise PolicyError(
            f"Descriptor de bot inválido: {spec!r}. Use checkpoint=<arquivo>, heuristic, random ou strategy=<módulo>:<Classe>."
        )

    def _checkpoint(self, spec, raw_path):
        if not raw_path:
            raise PolicyError("checkpoint= exige o caminho de um arquivo .pt.")
        path = Path(raw_path).expanduser().resolve()
        if not path.is_file():
            raise PolicyError(f"Checkpoint não encontrado: {path}.")

        key = (str(path), self.device)
        if key not in self._model_cache:
            try:
                state_dict = torch.load(path, map_location=self.device, weights_only=True)
            except TypeError:  # compatibilidade com versões antigas do PyTorch
                state_dict = torch.load(path, map_location=self.device)
            except Exception as error:
                raise PolicyError(f"Não foi possível carregar checkpoint {path}: {error}") from error
            self._model_cache[key] = _model_from_state_dict(state_dict, path, self.device)

        model, obs_dim = self._model_cache[key]
        return PolicyHandle(
            spec=spec,
            label=f"checkpoint:{path}",
            policy=CheckpointPolicy(model, obs_dim, sample_models=self.sample_models, device=self.device),
        )

    def _strategy(self, spec, target):
        if ":" not in target:
            raise PolicyError("strategy= deve ter o formato strategy=<módulo>:<Classe>.")
        module_name, class_name = target.rsplit(":", 1)
        try:
            module = importlib.import_module(module_name)
            strategy_class = getattr(module, class_name)
            policy = strategy_class()
        except (ImportError, AttributeError, TypeError) as error:
            raise PolicyError(f"Não foi possível carregar estratégia {target!r}: {error}") from error
        if not callable(getattr(policy, "act", None)):
            raise PolicyError(f"Estratégia {target!r} não implementa act(kind, obs, legal_mask, rng).")
        return PolicyHandle(spec=spec, label=f"strategy:{target}", policy=policy)


def policy_action(handle, kind, obs, legal_mask, rng):
    action = handle.policy.act(kind, obs, legal_mask, rng)
    return validate_action(action, legal_mask, handle.label)

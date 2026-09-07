"""Liga determinística de oponentes congelados para o rollout PPO."""
from __future__ import annotations

import hashlib
import json
import math
import random
from dataclasses import dataclass
from pathlib import Path

from policies import CheckpointPolicy, PolicyError, PolicyFactory, validate_action


NUM_SEATS = 4
EXPECTED_MIXTURE = {"self_play": 0.50, "historical": 0.35, "anchors": 0.15}
PAIR_ROTATION = ((0, 1), (0, 2), (0, 3), (1, 2), (1, 3), (2, 3))


def sha256_file(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as file:
        for chunk in iter(lambda: file.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _derived_seed(*parts):
    payload = "\x1f".join(str(part) for part in parts).encode("utf-8")
    return int.from_bytes(hashlib.sha256(payload).digest()[:8], "big")


@dataclass(frozen=True)
class EpisodeAssignment:
    mode: str
    lineup: str
    learner_seats: frozenset
    opponent_id: str | None = None

    def learner_controls(self, seat):
        return seat in self.learner_seats


@dataclass(frozen=True)
class FrozenOpponent:
    id: str
    pool: str
    kind: str
    weight: float
    handle: object


class LeagueController:
    def __init__(self, manifest_path, *, slot_seed):
        self.path = Path(manifest_path).resolve()
        raw = self.path.read_bytes()
        self.sha256 = hashlib.sha256(raw).hexdigest()
        self.manifest = json.loads(raw.decode("utf-8-sig"))
        self.slot_seed = int(slot_seed or 0)
        self.seed = self._validate_header()
        self.factory = PolicyFactory(sample_models=False, device="cpu")
        self.opponents = self._load_opponents()
        self.by_pool = {
            pool: [opponent for opponent in self.opponents.values() if opponent.pool == pool]
            for pool in ("historical", "anchors")
        }
        for pool, opponents in self.by_pool.items():
            if not opponents:
                raise ValueError(f"league-manifest inválido: pool {pool!r} está vazio")
        self._decision_counts = {}

    def _validate_header(self):
        value = self.manifest
        if value.get("schema_version") != 1 or value.get("manifest_type") != "training_league":
            raise ValueError("league-manifest inválido: esperado schema_version=1 e manifest_type=training_league")
        seed = value.get("seed")
        if isinstance(seed, bool) or not isinstance(seed, int):
            raise ValueError("league-manifest inválido: seed deve ser inteiro")
        mixture = value.get("mixture")
        if not isinstance(mixture, dict) or set(mixture) != set(EXPECTED_MIXTURE):
            raise ValueError("league-manifest inválido: mixture deve conter self_play, historical e anchors")
        if any(not isinstance(v, (int, float)) or not math.isfinite(v) or v < 0 for v in mixture.values()):
            raise ValueError("league-manifest inválido: mixture contém peso inválido")
        if not math.isclose(sum(mixture.values()), 1.0, abs_tol=1e-9):
            raise ValueError("league-manifest inválido: mixture deve somar 1")
        if any(not math.isclose(float(mixture[k]), v, abs_tol=1e-9) for k, v in EXPECTED_MIXTURE.items()):
            raise ValueError("league-manifest inválido: este treino exige mistura 50/35/15")
        if not isinstance(value.get("opponents"), list):
            raise ValueError("league-manifest inválido: opponents deve ser uma lista")
        return seed

    def _load_opponents(self):
        result = {}
        for row in self.manifest["opponents"]:
            if not isinstance(row, dict):
                raise ValueError("league-manifest inválido: oponente deve ser objeto")
            opponent_id = row.get("id")
            if not isinstance(opponent_id, str) or not opponent_id or opponent_id in result:
                raise ValueError(f"league-manifest inválido: id ausente ou duplicado: {opponent_id!r}")
            pool, kind, weight = row.get("pool"), row.get("kind"), row.get("weight")
            if pool not in ("historical", "anchors"):
                raise ValueError(f"league-manifest inválido: pool de {opponent_id!r}")
            if kind not in ("checkpoint", "heuristic", "random"):
                raise ValueError(f"league-manifest inválido: kind de {opponent_id!r}")
            if isinstance(weight, bool) or not isinstance(weight, (int, float)) or not math.isfinite(weight) or weight <= 0:
                raise ValueError(f"league-manifest inválido: weight de {opponent_id!r}")
            estimated = row.get("estimated_win_rate")
            if estimated is not None and (
                isinstance(estimated, bool) or not isinstance(estimated, (int, float))
                or not math.isfinite(estimated) or not 0 <= estimated <= 1
            ):
                raise ValueError(f"league-manifest inválido: estimated_win_rate de {opponent_id!r}")

            if kind == "checkpoint":
                checkpoint = row.get("checkpoint")
                if not isinstance(checkpoint, str) or not checkpoint:
                    raise ValueError(f"league-manifest inválido: checkpoint de {opponent_id!r}")
                path = Path(checkpoint)
                if not path.is_absolute():
                    path = (self.path.parent / path).resolve()
                if not path.is_file():
                    raise ValueError(f"checkpoint da liga não encontrado: {path}")
                expected_hash = row.get("sha256")
                actual_hash = sha256_file(path)
                if not isinstance(expected_hash, str) or actual_hash.lower() != expected_hash.lower():
                    raise ValueError(f"SHA-256 divergente para oponente {opponent_id!r}")
                handle = self.factory.create(f"checkpoint={path}")
                actual_dim = handle.policy.obs_dim
                if row.get("obs_dim") != actual_dim:
                    raise ValueError(
                        f"obs_dim de {opponent_id!r} é {row.get('obs_dim')!r}; checkpoint exige {actual_dim}"
                    )
            else:
                handle = self.factory.create(kind)
            result[opponent_id] = FrozenOpponent(opponent_id, pool, kind, float(weight), handle)
        return result

    def _block_modes(self, worker_id, block):
        modes = ["self_play"] * 10 + ["historical"] * 7 + ["anchors"] * 3
        random.Random(_derived_seed(self.seed, self.slot_seed, worker_id, block, "schedule")).shuffle(modes)
        return modes

    def _choose_opponent(self, pool, worker_id, episode):
        opponents = self.by_pool[pool]
        total = sum(item.weight for item in opponents)
        rng = random.Random(_derived_seed(self.seed, self.slot_seed, worker_id, episode, pool, "opponent"))
        needle = rng.random() * total
        cumulative = 0.0
        for opponent in opponents:
            cumulative += opponent.weight
            if needle <= cumulative:
                return opponent
        return opponents[-1]  # pragma: no cover - arredondamento de ponto flutuante

    def assignment(self, worker_id, episode):
        block, offset = divmod(int(episode), 20)
        modes = self._block_modes(worker_id, block)
        mode = modes[offset]
        if mode == "self_play":
            return EpisodeAssignment(mode, "self_play", frozenset(range(NUM_SEATS)))

        prior_opponent_episodes = block * 10 + sum(item != "self_play" for item in modes[:offset])
        if prior_opponent_episodes % 2 == 0:
            learner_index = prior_opponent_episodes // 2
            learner_seats = frozenset((learner_index % NUM_SEATS,))
            lineup = "1x3"
        else:
            learner_index = prior_opponent_episodes // 2
            learner_seats = frozenset(PAIR_ROTATION[learner_index % len(PAIR_ROTATION)])
            lineup = "2x2"
        opponent = self._choose_opponent(mode, worker_id, episode)
        return EpisodeAssignment(mode, lineup, learner_seats, opponent.id)

    def act_opponents(self, entries):
        """Retorna ações na mesma ordem, batelando redes por oponente/kind."""
        actions = [None] * len(entries)
        grouped = {}
        for index, entry in enumerate(entries):
            assignment = entry["assignment"]
            opponent = self.opponents[assignment.opponent_id]
            grouped.setdefault((opponent.id, entry["kind"]), []).append((index, entry))

        for (opponent_id, kind), group in grouped.items():
            opponent = self.opponents[opponent_id]
            if opponent.kind == "checkpoint":
                policy = opponent.handle.policy
                if not isinstance(policy, CheckpointPolicy):  # pragma: no cover - contrato interno
                    raise PolicyError(f"Política {opponent_id!r} não é um checkpoint.")
                batch_actions = policy.act_flat_batch(
                    kind,
                    [entry["obs"] for _, entry in group],
                    [entry["mask"] for _, entry in group],
                )
            else:
                batch_actions = []
                for _, entry in group:
                    key = (entry["worker_id"], entry["episode"], entry["seat"])
                    decision_index = self._decision_counts.get(key, 0)
                    self._decision_counts[key] = decision_index + 1
                    rng = random.Random(_derived_seed(
                        self.seed, self.slot_seed, *key, decision_index, opponent_id, "action"
                    ))
                    batch_actions.append(opponent.handle.policy.act(kind, None, entry["mask"], rng))
            for (index, entry), action in zip(group, batch_actions):
                actions[index] = validate_action(action, entry["mask"], opponent.handle.label)
        return actions

    def finish_episode(self, worker_id, episode):
        for key in [key for key in self._decision_counts if key[:2] == (worker_id, episode)]:
            del self._decision_counts[key]

    def checkpoint_metadata(self, cumulative):
        return {"manifest": self.manifest, "manifest_sha256": self.sha256, "cumulative": cumulative}

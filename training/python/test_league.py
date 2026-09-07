import json
import random
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

import torch

from league import EpisodeAssignment, LeagueController, sha256_file
from model import ActorCritic
from policies import PolicyFactory, policy_action
from train import collect_rollout
from training_state import clone_training_state, load_training_state, save_training_state


def structured_obs():
    return {
        "mao": [0.0] * 36, "mesa": [0.0] * 16, "hpApostaSteak": [0.0] * 16,
        "viraValor": 0.0, "cartasRodada": 0.0, "memoria": [0.0] * 40,
    }


def write_manifest(root, *, bad_hash=False, mixture=None):
    root = Path(root)
    root.mkdir(parents=True, exist_ok=True)
    h = root / "h.pt"
    old = root / "old.pt"
    torch.save(ActorCritic(obs_dim=110).state_dict(), h)
    torch.save(ActorCritic(hidden=128, obs_dim=70).state_dict(), old)
    value = {
        "schema_version": 1,
        "manifest_type": "training_league",
        "seed": 991,
        "mixture": mixture or {"self_play": .5, "historical": .35, "anchors": .15},
        "opponents": [
            {"id": "history", "pool": "historical", "kind": "checkpoint",
             "checkpoint": str(h), "obs_dim": 110,
             "sha256": "0" * 64 if bad_hash else sha256_file(h), "weight": 1.0},
            {"id": "H", "pool": "anchors", "kind": "checkpoint",
             "checkpoint": str(h), "obs_dim": 110, "sha256": sha256_file(h), "weight": .4},
            {"id": "overnight", "pool": "anchors", "kind": "checkpoint",
             "checkpoint": str(old), "obs_dim": 70, "sha256": sha256_file(old), "weight": .3},
            {"id": "heuristic", "pool": "anchors", "kind": "heuristic", "weight": .2},
            {"id": "random", "pool": "anchors", "kind": "random", "weight": .1},
        ],
    }
    path = root / "league.json"
    path.write_text(json.dumps(value), encoding="utf-8")
    return path, h, old


class FakeEnv:
    def __init__(self, batches):
        self.batches = list(batches)
        self.actions = []
        self.get_calls = 0

    def get_batch(self):
        self.get_calls += 1
        return self.batches.pop(0)

    def send_action(self, worker_id, action):
        self.actions.append((worker_id, action))


class LeagueTests(unittest.TestCase):
    def test_validates_manifest_hash_and_mixture(self):
        with tempfile.TemporaryDirectory() as directory:
            path, _, _ = write_manifest(directory)
            LeagueController(path, slot_seed=10)
            bad, _, _ = write_manifest(Path(directory) / "bad", bad_hash=True)
            with self.assertRaisesRegex(ValueError, "SHA-256"):
                LeagueController(bad, slot_seed=10)
            mixed, _, _ = write_manifest(
                Path(directory) / "mixed", mixture={"self_play": .6, "historical": .3, "anchors": .1}
            )
            with self.assertRaisesRegex(ValueError, "50/35/15"):
                LeagueController(mixed, slot_seed=10)

    def test_schedule_is_exact_balanced_and_reproducible(self):
        with tempfile.TemporaryDirectory() as directory:
            path, _, _ = write_manifest(directory)
            first = LeagueController(path, slot_seed=123)
            second = LeagueController(path, slot_seed=123)
            assignments = [first.assignment(3, episode) for episode in range(120)]
            self.assertEqual(assignments, [second.assignment(3, episode) for episode in range(120)])
            first_block = assignments[:20]
            self.assertEqual(sum(a.mode == "self_play" for a in first_block), 10)
            self.assertEqual(sum(a.mode == "historical" for a in first_block), 7)
            self.assertEqual(sum(a.mode == "anchors" for a in first_block), 3)
            opponent_games = [a for a in assignments if a.mode != "self_play"]
            self.assertEqual(sum(a.lineup == "1x3" for a in opponent_games), 30)
            self.assertEqual(sum(a.lineup == "2x2" for a in opponent_games), 30)
            one_seats = [next(iter(a.learner_seats)) for a in opponent_games if a.lineup == "1x3"]
            self.assertLessEqual(max(one_seats.count(s) for s in range(4)) - min(one_seats.count(s) for s in range(4)), 1)
            pair_seats = [s for a in opponent_games if a.lineup == "2x2" for s in a.learner_seats]
            self.assertEqual({s: pair_seats.count(s) for s in range(4)}, {0: 15, 1: 15, 2: 15, 3: 15})

    def test_checkpoint_batch_argmax_matches_evaluator(self):
        with tempfile.TemporaryDirectory() as directory:
            path, _, old = write_manifest(directory)
            league = LeagueController(path, slot_seed=7)
            handle = PolicyFactory().create(f"checkpoint={old}")
            mask = [1] * 13
            expected = policy_action(handle, "aposta", structured_obs(), mask, random.Random(1))
            assignment = EpisodeAssignment("anchors", "1x3", frozenset(), "overnight")
            entry = {"worker_id": 0, "episode": 1, "seat": 0, "obs": [0.0] * 110,
                     "mask": mask, "kind": "aposta", "assignment": assignment}
            self.assertEqual(league.act_opponents([entry]), [expected])

    def test_rollout_excludes_opponent_transitions_and_waits_for_four_finals(self):
        with tempfile.TemporaryDirectory() as directory:
            path, _, _ = write_manifest(directory)
            league = LeagueController(path, slot_seed=77)
            episode = next(ep for ep in range(20) if league.assignment(0, ep).mode != "self_play")
            assignment = league.assignment(0, episode)
            decisions = []
            finals = []
            summary = {
                "vencedor": 0, "rodadas": 1, "hpFinal": [3, 3, 3, 3],
                "metricasPorSeat": [
                    {"seat": seat, "rodadasJogadas": 1, "apostasExatas": 1,
                     "erroAbsolutoTotal": 0, "totalApostado": 0, "totalVazas": 0}
                    for seat in range(4)
                ],
            }
            for seat in range(4):
                decisions.append((0, {"episode": episode, "seat": seat, "kind": "aposta",
                                      "reward": 0.0, "done": False, "actionRequired": True,
                                      "obs": [0.0] * 110, "legalMask": [1] * 13}))
                finals.append((0, {"episode": episode, "seat": seat, "kind": "final",
                                   "reward": 1.0, "done": True, "actionRequired": False,
                                   "obs": None, "legalMask": None, "resumo": summary}))
            env = FakeEnv([decisions, finals[:1], finals[1:]])
            trajectories, metrics, _ = collect_rollout(
                env, ActorCritic(), {}, 1, False, league=league
            )
            self.assertEqual(env.get_calls, 3)
            self.assertEqual(len(env.actions), 4)
            self.assertEqual({key[2] for key in trajectories}, set(assignment.learner_seats))
            self.assertEqual(sum(map(len, trajectories.values())), len(assignment.learner_seats))
            self.assertEqual(metrics["league"]["actions"]["opponent"], 4 - len(assignment.learner_seats))
            self.assertEqual(metrics["league"]["ppo_transitions"], len(assignment.learner_seats))

    def test_clone_applies_lr_and_gets_independent_rng(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source.train.pt"
            model = ActorCritic()
            optimizer = torch.optim.Adam(model.parameters(), lr=1e-3)
            args = SimpleNamespace(lr=1e-3)
            random.seed(44)
            save_training_state(source, model=model, optimizer=optimizer, update=3, args=args)
            first, second = root / "first.pt", root / "second.pt"
            clone_training_state(source, first, seed=101, lr=2e-4, hparams={"epochs": 6})
            clone_training_state(source, second, seed=202, lr=2e-4)
            one = torch.load(first, map_location="cpu", weights_only=False)
            two = torch.load(second, map_location="cpu", weights_only=False)
            self.assertEqual(one["optimizer_state"]["param_groups"][0]["lr"], 2e-4)
            self.assertEqual(one["hparams"]["epochs"], 6)
            self.assertFalse(torch.equal(one["rng"]["torch"], two["rng"]["torch"]))
            for key, value in model.state_dict().items():
                self.assertTrue(torch.equal(value, one["model_state"][key]))

            restored_model = ActorCritic()
            restored_optimizer = torch.optim.Adam(restored_model.parameters())
            load_training_state(first, restored_model, restored_optimizer)
            self.assertEqual(restored_optimizer.param_groups[0]["lr"], 2e-4)


if __name__ == "__main__":
    unittest.main()

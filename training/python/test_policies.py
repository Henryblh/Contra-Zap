import tempfile
import unittest
from pathlib import Path

import torch

from model import ActorCritic
from policies import (
    HeuristicPolicy,
    PolicyError,
    PolicyFactory,
    RandomPolicy,
    legal_actions,
    policy_action,
    validate_action,
)


def sample_obs():
    return {
        "mao": [0.0] * 36,
        "mesa": [0.0] * 16,
        "hpApostaSteak": [0.0] * 16,
        "viraValor": 0.0,
        "cartasRodada": 0.25,
    }


class ExampleStrategy:
    def act(self, kind, obs, legal_mask, rng):
        return legal_actions(legal_mask)[0]


class PolicyTests(unittest.TestCase):
    def test_heuristic_matches_bot_brain(self):
        policy = HeuristicPolicy()
        self.assertEqual(policy.act("aposta", sample_obs(), [1, 1, 1], None), 1)
        self.assertEqual(policy.act("aposta", sample_obs(), [1, 0, 1], None), 0)
        self.assertEqual(policy.act("carta", sample_obs(), [1, 1, 0, 1], None), 3)

    def test_random_only_returns_legal_actions(self):
        import random

        policy = RandomPolicy()
        mask = [0, 1, 0, 1]
        for index in range(20):
            self.assertIn(policy.act("carta", sample_obs(), mask, random.Random(42 + index)), [1, 3])

    def test_invalid_action_is_rejected(self):
        with self.assertRaises(PolicyError):
            validate_action(2, [1, 0, 0], "test")
        with self.assertRaises(PolicyError):
            validate_action("1", [1, 1], "test")

    def test_loads_66_and_70_checkpoints(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for dim in (66, 70):
                path = root / f"model-{dim}.pt"
                torch.save(ActorCritic(obs_dim=dim).state_dict(), path)
                handle = PolicyFactory().create(f"checkpoint={path}")
                action = policy_action(handle, "aposta", sample_obs(), [1] * 13, None)
                self.assertIn(action, range(13))

    def test_rejects_checkpoint_with_nan(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "invalid.pt"
            state = ActorCritic().state_dict()
            state["trunk.0.weight"][0, 0] = float("nan")
            torch.save(state, path)
            with self.assertRaises(PolicyError):
                PolicyFactory().create(f"checkpoint={path}")

    def test_loads_custom_strategy(self):
        handle = PolicyFactory().create("strategy=test_policies:ExampleStrategy")
        self.assertEqual(policy_action(handle, "carta", sample_obs(), [0, 1, 1], None), 1)


if __name__ == "__main__":
    unittest.main()

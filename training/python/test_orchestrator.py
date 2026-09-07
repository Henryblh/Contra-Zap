import json
import tempfile
import unittest
from pathlib import Path

import torch

from league import LeagueController
from model import ActorCritic
from orquestrar_4dias import pfsp_weight, sha, update_matchups, write_league_manifests


class OrchestratorLeagueTests(unittest.TestCase):
    def test_writes_loadable_per_slot_manifest_and_updates_matchup(self):
        with tempfile.TemporaryDirectory() as directory:
            run = Path(directory)
            h, overnight = run / "H.pt", run / "overnight.pt"
            torch.save(ActorCritic(obs_dim=110).state_dict(), h)
            torch.save(ActorCritic(hidden=128, obs_dim=70).state_dict(), overnight)
            slot = {"id": "slot00", "dir": str(run / "slot00"), "seed": 12,
                    "matchups": {}, "hparams": {}, "lineage": []}
            state = {
                "seed": 123, "generation": 0, "slots": [slot], "league_history": [],
                "anchors": {"H": str(h), "overnight": str(overnight),
                            "sha256": {"H": sha(h), "overnight": sha(overnight)}},
            }
            write_league_manifests(run, state)
            manifest = json.loads(Path(slot["league_manifest"]).read_text(encoding="utf-8"))
            self.assertEqual(manifest["mixture"], {"self_play": .5, "historical": .35, "anchors": .15})
            self.assertEqual(next(x for x in manifest["opponents"] if x["id"] == "historical_H")["weight"], 1.0)
            LeagueController(slot["league_manifest"], slot_seed=slot["seed"])

            update_matchups(state, {"results": [{"candidate": "slot00", "context": "vs_history:historical_H",
                                                   "wins": 30, "appearances": 100}]})
            self.assertEqual(slot["matchups"]["historical_H"], {"wins": 30, "appearances": 100})
            write_league_manifests(run, state)
            updated = json.loads(Path(slot["league_manifest"]).read_text(encoding="utf-8"))
            historical = next(x for x in updated["opponents"] if x["id"] == "historical_H")
            expected_rate = 31 / 104
            self.assertAlmostEqual(historical["estimated_win_rate"], expected_rate)
            self.assertAlmostEqual(historical["weight"], pfsp_weight(expected_rate))


if __name__ == "__main__":
    unittest.main()

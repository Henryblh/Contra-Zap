import unittest

from evaluate import Tournament, parse_args


class EvaluateTests(unittest.TestCase):
    def test_seeded_versus_is_reproducible_and_rotates(self):
        args = parse_args([
            "versus", "--candidate", "heuristic", "--opponent", "random",
            "--games", "8", "--seed", "123",
        ])
        first = Tournament(args).run()
        second = Tournament(args).run()

        self.assertEqual(first["winner_sequence"], second["winner_sequence"])
        self.assertEqual(first["roles"], second["roles"])
        self.assertEqual(first["candidate_seat_counts"], {"0": 2, "1": 2, "2": 2, "3": 2})
        self.assertEqual(first["roles"]["candidate"]["wins"] + first["roles"]["opponent"]["wins"], 8)

    def test_lineup_records_all_seats(self):
        args = parse_args([
            "lineup", "--players", "heuristic", "random", "heuristic", "random",
            "--games", "4", "--seed", "9",
        ])
        report = Tournament(args).run()

        self.assertEqual(len(report["winner_sequence"]), 4)
        self.assertEqual(set(report["seats"]), {"0", "1", "2", "3"})
        self.assertEqual(sum(stats["wins"] for stats in report["seats"].values()), 4)


if __name__ == "__main__":
    unittest.main()

import unittest

from ppo import compute_gae


class GaeTests(unittest.TestCase):
    def test_terminal_does_not_bootstrap(self):
        advantages, returns = compute_gae([1.0], [2.0], [True], .99, .95, last_value=100.0)
        self.assertAlmostEqual(advantages[0], -1.0)
        self.assertAlmostEqual(returns[0], 1.0)

    def test_truncated_uses_bootstrap(self):
        advantages, returns = compute_gae([1.0], [2.0], [False], .99, .95, last_value=3.0)
        self.assertAlmostEqual(advantages[0], 1 + .99 * 3 - 2)
        self.assertAlmostEqual(returns[0], 1 + .99 * 3)


if __name__ == '__main__':
    unittest.main()

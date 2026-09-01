"""Torneio offline para bots do Contra ZAP.

Usa o mesmo GameController do servidor via env_bridge.js. Não altera BotBrain,
salas ou sockets de produção.
"""
from __future__ import annotations

import argparse
import json
import math
import random
import sys
import time
from collections import Counter, defaultdict
from datetime import datetime
from pathlib import Path

from env_client import EnvBridge
from policies import PolicyError, PolicyFactory, policy_action


RAIZ = Path(__file__).resolve().parent.parent
NUM_SEATS = 4
Z_95 = 1.959963984540054


def add_common_arguments(parser):
    parser.add_argument("--games", type=int, default=10_000, help="quantidade de partidas (padrão: 10000)")
    parser.add_argument("--seed", type=int, default=42, help="seed do baralho e de políticas aleatórias")
    parser.add_argument("--sample-models", action="store_true", help="amostra ações das redes em vez de usar argmax")
    parser.add_argument("--output", help="caminho do relatório JSON; por padrão cria um arquivo em training/logs")
    parser.add_argument("--node-bin", default="node", help="executável Node a usar (padrão: node)")


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description="Avalia bots no motor real do Contra ZAP.")
    subparsers = parser.add_subparsers(dest="mode", required=True)

    versus = subparsers.add_parser("versus", help="candidato contra três cópias do oponente, com rotação de assento")
    versus.add_argument("--candidate", required=True, help="checkpoint=<arquivo>, heuristic, random ou strategy=<módulo>:<Classe>")
    versus.add_argument("--opponent", required=True, help="descritor do oponente")
    add_common_arguments(versus)

    lineup = subparsers.add_parser("lineup", help="quatro bots escolhidos individualmente")
    lineup.add_argument("--players", nargs=NUM_SEATS, required=True, metavar="BOT", help="quatro descritores de bot")
    add_common_arguments(lineup)

    args = parser.parse_args(argv)
    if args.games <= 0:
        parser.error("--games deve ser maior que zero.")
    return args


def wilson_interval(wins, appearances):
    if appearances == 0:
        return [0.0, 0.0]
    p = wins / appearances
    denominator = 1 + Z_95 ** 2 / appearances
    center = (p + Z_95 ** 2 / (2 * appearances)) / denominator
    margin = Z_95 * math.sqrt((p * (1 - p) + Z_95 ** 2 / (4 * appearances)) / appearances) / denominator
    return [max(0.0, center - margin), min(1.0, center + margin)]


def new_stats():
    return {
        "appearances": 0,
        "wins": 0,
        "rounds_played": 0,
        "exact_bets": 0,
        "absolute_bid_error": 0,
        "total_bet": 0,
        "total_tricks": 0,
        "final_hp_total": 0,
        "actions": {"aposta": Counter(), "carta": Counter()},
    }


def add_record(stats, *, won, metrics, final_hp, actions):
    stats["appearances"] += 1
    stats["wins"] += int(won)
    stats["rounds_played"] += metrics["rodadasJogadas"]
    stats["exact_bets"] += metrics["apostasExatas"]
    stats["absolute_bid_error"] += metrics["erroAbsolutoTotal"]
    stats["total_bet"] += metrics["totalApostado"]
    stats["total_tricks"] += metrics["totalVazas"]
    stats["final_hp_total"] += final_hp
    for kind in ("aposta", "carta"):
        stats["actions"][kind].update(actions[kind])


def serialise_stats(stats, total_games):
    appearances = stats["appearances"]
    rounds = stats["rounds_played"]
    action_counts = {
        kind: {str(action): count for action, count in sorted(counts.items())}
        for kind, counts in stats["actions"].items()
    }
    return {
        "appearances": appearances,
        "wins": stats["wins"],
        "win_rate": stats["wins"] / appearances if appearances else 0.0,
        "win_rate_ci95": wilson_interval(stats["wins"], appearances),
        "win_share": stats["wins"] / total_games if total_games else 0.0,
        "rounds_played": rounds,
        "mean_absolute_bid_error": stats["absolute_bid_error"] / rounds if rounds else 0.0,
        "exact_bid_rate": stats["exact_bets"] / rounds if rounds else 0.0,
        "mean_bet": stats["total_bet"] / rounds if rounds else 0.0,
        "mean_tricks": stats["total_tricks"] / rounds if rounds else 0.0,
        "mean_final_hp": stats["final_hp_total"] / appearances if appearances else 0.0,
        "action_counts": action_counts,
    }


class Tournament:
    def __init__(self, args):
        self.args = args
        self.rng = random.Random(args.seed)
        self.factory = PolicyFactory(sample_models=args.sample_models)
        self.roles = defaultdict(new_stats)
        self.policies = defaultdict(new_stats)
        self.seats = {seat: new_stats() for seat in range(NUM_SEATS)}
        self.candidate_seats = Counter()
        self.winner_sequence = []
        self.game_rounds = []
        self.episodes = {}

        if args.mode == "versus":
            self.candidate = self.factory.create(args.candidate)
            self.opponent = self.factory.create(args.opponent)
            self.lineup = None
        else:
            self.candidate = self.opponent = None
            self.lineup = [self.factory.create(spec) for spec in args.players]

    def assignment_for_episode(self, episode):
        if self.args.mode == "versus":
            candidate_seat = episode % NUM_SEATS
            self.candidate_seats[candidate_seat] += 1
            handles = [self.opponent] * NUM_SEATS
            handles[candidate_seat] = self.candidate
            roles = ["opponent"] * NUM_SEATS
            roles[candidate_seat] = "candidate"
            return handles, roles
        return self.lineup, [f"seat{seat}" for seat in range(NUM_SEATS)]

    def episode_state(self, episode):
        if episode not in self.episodes:
            handles, roles = self.assignment_for_episode(episode)
            self.episodes[episode] = {
                "handles": handles,
                "roles": roles,
                "actions": [{"aposta": Counter(), "carta": Counter()} for _ in range(NUM_SEATS)],
                "finals": {},
            }
        return self.episodes[episode]

    def act(self, message, env):
        state = self.episode_state(message["episode"])
        seat = message["seat"]
        handle = state["handles"][seat]
        action = policy_action(handle, message["kind"], message["obs"], message["legalMask"], self.rng)
        state["actions"][seat][message["kind"]][action] += 1
        env.send_action(action)

    def final(self, message):
        episode = message["episode"]
        state = self.episode_state(episode)
        state["finals"][message["seat"]] = message
        if len(state["finals"]) != NUM_SEATS:
            return False

        summaries = [state["finals"][seat]["resumo"] for seat in range(NUM_SEATS)]
        summary = summaries[0]
        if any(other != summary for other in summaries[1:]):
            raise RuntimeError(f"Resumo inconsistente no episódio {episode}.")
        self._record_game(state, summary)
        del self.episodes[episode]
        return True

    def _record_game(self, state, summary):
        winner = summary.get("vencedor")
        metricas = summary.get("metricasPorSeat")
        hp_final = summary.get("hpFinal")
        if not isinstance(winner, int) or winner not in range(NUM_SEATS):
            raise RuntimeError(f"Resumo inválido: vencedor={winner!r}.")
        if not isinstance(metricas, list) or len(metricas) != NUM_SEATS:
            raise RuntimeError("Resumo inválido: metricasPorSeat deve conter quatro assentos.")
        if not isinstance(hp_final, list) or len(hp_final) != NUM_SEATS:
            raise RuntimeError("Resumo inválido: hpFinal deve conter quatro assentos.")

        metrics_by_seat = {metrics["seat"]: metrics for metrics in metricas}
        if set(metrics_by_seat) != set(range(NUM_SEATS)):
            raise RuntimeError("Resumo inválido: seats das métricas não correspondem a 0..3.")

        self.winner_sequence.append(winner)
        self.game_rounds.append(summary["rodadas"])
        for seat in range(NUM_SEATS):
            handle = state["handles"][seat]
            role = state["roles"][seat]
            metrics = metrics_by_seat[seat]
            actions = state["actions"][seat]
            won = seat == winner
            add_record(self.roles[role], won=won, metrics=metrics, final_hp=hp_final[seat], actions=actions)
            add_record(self.policies[handle.label], won=won, metrics=metrics, final_hp=hp_final[seat], actions=actions)
            add_record(self.seats[seat], won=won, metrics=metrics, final_hp=hp_final[seat], actions=actions)

            # O controlador subtrai exatamente o erro absoluto do HP; essa é
            # uma checagem de integridade das métricas novas do bridge.
            if metrics["erroAbsolutoTotal"] != 3 - hp_final[seat]:
                raise RuntimeError(
                    f"Métrica inconsistente no assento {seat}: erro={metrics['erroAbsolutoTotal']}, hp={hp_final[seat]}."
                )

    def run(self):
        completed = 0
        started = time.perf_counter()
        env = EnvBridge(self.args.node_bin, extra_env={"EVAL_SEED": self.args.seed})
        try:
            while completed < self.args.games:
                message = env.read_step()
                if message["actionRequired"]:
                    self.act(message, env)
                elif message["kind"] == "final" and self.final(message):
                    completed += 1
        finally:
            env.close()
        duration = time.perf_counter() - started
        return self.report(completed, duration)

    def report(self, games, duration):
        serialise_group = lambda group: {name: serialise_stats(stats, games) for name, stats in sorted(group.items())}
        config = {
            "mode": self.args.mode,
            "games": games,
            "seed": self.args.seed,
            "sample_models": self.args.sample_models,
            "number_players": NUM_SEATS,
            "round_start": 3,
        }
        if self.args.mode == "versus":
            config.update({"candidate": self.candidate.spec, "opponent": self.opponent.spec})
        else:
            config["players"] = [handle.spec for handle in self.lineup]

        return {
            "schema_version": 1,
            "generated_at": datetime.now().astimezone().isoformat(),
            "config": config,
            "duration_seconds": duration,
            "games_per_second": games / duration if duration else 0.0,
            "mean_game_rounds": sum(self.game_rounds) / games if games else 0.0,
            "winner_sequence": self.winner_sequence,
            "candidate_seat_counts": {str(seat): self.candidate_seats[seat] for seat in range(NUM_SEATS)} if self.args.mode == "versus" else None,
            "roles": serialise_group(self.roles),
            "policies": serialise_group(self.policies),
            "seats": {str(seat): serialise_stats(stats, games) for seat, stats in self.seats.items()},
        }


def default_output_path(mode):
    timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    return RAIZ / "logs" / f"evaluation-{mode}-{timestamp}.json"


def print_summary(report, output):
    print(f"\nAvaliação concluída: {report['config']['games']} partidas em {report['duration_seconds']:.1f}s "
          f"({report['games_per_second']:.2f} partidas/s).")
    print(f"Rodadas por partida: {report['mean_game_rounds']:.2f}\n")
    print(f"{'grupo':24} | {'vitórias':>8} | {'win rate':>10} | {'erro/aposta':>12} | {'acerto':>9} | {'HP final':>9}")
    print("-" * 93)
    for name, stats in report["roles"].items():
        print(
            f"{name:24} | {stats['wins']:8d} | {stats['win_rate'] * 100:9.2f}% | "
            f"{stats['mean_absolute_bid_error']:12.4f} | {stats['exact_bid_rate'] * 100:8.2f}% | "
            f"{stats['mean_final_hp']:9.3f}"
        )
    print(f"\nRelatório completo: {output}")


def main(argv=None):
    args = parse_args(argv)
    try:
        tournament = Tournament(args)
        report = tournament.run()
    except PolicyError as error:
        print(f"Erro de política: {error}", file=sys.stderr)
        return 2
    except RuntimeError as error:
        print(f"Erro na avaliação: {error}", file=sys.stderr)
        return 2

    output = Path(args.output) if args.output else default_output_path(args.mode)
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open("w", encoding="utf-8") as file:
        json.dump(report, file, ensure_ascii=False, indent=2)
        file.write("\n")
    print_summary(report, output)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

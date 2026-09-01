# progress.py
# Responde "estamos melhorando?" sem precisar rolar o terminal comparando de
# cabeça: lê o log (training/logs/*.jsonl, um JSON por update) e agrupa em
# janelas, mostrando a média de cada métrica por janela.
#
# Rodar (pode rodar enquanto o treino em outro terminal continua — só lê o
# arquivo, não mexe em nada):
#   training\.venv\Scripts\python.exe training\python\progress.py
#   training\.venv\Scripts\python.exe training\python\progress.py --window 500
import argparse
import json
from pathlib import Path


def main():
    p = argparse.ArgumentParser(description="Resume o log de treino em janelas, pra ver a tendência.")
    p.add_argument("log", nargs="?", default=str(Path(__file__).resolve().parent.parent / "logs" / "run1.jsonl"))
    p.add_argument("--window", type=int, default=200, help="quantos updates por janela")
    args = p.parse_args()

    with open(args.log, encoding="utf-8") as f:
        rows = [json.loads(linha) for linha in f if linha.strip()]

    print(f"{len(rows)} updates registrados em {args.log}\n")
    print(f"{'updates':>15} | {'diff/rodada':>12} | {'rodadas/ep':>10} | {'entropy(carta)':>14} | {'reward/assento':>14}")
    print("-" * 78)
    for i in range(0, len(rows), args.window):
        janela = rows[i:i + args.window]
        n = len(janela)
        diff = sum(r["mean_diferenca"] for r in janela) / n
        rodadas = sum(r["mean_rounds"] for r in janela) / n
        entropia = sum(r.get("carta_entropy", 0) for r in janela) / n
        reward = sum(r["mean_reward_per_seat"] for r in janela) / n
        faixa = f"{i}-{i + n - 1}"
        print(f"{faixa:>15} | {diff:12.4f} | {rodadas:10.2f} | {entropia:14.3f} | {reward:14.2f}")


if __name__ == "__main__":
    main()

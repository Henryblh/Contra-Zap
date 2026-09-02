# ranking.py -- varre training/logs/<prefixo>_*.jsonl e mostra um ranking
# por mean_diferenca (janela final) — pra acompanhar o funil sem escrever
# nada na mão.
#   training\.venv\Scripts\python.exe training\python\ranking.py
#   training\.venv\Scripts\python.exe training\python\ranking.py --prefixo overnight
import argparse
import glob
import json
from pathlib import Path

RAIZ = Path(__file__).resolve().parent.parent


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--prefixo", default="funil")
    p.add_argument("--janela", type=int, default=300)
    args = p.parse_args()

    padrao = str(RAIZ / "logs" / f"{args.prefixo}_*.jsonl")
    arquivos = sorted(glob.glob(padrao))
    if not arquivos:
        print(f"nenhum log encontrado em {padrao}")
        return

    linhas_ranking = []
    for arq in arquivos:
        nome = Path(arq).stem
        with open(arq, encoding="utf-8") as f:
            linhas = [json.loads(l) for l in f if l.strip()]
        if not linhas:
            continue
        janela = linhas[-args.janela:]
        diff = sum(r["mean_diferenca"] for r in janela) / len(janela)
        # nem todo log tem mean_rounds -- o especialista de round 1
        # (train_round1.py) não loga isso, cada episódio já é 1 rodada só.
        tem_rodadas = all("mean_rounds" in r for r in janela)
        rodadas = (sum(r["mean_rounds"] for r in janela) / len(janela)) if tem_rodadas else None
        linhas_ranking.append((nome, len(linhas), diff, rodadas))

    linhas_ranking.sort(key=lambda r: r[2])
    print(f"{'nome':<16} {'updates':>8} {'diff/rodada':>12} {'rodadas/ep':>11}")
    print("-" * 50)
    for nome, n, diff, rodadas in linhas_ranking:
        rodadas_str = f"{rodadas:.2f}" if rodadas is not None else "--"
        print(f"{nome:<16} {n:>8} {diff:>12.4f} {rodadas_str:>11}")


if __name__ == "__main__":
    main()

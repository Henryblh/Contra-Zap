# noite1.py -- retoma o grupo PBT "noite1" de onde parou e deixa treinando.
# Mesmo espírito de overnight.py/funil.py: não depende desta sessão do Claude
# Code continuar aberta, só do processo em si.
#
# O que faz: relança as 8 instâncias noite1_A..noite1_H com --resume (cada
# uma carrega seu proprio checkpoints/noite1_X.pt e continua), motor nativo,
# 16 slots por instancia, grupo PBT "noite1" -- exatamente a config com que
# esse lote foi treinado ate ~41k updates. Roda ate ser parado na mao.
#
# Rodar (deixa num terminal aberto, ou redireciona e fecha -- o processo
# sobrevive):
#   training\.venv\Scripts\python.exe training\python\noite1.py
#
# Acompanhar de outro terminal, sem mexer nisto:
#   training\.venv\Scripts\python.exe training\python\progress.py training\logs\noite1_H.jsonl
#   training\.venv\Scripts\python.exe training\python\ranking.py --prefixo noite1
#
# Parar: Ctrl+C aqui mata as 8 (os filhos morrem junto). Se o terminal foi
# fechado, mata "python.exe" pelo Gerenciador de Tarefas.
import argparse
import os
import subprocess
import sys
import time
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8")

RAIZ = Path(__file__).resolve().parent.parent
VENV_PY = RAIZ / ".venv" / "Scripts" / "python.exe"
TRAIN = Path(__file__).resolve().parent / "train.py"

GRUPO = "noite1"
INSTANCIAS = [f"{GRUPO}_{L}" for L in "ABCDEFGH"]


def caminho_ckpt(nome):
    return RAIZ / "checkpoints" / f"{nome}.pt"


def caminho_log(nome):
    return RAIZ / "logs" / f"{nome}.jsonl"


def lancar(nome, updates, num_workers):
    ckpt = caminho_ckpt(nome)
    resume = ckpt.exists()
    args = [
        str(VENV_PY), str(TRAIN),
        "--motor", "nativo",
        "--num-workers", str(num_workers),
        "--updates", str(updates),
        "--checkpoint", str(ckpt),
        "--log", str(caminho_log(nome)),
        "--checkpoint-every", "50",
        "--pbt-grupo", GRUPO,
        "--pbt-nome", nome,
    ]
    if resume:
        args.append("--resume")
    stdout_f = open(RAIZ / "logs" / f"{nome}.stdout.txt", "a", encoding="utf-8")
    proc = subprocess.Popen(args, stdout=stdout_f, stderr=subprocess.STDOUT)
    marca = "resume" if resume else "DO ZERO (checkpoint nao encontrado)"
    print(f"[{time.strftime('%H:%M:%S')}] {nome}: pid {proc.pid} ({marca})", flush=True)
    return proc


def main():
    p = argparse.ArgumentParser(description="Retoma o grupo PBT noite1 e deixa treinando ate ser parado.")
    p.add_argument("--num-workers", type=int, default=16, help="slots por instancia (motor nativo = 1 processo por instancia, 8 no total)")
    p.add_argument("--updates", type=int, default=10_000_000, help="alvo por instancia -- padrao efetivamente 'pra sempre', pare na mao")
    args = p.parse_args()

    print(f"=== noite1: retomando {len(INSTANCIAS)} instancias, {args.num_workers} slots cada, motor nativo ===", flush=True)
    procs = {nome: lancar(nome, args.updates, args.num_workers) for nome in INSTANCIAS}
    print("Ctrl+C aqui para parar todas.", flush=True)
    try:
        for proc in procs.values():
            proc.wait()
    except KeyboardInterrupt:
        print(f"[{time.strftime('%H:%M:%S')}] interrompido -- encerrando as 8", flush=True)
        for proc in procs.values():
            proc.terminate()


if __name__ == "__main__":
    main()

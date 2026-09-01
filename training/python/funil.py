# funil.py -- orquestra sozinho, não depende desta sessão do Claude Code
# continuar aberta. Três fases, afunilando:
#   Fase 1: 10 modelos do zero (4 "com flag" sem memória, 6 "mem" com
#   memória de cartas), motor nativo, até 5.000 updates cada.
#   Fase 2: os 5 melhores (por mean_diferenca) continuam até 10.000.
#   Fase 3: os 2 melhores desses continuam até 20.000. Termina ali --
#   diferente de overnight.py, não fica rodando pra sempre.
#
# Rodar:
#   training\.venv\Scripts\python.exe training\python\funil.py
#
# Acompanhar de outro terminal:
#   training\logs\funil.log -- decisões do orquestrador
#   training\logs\funil_<nome>.jsonl -- log normal de cada run (progress.py funciona nele)
import argparse
import json
import os
import subprocess
import sys
import time
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8")

RAIZ = Path(__file__).resolve().parent.parent
VENV_PY = RAIZ / ".venv" / "Scripts" / "python.exe"
TRAIN = Path(__file__).resolve().parent / "train.py"

def montar_configs(prefixo):
    letras_com = "ABCD"
    letras_mem = "ABCDEF"
    configs = [{"nome": f"{prefixo}_com{L}", "flag": "1", "mem": "0"} for L in letras_com]
    configs += [{"nome": f"{prefixo}_mem{L}", "flag": "1", "mem": "1"} for L in letras_mem]
    return configs

LOG_PATH = RAIZ / "logs" / "funil.log"
LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
_log_file = open(LOG_PATH, "a", encoding="utf-8")


def log(msg):
    linha = f"[{time.strftime('%H:%M:%S')}] {msg}"
    print(linha, flush=True)
    _log_file.write(linha + "\n")
    _log_file.flush()


def ckpt_path(nome):
    return RAIZ / "checkpoints" / f"{nome}.pt"


def log_path(nome):
    return RAIZ / "logs" / f"{nome}.jsonl"


def lancar(nome, flag, mem, updates, num_workers, resume):
    env = os.environ.copy()
    env["COM_FLAG_APOSTOU"] = flag
    env["COM_MEMORIA_CARTAS"] = mem
    args = [
        str(VENV_PY), str(TRAIN), "--motor", "nativo",
        "--num-workers", str(num_workers),
        "--updates", str(updates),
        "--checkpoint", str(ckpt_path(nome)),
        "--log", str(log_path(nome)),
        "--checkpoint-every", "50",
    ]
    if resume:
        args.append("--resume")
    stdout_f = open(RAIZ / "logs" / f"{nome}.stdout.txt", "a", encoding="utf-8")
    return subprocess.Popen(args, env=env, stdout=stdout_f, stderr=subprocess.STDOUT)


def esperar_todos(procs):
    while procs:
        time.sleep(15)
        for nome in list(procs):
            codigo = procs[nome].poll()
            if codigo is not None:
                if codigo != 0:
                    log(f"AVISO: {nome} terminou com exit code {codigo} (veja funil_{nome}.stdout.txt)")
                else:
                    log(f"{nome} terminou")
                del procs[nome]


def media_final(nome, metrica, janela=300):
    with open(log_path(nome), encoding="utf-8") as f:
        linhas = [json.loads(l) for l in f]
    if not linhas:
        return float("inf")
    fatia = linhas[-janela:]
    return sum(r[metrica] for r in fatia) / len(fatia)


def rodar_fase(nomes, flag_mem_de, updates_novos, num_workers, resume, titulo):
    log(f"=== {titulo}: {len(nomes)} instâncias, +{updates_novos} updates cada, {num_workers} workers, resume={resume} ===")
    procs = {nome: lancar(nome, *flag_mem_de[nome], updates_novos, num_workers, resume) for nome in nomes}
    log(f"PIDs: {[(n, p.pid) for n, p in procs.items()]}")
    esperar_todos(procs)

    resultados = {}
    for nome in nomes:
        try:
            resultados[nome] = media_final(nome, "mean_diferenca")
        except FileNotFoundError:
            resultados[nome] = float("inf")
    for nome, val in sorted(resultados.items(), key=lambda kv: kv[1]):
        log(f"  {nome}: diff/rodada = {val:.4f}")
    return resultados


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--num-workers", type=int, default=32)
    p.add_argument("--updates-fase1", type=int, default=5000)
    p.add_argument("--updates-fase2", type=int, default=5000)
    p.add_argument("--updates-fase3", type=int, default=10000)
    p.add_argument("--prefixo", default="funil")
    args = p.parse_args()

    configs = montar_configs(args.prefixo)
    flag_mem_de = {c["nome"]: (c["flag"], c["mem"]) for c in configs}
    todos_nomes = [c["nome"] for c in configs]

    r1 = rodar_fase(todos_nomes, flag_mem_de, args.updates_fase1, args.num_workers, resume=False, titulo="FASE 1 (10 -> 5.000)")
    top5 = sorted(r1, key=r1.get)[:5]
    log(f"top5 depois da fase 1: {top5}")

    r2 = rodar_fase(top5, flag_mem_de, args.updates_fase2, args.num_workers, resume=True, titulo="FASE 2 (5 -> 10.000)")
    top2 = sorted(r2, key=r2.get)[:2]
    log(f"top2 depois da fase 2: {top2}")

    rodar_fase(top2, flag_mem_de, args.updates_fase3, args.num_workers, resume=True, titulo="FASE 3 (2 -> 20.000)")
    log("=== FUNIL COMPLETO ===")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        log("interrompido manualmente")

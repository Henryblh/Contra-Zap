# overnight.py
# Orquestra a noite inteira sozinho -- não depende desta sessão do Claude
# Code continuar aberta, só do notebook ligado (lid action = "não fazer
# nada", como já configurado). Roda em duas fases:
#
#   Fase 1: 4 modelos do zero, em paralelo (2 com a flag "já apostou", 2
#   sem), cada um até --updates-fase1 updates.
#
#   Fase 2: compara os 4 pela média de mean_diferenca (erro de aposta) nos
#   últimos 500 updates -- menor é melhor, é o sinal mais direto e menos
#   ruidoso que temos (uma amostra por rodada, não por partida). O melhor
#   "com flag" e o melhor "sem flag" continuam treinando (--resume a partir
#   do checkpoint da fase 1), agora sozinhos com mais workers cada, até
#   serem parados manualmente.
#
# Rodar (deixa num terminal aberto a noite toda, ou redireciona pra arquivo
# e fecha o terminal -- o processo em si sobrevive):
#   training\.venv\Scripts\python.exe training\python\overnight.py
#
# Pra acompanhar de outro terminal a qualquer momento, sem mexer nisto:
#   training\.venv\Scripts\python.exe training\python\progress.py training\logs\<nome>.jsonl
#
# Pra parar de vez: Ctrl+C aqui mata a fase em andamento; os processos de
# treino (python.exe/node.exe) filhos morrem junto. Se o terminal foi
# fechado, mata pelo Gerenciador de Tarefas (procura "python.exe"/"node.exe").
import argparse
import json
import os
import subprocess
import sys
import time
from pathlib import Path

# Console do Windows por padrão não usa UTF-8 -- sem isso, acento vira
# caractere quebrado no terminal (o arquivo de log continua correto de
# qualquer jeito, é só a tela que ficava errada).
sys.stdout.reconfigure(encoding="utf-8")

RAIZ = Path(__file__).resolve().parent.parent
VENV_PY = RAIZ / ".venv" / "Scripts" / "python.exe"
TRAIN = Path(__file__).resolve().parent / "train.py"

CONFIGS = [
    {"nome": "overnight_comA", "flag": "1"},
    {"nome": "overnight_comB", "flag": "1"},
    {"nome": "overnight_semA", "flag": "0"},
    {"nome": "overnight_semB", "flag": "0"},
]

LOG_PATH = RAIZ / "logs" / "overnight.log"
LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
_log_file = open(LOG_PATH, "a", encoding="utf-8")


def log(msg):
    linha = f"[{time.strftime('%H:%M:%S')}] {msg}"
    print(linha, flush=True)
    _log_file.write(linha + "\n")
    _log_file.flush()


def caminho_ckpt(nome):
    return RAIZ / "checkpoints" / f"{nome}.pt"


def caminho_log(nome):
    return RAIZ / "logs" / f"{nome}.jsonl"


def lancar(nome, flag, updates, num_workers, resume=False):
    env = os.environ.copy()
    env["COM_FLAG_APOSTOU"] = flag
    args = [
        str(VENV_PY), str(TRAIN),
        "--num-workers", str(num_workers),
        "--updates", str(updates),
        "--checkpoint", str(caminho_ckpt(nome)),
        "--log", str(caminho_log(nome)),
        "--checkpoint-every", "50",
    ]
    if resume:
        args.append("--resume")
    stdout_f = open(RAIZ / "logs" / f"{nome}.stdout.txt", "a", encoding="utf-8")
    return subprocess.Popen(args, env=env, stdout=stdout_f, stderr=subprocess.STDOUT)


def esperar_todos(procs: dict):
    while procs:
        time.sleep(30)
        for nome in list(procs):
            codigo = procs[nome].poll()
            if codigo is not None:
                log(f"{nome} terminou (exit code {codigo})")
                del procs[nome]


def media_final(nome, metrica, janela):
    with open(caminho_log(nome), encoding="utf-8") as f:
        linhas = [json.loads(l) for l in f]
    if not linhas:
        return float("inf")
    fatia = linhas[-janela:]
    return sum(r[metrica] for r in fatia) / len(fatia)


def parse_args():
    p = argparse.ArgumentParser(description="Treina 4 modelos do zero (2 com flag, 2 sem), compara, e continua só os 2 campeões.")
    p.add_argument("--updates-fase1", type=int, default=20_000)
    p.add_argument("--workers-fase1", type=int, default=3, help="por run -- 4 runs concorrentes, default 3x4=12 processos node")
    p.add_argument("--workers-fase2", type=int, default=6, help="só 2 runs sobram na fase 2, dá pra dar mais workers pra cada")
    p.add_argument("--janela-comparacao", type=int, default=500, help="quantos updates finais da fase 1 usar pra decidir o campeão")
    p.add_argument("--prefixo", default="overnight", help="prefixo dos nomes de run (checkpoints/logs) -- troque pra não colidir com uma run anterior")
    return p.parse_args()


def main():
    args = parse_args()
    configs = [
        {"nome": f"{args.prefixo}_comA", "flag": "1"},
        {"nome": f"{args.prefixo}_comB", "flag": "1"},
        {"nome": f"{args.prefixo}_semA", "flag": "0"},
        {"nome": f"{args.prefixo}_semB", "flag": "0"},
    ]

    log(f"=== FASE 1: 4 modelos do zero, {args.updates_fase1} updates cada, {args.workers_fase1} workers cada ===")
    procs = {c["nome"]: lancar(c["nome"], c["flag"], args.updates_fase1, args.workers_fase1) for c in configs}
    log(f"PIDs: {[(n, p.pid) for n, p in procs.items()]}")
    esperar_todos(procs)

    log(f"=== FASE 1 completa -- comparando por mean_diferenca (janela de {args.janela_comparacao} updates) ===")
    resultados = {}
    for c in configs:
        try:
            resultados[c["nome"]] = media_final(c["nome"], "mean_diferenca", args.janela_comparacao)
        except FileNotFoundError:
            resultados[c["nome"]] = float("inf")
    for nome, val in sorted(resultados.items(), key=lambda kv: kv[1]):
        log(f"  {nome}: diff/rodada = {val:.4f}")

    flag_de = {c["nome"]: c["flag"] for c in configs}
    melhor_com = min((c["nome"] for c in configs if c["flag"] == "1"), key=lambda n: resultados[n])
    melhor_sem = min((c["nome"] for c in configs if c["flag"] == "0"), key=lambda n: resultados[n])
    log(f"campeões -- com flag: {melhor_com} ({resultados[melhor_com]:.4f}) | sem flag: {melhor_sem} ({resultados[melhor_sem]:.4f})")

    log(f"=== FASE 2: só os campeões, {args.workers_fase2} workers cada, até serem parados manualmente ===")
    finais = {
        melhor_com: lancar(melhor_com, flag_de[melhor_com], 10_000_000, args.workers_fase2, resume=True),
        melhor_sem: lancar(melhor_sem, flag_de[melhor_sem], 10_000_000, args.workers_fase2, resume=True),
    }
    log(f"PIDs finais: {[(n, p.pid) for n, p in finais.items()]} -- Ctrl+C ou Gerenciador de Tarefas pra parar")
    for p in finais.values():
        p.wait()


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        log("interrompido manualmente")

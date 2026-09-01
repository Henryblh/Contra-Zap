# env_client.py
# Lado Python do protocolo definido em training/env_bridge.js: dá spawn no
# Node como subprocesso e conversa com ele por stdin/stdout, uma linha JSON
# por mensagem. Não sabe nada de regra do jogo — só fala o protocolo.
import json
import subprocess
import sys
from pathlib import Path

BRIDGE_PATH = Path(__file__).resolve().parent.parent / "env_bridge.js"


def flatten_obs(obs):
    # Ordem tem que bater com training/env_bridge.js:construirObs e com
    # model.OBS_DIM (mao, mesa, hpApostaSteak, viraValor, cartasRodada).
    vec = list(obs["mao"]) + list(obs["mesa"]) + list(obs["hpApostaSteak"])
    vec.append(obs["viraValor"])
    vec.append(obs["cartasRodada"])
    return vec


class EnvBridge:
    def __init__(self, node_bin="node"):
        self.proc = subprocess.Popen(
            [node_bin, str(BRIDGE_PATH)],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=sys.stderr,
            text=True, bufsize=1,
        )

    def read_step(self):
        linha = self.proc.stdout.readline()
        if not linha:
            codigo = self.proc.poll()
            raise RuntimeError(f"env_bridge.js encerrou inesperadamente (exit code {codigo}) — veja o stderr acima")
        return json.loads(linha)

    def send_action(self, action):
        self.proc.stdin.write(json.dumps({"action": int(action)}) + "\n")
        self.proc.stdin.flush()

    def close(self):
        self.proc.terminate()
        try:
            self.proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.proc.kill()

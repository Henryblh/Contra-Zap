# env_client.py
# Lado Python do protocolo definido em training/env_bridge.js: dá spawn no
# Node como subprocesso e conversa com ele por stdin/stdout, uma linha JSON
# por mensagem. Não sabe nada de regra do jogo — só fala o protocolo.
import json
import os
import queue
import subprocess
import sys
import threading
from pathlib import Path

BRIDGE_PATH = Path(__file__).resolve().parent.parent / "env_bridge.js"


def flatten_obs(obs):
    # Ordem tem que bater com training/env_bridge.js:construirObs e com
    # model.OBS_DIM (mao, mesa, hpApostaSteak, viraValor, cartasRodada,
    # memoria se COM_MEMORIA_CARTAS -- o campo só existe na mensagem quando
    # a flag está ligada do lado Node, daí o .get()).
    vec = list(obs["mao"]) + list(obs["mesa"]) + list(obs["hpApostaSteak"])
    vec.append(obs["viraValor"])
    vec.append(obs["cartasRodada"])
    if "memoria" in obs:
        vec.extend(obs["memoria"])
    return vec


def _env_com_overrides(extra_env):
    env = os.environ.copy()
    if extra_env:
        env.update({str(chave): str(valor) for chave, valor in extra_env.items()})
    return env


class EnvBridge:
    def __init__(self, node_bin="node", extra_env=None):
        self.proc = subprocess.Popen(
            [node_bin, str(BRIDGE_PATH)],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=sys.stderr,
            text=True, bufsize=1, env=_env_com_overrides(extra_env),
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
        try:
            if self.proc.poll() is None:
                self.proc.terminate()
                try:
                    self.proc.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    self.proc.kill()
                    self.proc.wait(timeout=5)
        finally:
            for stream in (self.proc.stdin, self.proc.stdout):
                if stream and not stream.closed:
                    stream.close()


class _Worker:
    # Um subprocesso env_bridge.js + a thread que só fica lendo o stdout
    # dele e empilhando na fila compartilhada (`inbox`) — Windows não deixa
    # dar `select()` em pipe de processo como faria com socket, então uma
    # thread bloqueada em readline() por worker é o jeito portável de "me
    # avisa quando qualquer um dos N tiver mensagem nova".
    def __init__(self, worker_id, node_bin, inbox, extra_env=None):
        self.id = worker_id
        self.proc = subprocess.Popen(
            [node_bin, str(BRIDGE_PATH)],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=sys.stderr,
            text=True, bufsize=1, env=_env_com_overrides(extra_env),
        )
        self.inbox = inbox
        threading.Thread(target=self._read_loop, daemon=True).start()

    def _read_loop(self):
        for linha in self.proc.stdout:
            self.inbox.put((self.id, json.loads(linha)))
        self.inbox.put((self.id, None))  # stdout fechou -- processo morreu

    def send_action(self, action):
        self.proc.stdin.write(json.dumps({"action": int(action)}) + "\n")
        self.proc.stdin.flush()

    def close(self):
        try:
            if self.proc.poll() is None:
                self.proc.terminate()
                try:
                    self.proc.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    self.proc.kill()
                    self.proc.wait(timeout=5)
        finally:
            for stream in (self.proc.stdin, self.proc.stdout):
                if stream and not stream.closed:
                    stream.close()


class VecEnvBridge:
    # N env_bridge.js rodando em paralelo (um processo por partida), cada
    # um jogando sua própria sequência de episódios sem parar. `get_batch`
    # bloqueia só pela primeira mensagem disponível e depois drena o que já
    # estiver pronto na fila sem esperar mais nada — vira um lote pra fazer
    # UM forward pass da rede em vez de um por decisão (ver train.py).
    def __init__(self, num_workers, node_bin="node", extra_env=None):
        self.inbox = queue.Queue()
        self.workers = [_Worker(i, node_bin, self.inbox, extra_env=extra_env) for i in range(num_workers)]

    def get_batch(self):
        msgs = [self.inbox.get()]
        while True:
            try:
                msgs.append(self.inbox.get_nowait())
            except queue.Empty:
                break
        for worker_id, msg in msgs:
            if msg is None:
                codigo = self.workers[worker_id].proc.poll()
                raise RuntimeError(f"worker {worker_id} encerrou inesperadamente (exit code {codigo}) — veja o stderr acima")
        return msgs

    def send_action(self, worker_id, action):
        self.workers[worker_id].send_action(action)

    def close(self):
        for w in self.workers:
            w.close()

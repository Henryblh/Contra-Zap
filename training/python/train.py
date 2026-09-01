# train.py
# Self-play com PPO pro bot do Contra ZAP. Node (training/env_bridge.js) é o
# ambiente — as regras de verdade do jogo, o motor de produção mesmo, sem
# nada reimplementado aqui. Este arquivo só treina a rede (training/python/
# model.py) que decide as ações.
#
# Rodar (de dentro de training/python, com a venv em training/.venv ativada):
#   ..\.venv\Scripts\python.exe train.py
#   ..\.venv\Scripts\python.exe train.py --render-every 20   (mostra 1 partida completa a cada 20 updates)
#
# Roda --num-workers partidas de self-play em paralelo (um processo
# env_bridge.js por partida) em vez de uma por vez — ver VecEnvBridge em
# env_client.py. O ganho não é só CPU ociosa: sempre que mais de um worker
# tem decisão pendente ao mesmo tempo, a rede processa todas elas num único
# forward pass em lote (ver collect_rollout), em vez de um por decisão.
# Ajuste pro número de núcleos da máquina — default deixa uma folga pro SO.
#
# A cada update imprime uma linha de progresso no console e acrescenta um
# JSON em training/logs/train.jsonl. Checkpoint salvo em
# training/checkpoints/latest.pt a cada --checkpoint-every updates (dá pra
# retomar carregando esse arquivo, ou plugar em bots/BotBrain.js depois pra
# inferência real).
import argparse
import json
import os
import time
from collections import defaultdict
from pathlib import Path

import numpy as np
import torch

# A rede tem ~29 mil parâmetros — o pool de threads intra-op do PyTorch
# (OpenMP/MKL, liga sozinho usando todos os núcleos por padrão) só atrapalha
# aqui: pra uma conta desse tamanho o overhead de coordenar várias threads
# custa mais que a conta em si, e essas threads competem pelos mesmos
# núcleos que os processos Node dos workers precisam. Precisa vir ANTES de
# qualquer forward pass (por isso logo no import, antes de tudo mais).
torch.set_num_threads(1)

from env_client import VecEnvBridge, flatten_obs
from harness_nativo import VecEnvNativo
from model import ActorCritic, MAX_HAND
from ppo import masked_categorical, ppo_update

RAIZ = Path(__file__).resolve().parent.parent


def parse_args():
    p = argparse.ArgumentParser(description="Treina o bot do Contra ZAP por self-play com PPO.")
    p.add_argument("--episodes-per-update", type=int, default=20)
    p.add_argument("--updates", type=int, default=100_000)
    p.add_argument("--num-workers", type=int, default=min(8, os.cpu_count() or 4),
                    help="partidas de self-play em paralelo (default: 8 ou o nº de núcleos, o que for menor)")
    p.add_argument("--motor", choices=["subprocess", "nativo"], default="subprocess",
                    help="subprocess = env_bridge.js via Node (regra de produção real); "
                         "nativo = training/python/motor/ direto em Python (mais rápido, regra duplicada)")
    p.add_argument("--lr", type=float, default=3e-4)
    p.add_argument("--gamma", type=float, default=0.99)
    p.add_argument("--gae-lambda", type=float, default=0.95)
    p.add_argument("--clip-eps", type=float, default=0.2)
    p.add_argument("--entropy-coef", type=float, default=0.01)
    p.add_argument("--epochs", type=int, default=4)
    p.add_argument("--minibatch-size", type=int, default=256)
    p.add_argument("--checkpoint", default=str(RAIZ / "checkpoints" / "latest.pt"))
    p.add_argument("--checkpoint-every", type=int, default=50)
    p.add_argument("--resume", action="store_true", help="carrega o checkpoint acima antes de começar, em vez de pesos do zero")
    p.add_argument("--log", default=str(RAIZ / "logs" / "train.jsonl"))
    p.add_argument("--render-every", type=int, default=0, help="imprime o resumo de 1 partida a cada N updates (0 = nunca)")
    return p.parse_args()


def collect_rollout(vec_env, model, pending, episodes_per_update, render_this_update):
    # `pending` é do chamador (não recriado aqui) — uma transição pode ficar
    # em aberto bem no instante em que este update para de coletar; se o
    # dict fosse recriado a cada chamada, a próxima mensagem que fecharia
    # essa transição chegaria sem achar o par dela e o reward seria
    # descartado. Persistindo entre chamadas, ela só fecha uma call depois.
    trajectories = defaultdict(list)      # (worker_id, episode, seat) -> lista de transições fechadas

    episodes_completed = set()            # (worker_id, episode) -- só conta episódio que de fato FECHOU
    reward_por_ep = defaultdict(float)
    diferenca_samples = []                # -reward de mensagens não-finais == |aposta-steak| da rodada anterior
    rodadas_por_ep = {}
    resumo_amostra = None                 # 1 resumo pra --render-every, se pedido

    while len(episodes_completed) < episodes_per_update:
        # bloqueia só pela primeira mensagem; o resto do lote é o que mais
        # já estiver pronto na fila NESSE instante — nenhum worker é feito
        # esperar mais que isso, então não perde paralelismo.
        batch = vec_env.get_batch()
        pendentes_aposta, pendentes_carta = [], []

        for worker_id, msg in batch:
            ep, seat, kind = msg["episode"], msg["seat"], msg["kind"]
            ep_key = (worker_id, ep)
            reward_por_ep[ep_key] += msg["reward"]
            if kind != "final":
                diferenca_samples.append(-msg["reward"])
            else:
                episodes_completed.add(ep_key)
                rodadas_por_ep[ep_key] = msg["resumo"]["rodadas"]
                if render_this_update and resumo_amostra is None:
                    resumo_amostra = msg["resumo"]

            pkey = (worker_id, seat)
            if pkey in pending:
                aberto = pending.pop(pkey)
                trajectories[(worker_id, aberto["episode"], seat)].append(
                    {**aberto, "reward": msg["reward"], "done": msg["done"]}
                )

            if msg["actionRequired"]:
                # guarda a observação crua (lista python) -- criar o tensor
                # aqui, um por mensagem, é exatamente o desperdício que
                # estamos cortando: cada torch.tensor() sozinho paga um
                # overhead fixo de despacho que não precisa repetir.
                # O motor nativo já devolve a lista achatada direto (evita
                # montar um dict só pra desmontar de novo); o motor via
                # subprocess ainda manda o formato de dicionário do protocolo.
                obs_lista = msg["obs"] if isinstance(msg["obs"], list) else flatten_obs(msg["obs"])
                entry = (worker_id, seat, ep, obs_lista, msg["legalMask"])
                (pendentes_aposta if kind == "aposta" else pendentes_carta).append(entry)

        # um forward pass e UMA amostragem por grupo (aposta/carta), pro
        # lote inteiro de uma vez -- monta um array numpy primeiro (rápido,
        # sem overhead de tensor por elemento), um torch.from_numpy() só, e
        # a distribuição/amostra/log-prob também batelados (nada de
        # Categorical + .sample() + .item() um por um num loop Python).
        for grupo, kind in ((pendentes_aposta, "aposta"), (pendentes_carta, "carta")):
            if not grupo:
                continue
            obs_np = np.array([g[3] for g in grupo], dtype=np.float32)
            obs_batch = torch.from_numpy(obs_np)
            mask_batch = torch.tensor([g[4] for g in grupo], dtype=torch.bool)

            with torch.no_grad():
                aposta_logits, carta_logits, values = model(obs_batch)
                logits = aposta_logits if kind == "aposta" else carta_logits
                dist = masked_categorical(logits, mask_batch)
                actions = dist.sample()
                logps = dist.log_prob(actions)

            acoes = actions.tolist()
            logps_lista = logps.tolist()
            valores_lista = values.tolist()

            for i, (worker_id, seat, ep, _obs_lista, mask) in enumerate(grupo):
                pending[(worker_id, seat)] = {
                    "episode": ep, "obs": obs_batch[i], "kind": kind,
                    "action": acoes[i], "logp": logps_lista[i],
                    "value": valores_lista[i], "mask": mask,
                }
                vec_env.send_action(worker_id, acoes[i])

    metrics = {
        "episodes": len(episodes_completed),
        "mean_reward_per_seat": float(np.mean(list(reward_por_ep.values()))) / 4 if reward_por_ep else 0.0,
        "mean_diferenca": float(np.mean(diferenca_samples)) if diferenca_samples else 0.0,
        "mean_rounds": float(np.mean(list(rodadas_por_ep.values()))) if rodadas_por_ep else 0.0,
    }
    return trajectories, metrics, resumo_amostra


def main():
    args = parse_args()
    Path(args.checkpoint).parent.mkdir(parents=True, exist_ok=True)
    Path(args.log).parent.mkdir(parents=True, exist_ok=True)

    model = ActorCritic()
    if args.resume and Path(args.checkpoint).exists():
        model.load_state_dict(torch.load(args.checkpoint))
        print(f"retomando de {args.checkpoint}")
    optimizer = torch.optim.Adam(model.parameters(), lr=args.lr)

    ClasseEnv = VecEnvNativo if args.motor == "nativo" else VecEnvBridge
    vec_env = ClasseEnv(num_workers=args.num_workers)
    print(f"{args.num_workers} partidas em paralelo -- motor: {args.motor}")
    log_file = open(args.log, "a")
    pending = {}  # persiste entre updates -- ver comentário no topo de collect_rollout

    try:
        for update in range(args.updates):
            render_this_update = args.render_every > 0 and update % args.render_every == 0
            t0 = time.time()
            trajectories, metrics, resumo = collect_rollout(vec_env, model, pending, args.episodes_per_update, render_this_update)
            ppo_stats = ppo_update(model, optimizer, trajectories, args)
            dt = time.time() - t0

            registro = {"update": update, "segundos": round(dt, 2), **metrics, **ppo_stats}
            log_file.write(json.dumps(registro) + "\n")
            log_file.flush()

            print(
                f"update {update:5d} | {dt:5.1f}s | ep {metrics['episodes']:3d} | "
                f"rodadas/ep {metrics['mean_rounds']:5.2f} | diff/rodada {metrics['mean_diferenca']:5.3f} | "
                f"reward/assento {metrics['mean_reward_per_seat']:6.2f} | "
                f"pi_loss {ppo_stats.get('carta_policy_loss', 0):.4f} | "
                f"entropy {ppo_stats.get('carta_entropy', 0):.3f} | "
                f"kl {ppo_stats.get('carta_approx_kl', 0):.4f}"
            )
            if resumo is not None:
                print(f"  exemplo de partida: vencedor=assento{resumo['vencedor']} "
                      f"rodadas={resumo['rodadas']} hp_final={resumo['hpFinal']}")

            if update % args.checkpoint_every == 0:
                torch.save(model.state_dict(), args.checkpoint)
    finally:
        vec_env.close()
        log_file.close()


if __name__ == "__main__":
    main()

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
# A cada update imprime uma linha de progresso no console e acrescenta um
# JSON em training/logs/train.jsonl. Checkpoint salvo em
# training/checkpoints/latest.pt a cada --checkpoint-every updates (dá pra
# retomar carregando esse arquivo, ou plugar em bots/BotBrain.js depois pra
# inferência real).
import argparse
import json
import time
from collections import defaultdict
from pathlib import Path

import numpy as np
import torch

from env_client import EnvBridge, flatten_obs
from model import ActorCritic, MAX_HAND
from ppo import masked_categorical, ppo_update

RAIZ = Path(__file__).resolve().parent.parent


def parse_args():
    p = argparse.ArgumentParser(description="Treina o bot do Contra ZAP por self-play com PPO.")
    p.add_argument("--episodes-per-update", type=int, default=20)
    p.add_argument("--updates", type=int, default=100_000)
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


def collect_rollout(env, model, episodes_per_update, render_this_update):
    pending = {}                          # seat -> transição aberta, esperando reward/done
    trajectories = defaultdict(list)      # (episode, seat) -> lista de transições fechadas

    episodes_seen = set()
    reward_por_ep = defaultdict(float)
    diferenca_samples = []                # -reward de mensagens não-finais == |aposta-steak| da rodada anterior
    rodadas_por_ep = {}
    resumo_amostra = None                 # 1 resumo pra --render-every, se pedido

    while len(episodes_seen) < episodes_per_update:
        msg = env.read_step()
        ep, seat, kind = msg["episode"], msg["seat"], msg["kind"]
        episodes_seen.add(ep)
        reward_por_ep[ep] += msg["reward"]
        if kind != "final":
            diferenca_samples.append(-msg["reward"])
        else:
            rodadas_por_ep[ep] = msg["resumo"]["rodadas"]
            if render_this_update and resumo_amostra is None:
                resumo_amostra = msg["resumo"]

        if seat in pending:
            aberto = pending.pop(seat)
            trajectories[(aberto["episode"], seat)].append({**aberto, "reward": msg["reward"], "done": msg["done"]})

        if msg["actionRequired"]:
            obs_vec = torch.tensor(flatten_obs(msg["obs"]), dtype=torch.float32)
            with torch.no_grad():
                aposta_logits, carta_logits, value = model(obs_vec.unsqueeze(0))
            logits = (aposta_logits if kind == "aposta" else carta_logits).squeeze(0)
            dist = masked_categorical(logits, msg["legalMask"])
            action = dist.sample()

            pending[seat] = {
                "episode": ep, "obs": obs_vec, "kind": kind,
                "action": action.item(), "logp": dist.log_prob(action).item(),
                "value": value.item(), "mask": msg["legalMask"],
            }
            env.send_action(action.item())

    metrics = {
        "episodes": len(episodes_seen),
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

    env = EnvBridge()
    log_file = open(args.log, "a")

    try:
        for update in range(args.updates):
            render_this_update = args.render_every > 0 and update % args.render_every == 0
            t0 = time.time()
            trajectories, metrics, resumo = collect_rollout(env, model, args.episodes_per_update, render_this_update)
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
        env.close()
        log_file.close()


if __name__ == "__main__":
    main()

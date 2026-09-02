# train_round1.py -- treina só o especialista da rodada cega (round==1).
# Mais simples que train.py: só existe uma cabeça de decisão (aposta 0/1),
# cada episódio é 1 rodada só (ver harness_round1.py pro porquê disso não
# ser um mismatch com o jogo de verdade).
#
# Rodar:
#   ..\.venv\Scripts\python.exe train_round1.py
#   ..\.venv\Scripts\python.exe train_round1.py --updates 5000 --checkpoint ..\checkpoints\round1_A.pt --log ..\logs\round1_A.jsonl
import argparse
import json
import sys
import time
from collections import defaultdict, deque
from pathlib import Path

import numpy as np
import torch

sys.stdout.reconfigure(encoding="utf-8")
torch.set_num_threads(1)  # mesma razão de train.py -- rede minúscula, não precisa de mais de 1 thread

import pbt
from harness_round1 import VecEnvRound1Nativo
from model_round1 import ModeloRound1
from ppo import masked_categorical, compute_gae

RAIZ = Path(__file__).resolve().parent.parent


def parse_args():
    p = argparse.ArgumentParser(description="Treina o especialista da rodada cega (round==1) por self-play com PPO.")
    p.add_argument("--num-workers", type=int, default=32)
    p.add_argument("--episodes-per-update", type=int, default=200, help="episódios são bem curtos (1 rodada), pode usar bem mais que train.py")
    p.add_argument("--updates", type=int, default=5000)
    p.add_argument("--lr", type=float, default=3e-4)
    p.add_argument("--gamma", type=float, default=0.99)
    p.add_argument("--gae-lambda", type=float, default=0.95)
    p.add_argument("--clip-eps", type=float, default=0.2)
    p.add_argument("--entropy-coef", type=float, default=0.01, help="usado como valor INICIAL se --entropy-coef-final for passado")
    p.add_argument("--entropy-coef-final", type=float, default=None,
                    help="se passado, decai linearmente de --entropy-coef até este valor ao longo de --updates (em vez de ficar fixo)")
    p.add_argument("--epochs", type=int, default=4)
    p.add_argument("--minibatch-size", type=int, default=256)
    p.add_argument("--checkpoint", default=str(RAIZ / "checkpoints" / "round1_latest.pt"))
    p.add_argument("--checkpoint-every", type=int, default=50)
    p.add_argument("--resume", action="store_true")
    p.add_argument("--log", default=str(RAIZ / "logs" / "round1_latest.jsonl"))
    p.add_argument("--janela-melhor", type=int, default=100,
                    help="tamanho da média móvel usada pra decidir 'é o melhor até agora' (evita salvar em cima de ruído de 1 update)")

    # PBT leve entre processos separados -- cada instância escreve seu placar
    # num arquivo compartilhado, olha as outras do mesmo grupo, e se estiver
    # perdendo, copia os pesos da melhor e ganha um empurrão de entropia
    # temporário (exploit + explore, ver discussão sobre PBT).
    p.add_argument("--pbt-grupo", default=None, help="nome do grupo -- só compete com outras instâncias do MESMO grupo. None = PBT desligado.")
    p.add_argument("--pbt-nome", default=None, help="identidade desta instância dentro do grupo (default: nome do arquivo de checkpoint)")
    p.add_argument("--pbt-every", type=int, default=250, help="a cada quantos updates checa o placar e possivelmente copia a melhor")
    p.add_argument("--pbt-margem", type=float, default=0.02, help="só copia se a melhor estiver pelo menos essa fração melhor (evita copiar por ruído)")
    p.add_argument("--pbt-boost", type=float, default=0.08, help="entropy_coef temporário aplicado logo depois de copiar (força reexploração a partir do ponto bom)")
    p.add_argument("--pbt-boost-duracao", type=int, default=150, help="por quantos updates o boost de entropia dura antes de voltar ao normal")
    return p.parse_args()


def collect_rollout(vec_env, model, pending, episodes_per_update):
    trajectories = defaultdict(list)  # (worker_id, episode, seat) -> transições
    episodes_completed = set()
    diferenca_samples = []

    while len(episodes_completed) < episodes_per_update:
        batch = vec_env.get_batch()
        pendentes = []

        for worker_id, msg in batch:
            ep, seat, kind = msg["episode"], msg["seat"], msg["kind"]
            ep_key = (worker_id, ep)
            if kind == "final":
                episodes_completed.add(ep_key)
                diferenca_samples.append(-msg["reward"])
            pkey = (worker_id, seat)
            if pkey in pending:
                aberto = pending.pop(pkey)
                trajectories[(worker_id, aberto["episode"], seat)].append(
                    {**aberto, "reward": msg["reward"], "done": msg["done"]}
                )
            if msg["actionRequired"]:
                pendentes.append((worker_id, seat, ep, msg["obs"], msg["legalMask"]))

        if pendentes:
            obs_np = np.array([g[3] for g in pendentes], dtype=np.float32)
            obs_batch = torch.from_numpy(obs_np)
            mask_batch = torch.tensor([g[4] for g in pendentes], dtype=torch.bool)
            with torch.no_grad():
                logits, values = model(obs_batch)
                dist = masked_categorical(logits, mask_batch)
                actions = dist.sample()
                logps = dist.log_prob(actions)
            acoes = actions.tolist()
            logps_lista = logps.tolist()
            valores_lista = values.tolist()
            for i, (worker_id, seat, ep, obs_lista, mask) in enumerate(pendentes):
                pending[(worker_id, seat)] = {
                    "episode": ep, "obs": obs_batch[i],
                    "action": acoes[i], "logp": logps_lista[i],
                    "value": valores_lista[i], "mask": mask,
                }
                vec_env.send_action(worker_id, acoes[i])

    metrics = {
        "episodes": len(episodes_completed),
        "mean_diferenca": float(np.mean(diferenca_samples)) if diferenca_samples else 0.0,
    }
    return trajectories, metrics


def ppo_update_round1(model, optimizer, trajectories, args, entropy_coef):
    samples = []
    for transitions in trajectories.values():
        rewards = [t["reward"] for t in transitions]
        values = [t["value"] for t in transitions]
        dones = [t["done"] for t in transitions]
        advantages, returns = compute_gae(rewards, values, dones, args.gamma, args.gae_lambda)
        for t, adv, ret in zip(transitions, advantages, returns):
            samples.append({**t, "adv": adv, "ret": ret})

    if not samples:
        return {}

    obs_b = torch.stack([s["obs"] for s in samples])
    act_b = torch.tensor([s["action"] for s in samples], dtype=torch.long)
    logp_old_b = torch.tensor([s["logp"] for s in samples], dtype=torch.float32)
    ret_b = torch.tensor([s["ret"] for s in samples], dtype=torch.float32)
    adv_raw = torch.tensor([s["adv"] for s in samples], dtype=torch.float32)
    adv_b = (adv_raw - adv_raw.mean()) / (adv_raw.std() + 1e-8)
    mask_b = torch.tensor([s["mask"] for s in samples], dtype=torch.bool)

    n = len(samples)
    idx_all = np.arange(n)
    stats = defaultdict(list)
    for _ in range(args.epochs):
        np.random.shuffle(idx_all)
        for start in range(0, n, args.minibatch_size):
            mb = torch.as_tensor(idx_all[start:start + args.minibatch_size], dtype=torch.long)
            logits, values_pred = model(obs_b[mb])
            dist = masked_categorical(logits, mask_b[mb])
            new_logp = dist.log_prob(act_b[mb])
            entropy = dist.entropy().mean()

            ratio = torch.exp(new_logp - logp_old_b[mb])
            surr1 = ratio * adv_b[mb]
            surr2 = torch.clamp(ratio, 1 - args.clip_eps, 1 + args.clip_eps) * adv_b[mb]
            policy_loss = -torch.min(surr1, surr2).mean()
            value_loss = torch.nn.functional.mse_loss(values_pred, ret_b[mb])
            loss = policy_loss + 0.5 * value_loss - entropy_coef * entropy

            optimizer.zero_grad()
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), 0.5)
            optimizer.step()

            with torch.no_grad():
                approx_kl = (logp_old_b[mb] - new_logp).mean().item()
            stats["policy_loss"].append(policy_loss.item())
            stats["value_loss"].append(value_loss.item())
            stats["entropy"].append(entropy.item())
            stats["approx_kl"].append(approx_kl)

    return {k: float(np.mean(v)) for k, v in stats.items()}


def main():
    args = parse_args()
    Path(args.checkpoint).parent.mkdir(parents=True, exist_ok=True)
    Path(args.log).parent.mkdir(parents=True, exist_ok=True)
    melhor_checkpoint_path = pbt.caminho_melhor_checkpoint(args.checkpoint)
    pbt_nome = args.pbt_nome or Path(args.checkpoint).stem

    model = ModeloRound1()
    if args.resume and Path(args.checkpoint).exists():
        model.load_state_dict(torch.load(args.checkpoint))
        print(f"retomando de {args.checkpoint}")
    optimizer = torch.optim.Adam(model.parameters(), lr=args.lr)

    vec_env = VecEnvRound1Nativo(num_workers=args.num_workers)
    if args.entropy_coef_final is not None:
        print(f"{args.num_workers} episódios de rodada-1 em paralelo -- entropy_coef decai de {args.entropy_coef} até {args.entropy_coef_final}")
    else:
        print(f"{args.num_workers} episódios de rodada-1 em paralelo -- entropy_coef fixo em {args.entropy_coef}")
    if args.pbt_grupo:
        print(f"PBT ligado -- grupo '{args.pbt_grupo}', identidade '{pbt_nome}', checa a cada {args.pbt_every} updates")
    log_file = open(args.log, "a")
    pending = {}

    janela_diferenca = deque(maxlen=args.janela_melhor)
    melhor_media_vista = float("inf")
    boost_ate_update = -1  # update até quando o empurrão de entropia do PBT continua valendo

    try:
        for update in range(args.updates):
            if args.entropy_coef_final is not None:
                frac = update / max(1, args.updates - 1)
                entropy_coef = args.entropy_coef + frac * (args.entropy_coef_final - args.entropy_coef)
            else:
                entropy_coef = args.entropy_coef
            if update < boost_ate_update:
                entropy_coef = max(entropy_coef, args.pbt_boost)

            t0 = time.time()
            trajectories, metrics = collect_rollout(vec_env, model, pending, args.episodes_per_update)
            ppo_stats = ppo_update_round1(model, optimizer, trajectories, args, entropy_coef)
            dt = time.time() - t0

            registro = {"update": update, "segundos": round(dt, 2), "entropy_coef": round(entropy_coef, 5), **metrics, **ppo_stats}
            log_file.write(json.dumps(registro) + "\n")
            log_file.flush()

            print(
                f"update {update:5d} | {dt:5.1f}s | ep {metrics['episodes']:4d} | "
                f"diff/rodada {metrics['mean_diferenca']:5.3f} | "
                f"pi_loss {ppo_stats.get('policy_loss', 0):.4f} | "
                f"entropy {ppo_stats.get('entropy', 0):.3f} | "
                f"kl {ppo_stats.get('approx_kl', 0):.4f}"
            )

            if update % args.checkpoint_every == 0:
                pbt.salvar_atomico(model.state_dict(), args.checkpoint)

            # -- salva o melhor já visto, não só o mais recente --
            janela_diferenca.append(metrics["mean_diferenca"])
            if len(janela_diferenca) == janela_diferenca.maxlen:
                media_atual = sum(janela_diferenca) / len(janela_diferenca)
                if media_atual < melhor_media_vista:
                    melhor_media_vista = media_atual
                    pbt.salvar_atomico(model.state_dict(), melhor_checkpoint_path)

            # -- PBT: a cada N updates, compara com o grupo e talvez copia a melhor --
            if args.pbt_grupo and update > 0 and update % args.pbt_every == 0 and len(janela_diferenca) == janela_diferenca.maxlen:
                minha_media = sum(janela_diferenca) / len(janela_diferenca)
                resultado = pbt.checar_e_talvez_copiar(
                    RAIZ, args.pbt_grupo, pbt_nome, minha_media, melhor_checkpoint_path,
                    model, args.pbt_margem, args.pbt_boost_duracao, update,
                )
                if resultado:
                    melhor_nome, melhor_score, boost_ate_update = resultado
                    janela_diferenca.clear()
                    print(f"  [PBT] copiando pesos de '{melhor_nome}' (diff={melhor_score:.4f} vs meu {minha_media:.4f}) -- entropy_coef>={args.pbt_boost} até update {boost_ate_update}")
    finally:
        vec_env.close()
        log_file.close()


if __name__ == "__main__":
    main()

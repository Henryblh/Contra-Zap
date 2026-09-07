# ppo.py
# PPO com self-play (mesma rede pra todos os 4 assentos) e mascaramento de
# ação legal. Aposta e carta usam cabeças diferentes (tamanhos de ação
# diferentes), então cada rollout é separado em dois grupos e cada um roda
# sua própria passada de épocas/minibatches contra a mesma rede (o tronco e
# a cabeça de valor são compartilhados, os gradientes de ambos os grupos
# passam por eles — só a otimização acontece em dois pedaços separados por
# simplicidade, em vez de misturar tamanhos de ação num único tensor).
from collections import defaultdict

import numpy as np
import torch
import torch.nn as nn
from torch.distributions import Categorical


def masked_categorical(logits, mask):
    mask_t = torch.as_tensor(mask, dtype=torch.bool)
    masked_logits = logits.masked_fill(~mask_t, float("-inf"))
    return Categorical(logits=masked_logits)


def compute_gae(rewards, values, dones, gamma, lam, last_value=0.0):
    # values[t] = V(s_t), o valor estimado ANTES da ação em t. done=True
    # sempre fecha a trajetória de verdade (assento eliminado ou jogo
    # acabou — ver env_bridge.js), então não precisa de bootstrap externo.
    T = len(rewards)
    advantages = [0.0] * T
    gae = 0.0
    for t in reversed(range(T)):
        # A última transição de um lote pode não ser terminal. Nesse caso o
        # coletor fornece V(s seguinte), evitando transformar um corte de
        # rollout em fim artificial de episódio.
        next_value = values[t + 1] if t + 1 < T else last_value
        mask = 0.0 if dones[t] else 1.0
        delta = rewards[t] + gamma * next_value * mask - values[t]
        gae = delta + gamma * lam * mask * gae
        advantages[t] = gae
    returns = [a + v for a, v in zip(advantages, values)]
    return advantages, returns


def _run_group(model, optimizer, group, kind, args, entropy_coef, stats_acc):
    if not group:
        return

    obs_b = torch.stack([s["obs"] for s in group])
    act_b = torch.tensor([s["action"] for s in group], dtype=torch.long)
    logp_old_b = torch.tensor([s["logp"] for s in group], dtype=torch.float32)
    ret_b = torch.tensor([s["ret"] for s in group], dtype=torch.float32)
    adv_raw = torch.tensor([s["adv"] for s in group], dtype=torch.float32)
    adv_b = (adv_raw - adv_raw.mean()) / (adv_raw.std(unbiased=False) + 1e-8)
    mask_b = torch.tensor([s["mask"] for s in group], dtype=torch.bool)

    n = len(group)
    idx_all = np.arange(n)
    stopped_early = False
    for _ in range(args.epochs):
        np.random.shuffle(idx_all)
        for start in range(0, n, args.minibatch_size):
            mb = torch.as_tensor(idx_all[start:start + args.minibatch_size], dtype=torch.long)

            aposta_logits, carta_logits, values_pred = model(obs_b[mb])
            logits = aposta_logits if kind == "aposta" else carta_logits
            dist = masked_categorical(logits, mask_b[mb])
            new_logp = dist.log_prob(act_b[mb])
            entropy = dist.entropy().mean()

            ratio = torch.exp(new_logp - logp_old_b[mb])
            surr1 = ratio * adv_b[mb]
            surr2 = torch.clamp(ratio, 1 - args.clip_eps, 1 + args.clip_eps) * adv_b[mb]
            policy_loss = -torch.min(surr1, surr2).mean()
            value_loss = nn.functional.mse_loss(values_pred, ret_b[mb])
            loss = policy_loss + 0.5 * value_loss - entropy_coef * entropy
            if not torch.isfinite(loss):
                raise FloatingPointError(f"loss não finita em PPO ({kind})")

            optimizer.zero_grad()
            loss.backward()
            nn.utils.clip_grad_norm_(model.parameters(), 0.5)
            if not all(torch.isfinite(p.grad).all() for p in model.parameters() if p.grad is not None):
                raise FloatingPointError(f"gradiente não finito em PPO ({kind})")
            optimizer.step()

            with torch.no_grad():
                approx_kl = (logp_old_b[mb] - new_logp).mean().item()

            stats_acc[f"{kind}_policy_loss"].append(policy_loss.item())
            stats_acc[f"{kind}_value_loss"].append(value_loss.item())
            stats_acc[f"{kind}_entropy"].append(entropy.item())
            stats_acc[f"{kind}_approx_kl"].append(approx_kl)
            stats_acc[f"{kind}_clip_fraction"].append((torch.abs(ratio - 1) > args.clip_eps).float().mean().item())
            if approx_kl > 1.5 * args.target_kl:
                stopped_early = True
                break
        if stopped_early:
            break


def ppo_update(model, optimizer, trajectories, args, entropy_coef=None):
    # entropy_coef=None mantém compatibilidade com quem ainda não passa
    # (usa args.entropy_coef, comportamento antigo) -- quem quer controlar
    # isso de fora (cronograma, boost de PBT) passa o valor explícito.
    if entropy_coef is None:
        entropy_coef = args.entropy_coef

    samples = {"aposta": [], "carta": []}
    for transitions in trajectories.values():
        rewards = [t["reward"] for t in transitions]
        values = [t["value"] for t in transitions]
        dones = [t["done"] for t in transitions]
        last_value = transitions[-1].get("bootstrap_value", 0.0) if transitions else 0.0
        advantages, returns = compute_gae(rewards, values, dones, args.gamma, args.gae_lambda, last_value)
        for t, adv, ret in zip(transitions, advantages, returns):
            samples[t["kind"]].append({**t, "adv": adv, "ret": ret})

    stats_acc = defaultdict(list)
    _run_group(model, optimizer, samples["aposta"], "aposta", args, entropy_coef, stats_acc)
    _run_group(model, optimizer, samples["carta"], "carta", args, entropy_coef, stats_acc)

    return {k: float(np.mean(v)) for k, v in stats_acc.items() if v}

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
import random
import time
from collections import defaultdict, deque
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

import pbt
from training_state import atomic_save, finite_state_dict, load_training_state, save_training_state
from env_client import VecEnvBridge, flatten_obs
from harness_nativo import VecEnvNativo
from league import EpisodeAssignment, LeagueController
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
    p.add_argument("--target-kl", type=float, default=0.02)
    p.add_argument("--checkpoint", default=str(RAIZ / "checkpoints" / "latest.pt"))
    p.add_argument("--checkpoint-every", type=int, default=50)
    p.add_argument("--resume", action="store_true", help="carrega o checkpoint acima antes de começar, em vez de pesos do zero")
    p.add_argument("--training-state", help="checkpoint completo (.train.pt); default deriva de --checkpoint")
    p.add_argument("--init-from", help="pesos iniciais legados, por exemplo noite1_H.melhor.pt")
    p.add_argument("--seed", type=int, help="seed reprodutível deste worker")
    p.add_argument("--profile", choices=["mixed", "production"], default="mixed")
    p.add_argument("--league-manifest", help="manifesto versionado da liga; validado e registrado pelo worker")
    p.add_argument("--max-runtime-seconds", type=float, default=0)
    p.add_argument("--stop-file", help="encerra limpo após o update ao encontrar este arquivo")
    p.add_argument("--heartbeat", help="arquivo JSON atômico atualizado a cada update")
    p.add_argument("--log", default=str(RAIZ / "logs" / "train.jsonl"))
    p.add_argument("--render-every", type=int, default=0, help="imprime o resumo de 1 partida a cada N updates (0 = nunca)")
    p.add_argument("--janela-melhor", type=int, default=100,
                    help="tamanho da média móvel usada pra decidir 'é o melhor até agora' (evita salvar em cima de ruído de 1 update)")

    # PBT leve entre processos separados -- ver pbt.py e a discussão do
    # experimento com o especialista de round 1 (mesma ideia, aqui pro jogo
    # completo).
    p.add_argument("--pbt-grupo", default=None, help="nome do grupo -- só compete com outras instâncias do MESMO grupo. None = PBT desligado.")
    p.add_argument("--pbt-nome", default=None, help="identidade desta instância dentro do grupo (default: nome do arquivo de checkpoint)")
    p.add_argument("--pbt-every", type=int, default=250, help="a cada quantos updates checa o placar e possivelmente copia a melhor")
    p.add_argument("--pbt-margem", type=float, default=0.02, help="só copia se a melhor estiver pelo menos essa fração melhor (evita copiar por ruído)")
    p.add_argument("--pbt-boost", type=float, default=0.05, help="entropy_coef temporário aplicado logo depois de copiar (força reexploração a partir do ponto bom)")
    p.add_argument("--pbt-boost-duracao", type=int, default=150, help="por quantos updates o boost de entropia dura antes de voltar ao normal")
    return p.parse_args()


def _self_play_assignment():
    return EpisodeAssignment("self_play", "self_play", frozenset(range(4)))


def _merge_numeric_tree(target, source):
    for key, value in source.items():
        if isinstance(value, dict):
            _merge_numeric_tree(target.setdefault(key, {}), value)
        elif isinstance(value, (int, float)) and not isinstance(value, bool):
            target[key] = target.get(key, 0) + value


def collect_rollout(vec_env, model, pending, episodes_per_update, render_this_update, league=None):
    # `pending` é do chamador (não recriado aqui) — uma transição pode ficar
    # em aberto bem no instante em que este update para de coletar; se o
    # dict fosse recriado a cada chamada, a próxima mensagem que fecharia
    # essa transição chegaria sem achar o par dela e o reward seria
    # descartado. Persistindo entre chamadas, ela só fecha uma call depois.
    trajectories = defaultdict(list)      # (worker_id, episode, seat) -> lista de transições fechadas

    episodes_completed = set()            # (worker_id, episode) -- só conta episódio que de fato FECHOU
    reward_aprendiz = defaultdict(float)
    reward_global_por_ep = defaultdict(float)
    erro_total = 0.0
    rodadas_metricas = 0
    erro_global = 0.0
    rodadas_globais = 0
    metricas_finalizadas = set()
    rodadas_por_ep = {}
    finais_recebidos = defaultdict(set)
    resumos_por_ep = {}
    resumo_amostra = None                 # 1 resumo pra --render-every, se pedido
    league_counts = {
        "episodes": {"self_play": 0, "historical": 0, "anchors": 0},
        "lineups": {"self_play": 0, "1x3": 0, "2x2": 0},
        "opponents": {},
        "learner_seats": {str(seat): 0 for seat in range(4)},
        "actions": {"learner": 0, "opponent": 0},
        "ppo_transitions": 0,
    }

    while len(episodes_completed) < episodes_per_update:
        # bloqueia só pela primeira mensagem; o resto do lote é o que mais
        # já estiver pronto na fila NESSE instante — nenhum worker é feito
        # esperar mais que isso, então não perde paralelismo.
        batch = vec_env.get_batch()
        pendentes_aposta, pendentes_carta, pendentes_oponentes = [], [], []

        for worker_id, msg in batch:
            ep, seat, kind = msg["episode"], msg["seat"], msg["kind"]
            ep_key = (worker_id, ep)
            assignment = league.assignment(worker_id, ep) if league else _self_play_assignment()
            reward_global_por_ep[ep_key] += msg["reward"]
            if assignment.learner_controls(seat):
                reward_aprendiz[(worker_id, ep, seat)] += msg["reward"]
            if kind == "final":
                finais_recebidos[ep_key].add(seat)
                resumos_por_ep.setdefault(ep_key, msg["resumo"])

            pkey = (worker_id, ep, seat)
            if pkey in pending:
                aberto = pending.pop(pkey)
                trajectories[(worker_id, aberto["episode"], seat)].append(
                    {**aberto, "reward": msg["reward"], "done": msg["done"]}
                )

            if kind == "final" and len(finais_recebidos[ep_key]) == 4 and ep_key not in episodes_completed:
                episodes_completed.add(ep_key)
                resumo_final = resumos_por_ep[ep_key]
                rodadas_por_ep[ep_key] = resumo_final["rodadas"]
                metricas_finalizadas.add(ep_key)
                by_seat = {item["seat"]: item for item in resumo_final.get("metricasPorSeat", [])}
                for item in by_seat.values():
                    erro_global += item["erroAbsolutoTotal"]
                    rodadas_globais += item["rodadasJogadas"]
                for learner_seat in assignment.learner_seats:
                    item = by_seat[learner_seat]
                    erro_total += item["erroAbsolutoTotal"]
                    rodadas_metricas += item["rodadasJogadas"]
                    league_counts["learner_seats"][str(learner_seat)] += 1
                league_counts["episodes"][assignment.mode] += 1
                league_counts["lineups"][assignment.lineup] += 1
                if assignment.opponent_id:
                    opponents = league_counts["opponents"]
                    opponents[assignment.opponent_id] = opponents.get(assignment.opponent_id, 0) + 1
                if league:
                    league.finish_episode(worker_id, ep)
                if render_this_update and resumo_amostra is None:
                    resumo_amostra = resumo_final

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
                if assignment.learner_controls(seat):
                    (pendentes_aposta if kind == "aposta" else pendentes_carta).append(entry)
                else:
                    if league is None:  # pragma: no cover - invariante defensiva
                        raise RuntimeError("assento adversário sem controlador de liga")
                    pendentes_oponentes.append({
                        "worker_id": worker_id, "seat": seat, "episode": ep,
                        "obs": obs_lista, "mask": msg["legalMask"], "kind": kind,
                        "assignment": assignment,
                    })

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
                pending[(worker_id, ep, seat)] = {
                    "episode": ep, "obs": obs_batch[i], "kind": kind,
                    "action": acoes[i], "logp": logps_lista[i],
                    "value": valores_lista[i], "mask": mask,
                }
                vec_env.send_action(worker_id, acoes[i])
                league_counts["actions"]["learner"] += 1

        if pendentes_oponentes:
            for entry, action in zip(pendentes_oponentes, league.act_opponents(pendentes_oponentes)):
                vec_env.send_action(entry["worker_id"], action)
                league_counts["actions"]["opponent"] += 1

    # Associa bootstrap às trajetórias que ficaram abertas no corte do lote.
    for key, transitions in trajectories.items():
        worker_id, episode, seat = key
        next_transition = pending.get((worker_id, episode, seat))
        if transitions and next_transition and next_transition["episode"] == episode and not transitions[-1]["done"]:
            transitions[-1]["bootstrap_value"] = next_transition["value"]

    league_counts["ppo_transitions"] = sum(len(items) for items in trajectories.values())
    if league_counts["ppo_transitions"] == 0:
        raise RuntimeError("rollout terminou sem transições do aprendiz")

    bid_error = erro_total / rodadas_metricas if rodadas_metricas else 0.0
    metrics = {
        "episodes": len(episodes_completed),
        "mean_reward_per_seat": float(np.mean(list(reward_aprendiz.values()))) if reward_aprendiz else 0.0,
        "mean_global_reward_per_episode": float(np.mean(list(reward_global_por_ep.values()))) if reward_global_por_ep else 0.0,
        "mean_absolute_bid_error": bid_error,
        "mean_diferenca": bid_error,  # alias para logs antigos
        "global_mean_absolute_bid_error": erro_global / rodadas_globais if rodadas_globais else 0.0,
        "mean_rounds": float(np.mean(list(rodadas_por_ep.values()))) if rodadas_por_ep else 0.0,
        "league": league_counts,
    }
    return trajectories, metrics, resumo_amostra


def main():
    args = parse_args()
    if args.seed is not None:
        random.seed(args.seed)
        np.random.seed(args.seed)
        torch.manual_seed(args.seed)
    Path(args.checkpoint).parent.mkdir(parents=True, exist_ok=True)
    Path(args.log).parent.mkdir(parents=True, exist_ok=True)
    league = LeagueController(args.league_manifest, slot_seed=args.seed or 0) if args.league_manifest else None
    training_state = args.training_state or str(Path(args.checkpoint).with_suffix(".train.pt"))
    melhor_checkpoint_path = pbt.caminho_melhor_checkpoint(args.checkpoint)
    pbt_nome = args.pbt_nome or Path(args.checkpoint).stem

    model = ActorCritic()
    if model.obs_dim != 110 or model.trunk[0].out_features != 256:
        raise RuntimeError("modelos evolutivos devem usar obrigatoriamente arquitetura 110x256")
    optimizer = torch.optim.Adam(model.parameters(), lr=args.lr)
    start_update = 0
    loaded_state = None
    if args.resume and Path(training_state).exists():
        loaded_state = load_training_state(training_state, model, optimizer)
        start_update = int(loaded_state.get("update", 0)) + 1
        print(f"retomando de {training_state}")
    elif args.resume and Path(args.checkpoint).exists():
        load_training_state(args.checkpoint, model, optimizer)
        print(f"retomando pesos de {args.checkpoint}")
    elif args.init_from:
        load_training_state(args.init_from, model)
        print(f"inicializando de {args.init_from}")

    ClasseEnv = VecEnvNativo if args.motor == "nativo" else VecEnvBridge
    vec_env = (ClasseEnv(num_workers=args.num_workers, seed=args.seed, profile=args.profile)
               if args.motor == "nativo" else ClasseEnv(num_workers=args.num_workers))
    print(f"{args.num_workers} partidas em paralelo -- motor: {args.motor}")
    if league:
        print(f"liga ativa -- manifesto {league.sha256[:12]} -- self-play/históricos/âncoras 50/35/15")
    if args.pbt_grupo:
        print(f"PBT ligado -- grupo '{args.pbt_grupo}', identidade '{pbt_nome}', checa a cada {args.pbt_every} updates")
    log_file = open(args.log, "a")
    pending = {}  # persiste entre updates -- ver comentário no topo de collect_rollout

    janela_diferenca = deque(maxlen=args.janela_melhor)
    melhor_media_vista = float("inf")
    boost_ate_update = -1
    league_cumulative = {}
    if loaded_state:
        previous = loaded_state.get("metadata", {}).get("league", {}).get("cumulative")
        if isinstance(previous, dict):
            league_cumulative = previous

    started_at = time.monotonic()
    try:
        for update in range(start_update, start_update + args.updates):
            entropy_coef = max(args.entropy_coef, args.pbt_boost) if update < boost_ate_update else args.entropy_coef

            render_this_update = args.render_every > 0 and update % args.render_every == 0
            t0 = time.time()
            trajectories, metrics, resumo = collect_rollout(
                vec_env, model, pending, args.episodes_per_update, render_this_update, league=league
            )
            ppo_stats = ppo_update(model, optimizer, trajectories, args, entropy_coef)
            _merge_numeric_tree(league_cumulative, metrics["league"])
            dt = time.time() - t0

            registro = {"update": update, "segundos": round(dt, 2), "entropy_coef": round(entropy_coef, 5), **metrics, **ppo_stats}
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

            if not finite_state_dict(model.state_dict()):
                raise FloatingPointError("pesos não finitos; último checkpoint saudável foi preservado")
            if update % args.checkpoint_every == 0:
                atomic_save(model.state_dict(), args.checkpoint)
                metadata = {"league": league.checkpoint_metadata(league_cumulative)} if league else {}
                save_training_state(training_state, model=model, optimizer=optimizer, update=update, args=args,
                                    metadata=metadata)
            if args.heartbeat:
                Path(args.heartbeat).parent.mkdir(parents=True, exist_ok=True)
                temp = Path(args.heartbeat).with_suffix(".tmp")
                heartbeat = {"update": update, "time": time.time(), "league": metrics["league"]}
                if league:
                    heartbeat["league_manifest_sha256"] = league.sha256
                    heartbeat["league_manifest"] = league.manifest
                    heartbeat["league_cumulative"] = league_cumulative
                temp.write_text(json.dumps(heartbeat), encoding="utf-8")
                os.replace(temp, args.heartbeat)

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
            if (args.max_runtime_seconds and time.monotonic() - started_at >= args.max_runtime_seconds) or (args.stop_file and Path(args.stop_file).exists()):
                atomic_save(model.state_dict(), args.checkpoint)
                metadata = {"league": league.checkpoint_metadata(league_cumulative)} if league else {}
                save_training_state(training_state, model=model, optimizer=optimizer, update=update, args=args,
                                    metadata=metadata)
                break
    finally:
        vec_env.close()
        log_file.close()


if __name__ == "__main__":
    main()

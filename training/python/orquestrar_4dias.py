"""Orquestrador resiliente para a população PPO de quatro dias.

Não depende de uma sessão Codex: todo estado necessário fica em runs/<id>.
"""
from __future__ import annotations

import argparse, copy, hashlib, json, math, os, random, shutil, subprocess, sys, time
from datetime import datetime, timedelta, timezone
from pathlib import Path

from training_state import clone_training_state

ROOT = Path(__file__).resolve().parent.parent
PY = ROOT / '.venv' / 'Scripts' / 'python.exe'
TRAIN, EVAL = Path(__file__).with_name('train.py'), Path(__file__).with_name('evaluate.py')
H = ROOT / 'checkpoints' / 'noite1_H.melhor.pt'
OVERNIGHT = ROOT / 'checkpoints' / 'overnight.pt'


def atomic_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix('.tmp')
    tmp.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding='utf-8')
    os.replace(tmp, path)


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def args_parse():
    p = argparse.ArgumentParser()
    p.add_argument('--hours', type=float, default=96)
    p.add_argument('--run-id')
    p.add_argument('--resume', action='store_true')
    p.add_argument('--dry-run', action='store_true')
    p.add_argument('--seed', type=int, default=20260903)
    p.add_argument('--population', type=int, default=10)
    p.add_argument('--workers', type=int, default=32)
    p.add_argument('--train-minutes', type=float, default=105)
    p.add_argument('--final-hours', type=float, default=6)
    p.add_argument('--dry-run-proof')
    p.add_argument('--skip-dry-run', action='store_true')
    return p.parse_args()


def make_slots(run, seed, count):
    rng = random.Random(seed)
    slots = []
    for i in range(count):
        d = run / 'slots' / f'slot{i:02d}'
        # Amostragem estratificada simples, reproduzível, dentro dos limites do plano.
        frac = (i + .5) / count
        hp = {"lr": math.exp(math.log(1e-4) + frac * math.log(6)),
              "entropy": math.exp(math.log(.003) + rng.random() * math.log(10)),
              "clip": .10 + rng.random() * .15, "gae": .90 + rng.random() * .08,
              "epochs": 3 + i % 4, "minibatch": 256 if i % 2 else 512}
        slots.append({"id": f'slot{i:02d}', "dir": str(d), "seed": seed + i * 7919,
                      "init_from": 'H' if i < 4 else None, "hparams": hp, "lineage": [],
                      "matchups": {}, "failures": 0})
    return slots


def init_state(a):
    run_id = a.run_id or datetime.now().strftime('run-%Y%m%d-%H%M%S')
    run = ROOT / 'runs' / run_id
    state_path = run / 'state.json'
    if a.resume:
        state = json.loads(state_path.read_text(encoding='utf-8'))
        state.setdefault('league_history', [])
        for slot in state['slots']:
            slot.setdefault('matchups', {})
        return run, state
    if run.exists():
        raise SystemExit(f'run já existe: {run}; use --resume')
    if not H.exists() or not OVERNIGHT.exists():
        raise SystemExit('checkpoints H ou overnight não encontrados')
    anchors = run / 'anchors'; anchors.mkdir(parents=True)
    for source in (H, OVERNIGHT): shutil.copy2(source, anchors / source.name)
    hours = .5 if a.dry_run else a.hours
    state = {"schema_version": 1, "run_id": run_id, "seed": a.seed, "started_at": time.time(),
             "deadline": time.time() + hours * 3600, "generation": 0, "phase": 'train',
             "anchors": {"H": str(anchors / H.name), "overnight": str(anchors / OVERNIGHT.name),
                         "sha256": {"H": sha(anchors / H.name), "overnight": sha(anchors / OVERNIGHT.name)}},
             "slots": make_slots(run, a.seed, a.population), "champion": None,
             "history": [], "league_history": []}
    atomic_json(state_path, state)
    return run, state


def paths(slot):
    d = Path(slot['dir'])
    return d / 'model.weights.pt', d / 'model.train.pt', d / 'heartbeat.json', d / 'stdout.txt'


def log_path(slot):
    return Path(slot['dir']) / 'train.jsonl'


def launch(slot, a, resume=True):
    d = Path(slot['dir']); d.mkdir(parents=True, exist_ok=True)
    weights, train, heartbeat, stdout = paths(slot)
    hp = slot['hparams']
    cmd = [str(PY), str(TRAIN), '--motor', 'nativo', '--num-workers', str(a.workers),
           '--episodes-per-update', '64', '--updates', '100000000', '--checkpoint', str(weights),
           '--training-state', str(train), '--seed', str(slot['seed']), '--profile', 'mixed',
           '--lr', str(hp['lr']), '--entropy-coef', str(hp['entropy']), '--clip-eps', str(hp['clip']),
           '--gae-lambda', str(hp['gae']), '--epochs', str(hp['epochs']), '--minibatch-size', str(hp['minibatch']),
           '--target-kl', '.02', '--checkpoint-every', '10', '--max-runtime-seconds', str(a.train_minutes * 60),
           '--heartbeat', str(heartbeat), '--league-manifest', slot['league_manifest'],
           '--log', str(log_path(slot))]
    if resume and train.exists(): cmd.append('--resume')
    elif slot.get('init_from') == 'H': cmd += ['--init-from', state_anchor(slot, 'H')]
    out = open(stdout, 'a', encoding='utf-8')
    return subprocess.Popen(cmd, stdout=out, stderr=subprocess.STDOUT, creationflags=getattr(subprocess, 'BELOW_NORMAL_PRIORITY_CLASS', 0))


def state_anchor(slot, name):
    # preenchido pelo laço principal; torna a função de lançamento independente de cwd.
    return slot['_anchors'][name]


def historical_pool(state):
    if state.get('league_history'):
        return state['league_history']
    return [{"id": "historical_H", "checkpoint": state['anchors']['H'], "obs_dim": 110,
             "sha256": state['anchors']['sha256']['H'], "generation": -1}]


def matchup_estimate(slot, opponent_id):
    stats = slot.get('matchups', {}).get(opponent_id, {})
    wins, appearances = int(stats.get('wins', 0)), int(stats.get('appearances', 0))
    return (wins + 1) / (appearances + 4)


def pfsp_weight(win_rate):
    return max(.05, 1 - abs(float(win_rate) - .25) / .25) ** 2


def weighted_choice(rows, rng):
    total = sum(float(row['weight']) for row in rows)
    needle, cumulative = rng.random() * total, 0.0
    for row in rows:
        cumulative += float(row['weight'])
        if needle <= cumulative:
            return row
    return rows[-1]


def write_league_manifests(run, state):
    manifest_dir = run / 'manifests'
    history = historical_pool(state)
    for slot_index, slot in enumerate(state['slots']):
        opponents = []
        for item in history:
            estimated = matchup_estimate(slot, item['id'])
            opponents.append({
                "id": item['id'], "pool": "historical", "kind": "checkpoint",
                "checkpoint": str(Path(item['checkpoint']).resolve()), "obs_dim": int(item['obs_dim']),
                "sha256": item['sha256'], "estimated_win_rate": estimated,
                "weight": pfsp_weight(estimated),
            })
        opponents += [
            {"id": "H", "pool": "anchors", "kind": "checkpoint",
             "checkpoint": str(Path(state['anchors']['H']).resolve()), "obs_dim": 110,
             "sha256": state['anchors']['sha256']['H'], "weight": .40},
            {"id": "overnight", "pool": "anchors", "kind": "checkpoint",
             "checkpoint": str(Path(state['anchors']['overnight']).resolve()), "obs_dim": 70,
             "sha256": state['anchors']['sha256']['overnight'], "weight": .30},
            {"id": "heuristic", "pool": "anchors", "kind": "heuristic", "weight": .20},
            {"id": "random", "pool": "anchors", "kind": "random", "weight": .10},
        ]
        manifest = {
            "schema_version": 1, "manifest_type": "training_league",
            "seed": state['seed'] + state['generation'] * 1009 + slot_index * 9176,
            "mixture": {"self_play": .50, "historical": .35, "anchors": .15},
            "opponents": opponents,
        }
        path = manifest_dir / f'g{state["generation"]:03d}-{slot["id"]}.training-league.json'
        atomic_json(path, manifest)
        slot['league_manifest'] = str(path.resolve())
        slot['league_manifest_sha256'] = sha(path)


def train_generation(run, state, a):
    write_league_manifests(run, state)
    for slot in state['slots']: slot['_anchors'] = {'H': state['anchors']['H'], 'overnight': state['anchors']['overnight']}
    atomic_json(run / 'state.json', state)
    procs = {s['id']: launch(s, a) for s in state['slots']}
    started = time.time(); restart = {s['id']: 0 for s in state['slots']}
    while procs:
        time.sleep(10)
        for slot in state['slots']:
            proc = procs.get(slot['id'])
            if proc is None: continue
            heartbeat = paths(slot)[2]
            stale = heartbeat.exists() and time.time() - heartbeat.stat().st_mtime > 600
            if stale and proc.poll() is None: proc.terminate()
            code = proc.poll()
            if code is not None:
                procs.pop(slot['id'], None)
                # Saída normal após o limite temporal é esperada.
                if time.time() - started < a.train_minutes * 60 - 15 and restart[slot['id']] < 3:
                    restart[slot['id']] += 1; slot['failures'] += 1
                    procs[slot['id']] = launch(slot, a, resume=True)
        atomic_json(run / 'state.json', state)


def suite(run, state, games=250):
    candidates = []
    for s in state['slots']:
        weight = paths(s)[0]
        if weight.exists(): candidates.append({'id': s['id'], 'spec': f'checkpoint={weight}'})
    if not candidates: raise RuntimeError('nenhum checkpoint para avaliar')
    champion = state['champion'] or state['anchors']['H']
    contexts = [{'id': 'vs_H', 'opponent': f"checkpoint={state['anchors']['H']}", 'seeds': [101,102,103,104], 'games_per_seed': games},
                {'id': 'vs_champion', 'opponent': f'checkpoint={champion}', 'seeds': [201,202,203,204], 'games_per_seed': games},
                {'id': 'vs_overnight', 'opponent': f"checkpoint={state['anchors']['overnight']}", 'seeds': [301,302,303,304], 'games_per_seed': games}]
    history = historical_pool(state)
    tasks = []
    for slot_index, slot in enumerate(state['slots']):
        if not paths(slot)[0].exists():
            continue
        weighted = []
        for item in history:
            estimated = matchup_estimate(slot, item['id'])
            weighted.append({**item, 'weight': pfsp_weight(estimated)})
        rng = random.Random(state['seed'] + state['generation'] * 100003 + slot_index * 7919)
        selected = weighted_choice(weighted, rng)
        tasks.append({
            'id': f'{slot["id"]}:vs_history:{selected["id"]}', 'candidate': slot['id'],
            'context': f'vs_history:{selected["id"]}',
            'opponent': f'checkpoint={selected["checkpoint"]}',
            'seeds': [401000 + state['generation'] * 10000 + slot_index * 10 + i for i in range(4)],
            'games_per_seed': games,
        })
    manifest = {'schema_version': 1, 'candidates': candidates, 'contexts': contexts, 'tasks': tasks}
    mp = run / f'suite-g{state["generation"]:03d}.json'
    atomic_json(mp, manifest)
    output = run / f'suite-g{state["generation"]:03d}.result.json'
    subprocess.run([str(PY), str(EVAL), 'suite', '--manifest', str(mp), '--jobs', '10', '--output', str(output)], check=True)
    return json.loads(output.read_text(encoding='utf-8'))


def update_matchups(state, result):
    by_id = {slot['id']: slot for slot in state['slots']}
    for row in result.get('results', []):
        context = row.get('context', '')
        if not context.startswith('vs_history:') or row.get('candidate') not in by_id:
            continue
        opponent_id = context.removeprefix('vs_history:')
        matchups = by_id[row['candidate']].setdefault('matchups', {})
        stats = matchups.setdefault(opponent_id, {'wins': 0, 'appearances': 0})
        stats['wins'] += int(row['wins'])
        stats['appearances'] += int(row['appearances'])


def league_evidence(state):
    totals = {"self_play": 0, "historical": 0, "anchors": 0,
              "learner_actions": 0, "opponent_actions": 0, "ppo_transitions": 0}
    for slot in state['slots']:
        path = log_path(slot)
        if not path.exists():
            continue
        for line in path.read_text(encoding='utf-8').splitlines():
            if not line.strip():
                continue
            record = json.loads(line)
            counts = record.get('league', {})
            episodes = counts.get('episodes', {})
            for mode in ('self_play', 'historical', 'anchors'):
                totals[mode] += int(episodes.get(mode, 0))
            totals['learner_actions'] += int(counts.get('actions', {}).get('learner', 0))
            totals['opponent_actions'] += int(counts.get('actions', {}).get('opponent', 0))
            totals['ppo_transitions'] += int(counts.get('ppo_transitions', 0))
    passed = all(totals[key] > 0 for key in totals)
    return {"schema_version": 1, "league_exercised": passed, "totals": totals,
            "run_id": state['run_id'], "generated_at": time.time()}


def validate_dry_run_proof(a):
    if a.dry_run or a.resume or a.skip_dry_run:
        return
    if not a.dry_run_proof:
        raise SystemExit('dry run obrigatório: informe --dry-run-proof ou use --skip-dry-run somente em emergência')
    path = Path(a.dry_run_proof)
    try:
        proof = json.loads(path.read_text(encoding='utf-8'))
    except (OSError, json.JSONDecodeError) as error:
        raise SystemExit(f'prova de dry run inválida: {error}') from error
    if proof.get('schema_version') != 1 or proof.get('league_exercised') is not True:
        raise SystemExit('dry run não demonstrou self-play, históricos, âncoras e ações adversárias')


def mutate(parent, child, generation, state):
    srcw, srct, _, _ = paths(parent); dstw, dstt, _, _ = paths(child)
    dstw.parent.mkdir(parents=True, exist_ok=True)
    rng = random.Random(state['seed'] + generation * 101 + int(child['id'][-2:]))
    hp = dict(parent['hparams']); changed = False
    for key, lo, hi in [('lr', 1e-4, 6e-4), ('entropy', .003, .03), ('clip', .10, .25), ('gae', .90, .98)]:
        if rng.random() < .5 or not changed:
            hp[key] = min(hi, max(lo, hp[key] * (1.2 if rng.random() < .5 else .8))); changed = True
    new_seed = rng.randrange(1, 2**31)
    lineage_event = {"parent": parent['id'], "generation": generation, "seed": new_seed,
                     "parent_manifest_sha256": parent.get('league_manifest_sha256')}
    shutil.copy2(srcw, dstw)
    clone_training_state(
        srct, dstt, seed=new_seed, lr=hp['lr'],
        hparams={"lr": hp['lr'], "entropy_coef": hp['entropy'], "clip_eps": hp['clip'],
                 "gae_lambda": hp['gae'], "epochs": hp['epochs'],
                 "minibatch_size": hp['minibatch']},
        metadata={"lineage": lineage_event},
    )
    child.update({'hparams': hp, 'init_from': None, 'seed': new_seed,
                  'lineage': parent['lineage'] + [lineage_event],
                  'matchups': copy.deepcopy(parent.get('matchups', {})), 'failures': 0})


def main():
    a = args_parse()
    validate_dry_run_proof(a)
    if a.dry_run:
        a.train_minutes = min(a.train_minutes, 30)
    run, state = init_state(a)
    final_at = state['deadline'] - (0 if a.dry_run else a.final_hours * 3600)
    while time.time() < final_at:
        train_generation(run, state, a)
        result = suite(run, state, games=10 if a.dry_run else 250)
        update_matchups(state, result)
        state['history'].append({'generation': state['generation'], 'ranking': result['ranking']})
        ranking = result['ranking']; byid = {s['id']: s for s in state['slots']}
        winner = byid[ranking[0]['id']]; source = paths(winner)[0]
        archive = run / 'archive' / f'g{state["generation"]:03d}-{winner["id"]}.weights.pt'; archive.parent.mkdir(exist_ok=True)
        shutil.copy2(source, archive); shutil.copy2(source, run / 'campeao_atual.weights.pt')
        history_id = f'g{state["generation"]:03d}-{winner["id"]}'
        state['league_history'].append({"id": history_id, "checkpoint": str(archive.resolve()),
                                        "obs_dim": 110, "sha256": sha(archive),
                                        "generation": state['generation']})
        state['champion'] = str(archive); state['generation'] += 1
        if len(ranking) >= 5:
            for loser_row in ranking[-2:]:
                parent_rng = random.Random(state['seed'] + state['generation'] * 65537
                                           + int(loser_row['id'][-2:]))
                parent = byid[parent_rng.choice(ranking[:3])['id']]
                mutate(parent, byid[loser_row['id']], state['generation'], state)
        atomic_json(run / 'state.json', state)
        if a.dry_run: break
    # Final conservador: avalia população contra H com amostra maior; sem evidência, mantém H.
    final = suite(run, state, games=25 if a.dry_run else 1000)
    best = final['ranking'][0]
    best_rows = [r for r in final['results'] if r['candidate'] == best['id'] and r['context'] == 'vs_H']
    # Sem uma margem estatística acima dos 25% esperados num 1x3, H continua
    # sendo o campeão conhecido em vez de promover ruído de amostra.
    champion = (paths(next(s for s in state['slots'] if s['id'] == best['id']))[0]
                if best_rows and best_rows[0]['win_rate_ci95'][0] > .25 else Path(state['anchors']['H']))
    shutil.copy2(champion, run / 'campeao.weights.pt')
    atomic_json(run / 'relatorio_final.json', {'state': state, 'final': final,
                                                'export': f'{PY} {ROOT / "python" / "export_weights.py"} --checkpoint {run / "campeao.weights.pt"} --output bots/models/noite1.json'})
    if a.dry_run:
        evidence = league_evidence(state)
        atomic_json(run / 'dry_run_passed.json', evidence)
        if not evidence['league_exercised']:
            raise RuntimeError(f'dry run não exercitou toda a liga: {evidence["totals"]}')
    print(f'Concluído: {run / "campeao.weights.pt"}')


if __name__ == '__main__': main()

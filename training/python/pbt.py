# pbt.py -- PBT leve entre processos separados, compartilhado por train.py
# e train_round1.py. Cada instância escreve seu placar num arquivo (pasta
# training/logs/pbt_status/<grupo>/), olha as outras do mesmo grupo, e se
# estiver perdendo, copia os pesos da melhor -- coordenação via sistema de
# arquivos, sem precisar de socket/IPC entre os processos.
import json
import os
from pathlib import Path


def caminho_melhor_checkpoint(checkpoint):
    p = Path(checkpoint)
    return p.with_name(p.stem + ".melhor" + p.suffix)


def salvar_atomico(state_dict, caminho):
    # torch.save escreve direto no destino -- um leitor concorrente (outra
    # instância do PBT tentando copiar) pode pegar o arquivo pela metade e
    # tomar EOFError (foi exatamente o que derrubou uma instância na
    # primeira run noturna). Salva num .tmp e troca com os.replace, que é
    # atômico -- quem lê sempre vê o arquivo velho inteiro ou o novo
    # inteiro, nunca um pedaço.
    import torch
    caminho = Path(caminho)
    tmp = caminho.with_suffix(caminho.suffix + ".tmp")
    torch.save(state_dict, tmp)
    os.replace(tmp, caminho)


def status_path(raiz, grupo, nome):
    d = raiz / "logs" / "pbt_status" / grupo
    d.mkdir(parents=True, exist_ok=True)
    return d / f"{nome}.json"


def ler_grupo(raiz, grupo):
    d = raiz / "logs" / "pbt_status" / grupo
    if not d.exists():
        return {}
    resultado = {}
    for arq in d.glob("*.json"):
        try:
            with open(arq, encoding="utf-8") as f:
                resultado[arq.stem] = json.load(f)
        except (json.JSONDecodeError, OSError):
            continue  # outro processo pode estar escrevendo nesse instante -- ignora e tenta de novo depois
    return resultado


def checar_e_talvez_copiar(raiz, grupo, nome, minha_media, melhor_checkpoint_path, model, margem, boost_duracao, update):
    """Escreve o próprio placar, olha o resto do grupo, e se alguém estiver
    pelo menos `margem` melhor, carrega os pesos dela no `model` (in-place).
    Devolve o novo `boost_ate_update` (update+boost_duracao se copiou, ou o
    valor antigo passado como argumento -1 se não copiou -- quem chama
    decide o que fazer com isso)."""
    with open(status_path(raiz, grupo, nome), "w", encoding="utf-8") as f:
        json.dump({"update": update, "mean_diferenca": minha_media, "checkpoint": str(melhor_checkpoint_path)}, f)

    grupo_status = ler_grupo(raiz, grupo)
    outros = {n: s for n, s in grupo_status.items() if n != nome}
    if not outros:
        return None

    melhor_nome, melhor_status = min(outros.items(), key=lambda kv: kv[1]["mean_diferenca"])
    melhor_score = melhor_status["mean_diferenca"]
    if melhor_score < minha_media * (1 - margem):
        import torch  # import local -- evita custo de import se PBT nunca copiar nada
        caminho = Path(melhor_status["checkpoint"])
        if caminho.exists():
            try:
                estado = torch.load(caminho)
            except Exception:
                # segunda camada de proteção -- salvar_atomico já deveria
                # evitar isso, mas se algo escapar (arquivo sendo criado
                # pela primeira vez, disco lento, etc.) é melhor pular essa
                # cópia e tentar de novo no próximo pbt_every do que derrubar
                # a instância inteira por causa de um vizinho.
                return None
            model.load_state_dict(estado)
            return melhor_nome, melhor_score, update + boost_duracao
    return None

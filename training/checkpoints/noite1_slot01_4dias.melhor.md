# `noite1_slot01_4dias.melhor.pt`

Checkpoint campeão do experimento evolutivo `run-20260903-192411`.

## Arquitetura e origem

- Arquitetura: observação de 110 valores, duas camadas ocultas de 256 neurônios
  ReLU, cabeças de aposta, carta e valor.
- Inicialização da população: quatro redes iniciadas a partir de
  `noite1_H.melhor.pt` e seis redes independentes aleatórias.
- O checkpoint promovido é o `slot01`; ele deriva de seis eventos de clonagem
  PBT e não sofreu reinicializações por falha.

## Estratégia de treino

A run foi configurada para 96 horas e executou de 03/09/2026 19:24 até
07/09/2026 18:13 (aproximadamente 94 h 49 min de tempo de parede, incluindo
seleção e avaliação final). A população de 10 redes `110x256` percorreu 37
gerações. Cada geração combinou até 105 minutos de PPO em paralelo com um
torneio no motor JavaScript real; os dois piores membros foram substituídos por
descendentes mutados de membros do topo, preservando os melhores.

O último estado de treino do `slot01` registra update 89.530; os dez estados
finais somam aproximadamente 896.895 updates de trabalhador. O treino usou 64
episódios por update e uma liga determinística:

- 50% self-play;
- 35% contra campeões históricos, amostrados por PFSP;
- 15% contra âncoras: H (40%), overnight (30%), heurístico (20%) e aleatório
  (10%).

Nos episódios contra liga, metade era `1 aprendiz × 3 oponentes` e metade
`2 × 2`, com rotação de assentos. Somente ações dos assentos do aprendiz
geraram transições PPO. A seleção de cada geração avaliou H, o campeão vigente,
overnight e um histórico PFSP usando seeds separados no motor JavaScript.

## Critério de promoção e resultados

O modelo somente era promovido se ultrapassasse H no confronto `1 × 3` com
intervalo de Wilson de 95% acima de 25%. No torneio final, cada contexto teve
4.000 partidas (quatro seeds, 1.000 partidas por seed):

| Contexto final do `slot01` | Vitória | IC 95% |
|---|---:|---:|
| contra 3× H | 48,05% | 46,50%–49,60% |
| contra 3× overnight | 49,53% | 47,98%–51,07% |
| contra o campeão vigente | 24,88% | 23,56%–26,24% |
| contra histórico PFSP | 33,58% | 32,13%–35,06% |

Uma verificação pós-treino com seed inédita (`20260907`), 1.000 partidas e
rotação completa de assentos confirmou 48,80% contra 3× H (IC 95%
45,71%–51,90%). Uma matriz adicional de 10.000 partidas por confronto, seed
42, registrou 82,23% contra benchmark, 72,34% contra heurístico e 87,20%
contra aleatório; H obteve respectivamente 73,44%, 59,55% e 81,76% nas mesmas
condições.

O arquivo contém somente pesos (`state_dict`) e é compatível com o exportador
para `bots/models/noite1.json`.

# carta.py -- porte direto de game/Carta.js (dado puro, sem conceito de conexão/conta)
from dataclasses import dataclass


@dataclass
class Carta:
    id: int
    naipe_int: int
    valor_int: int
    nome_naipe: str
    nome_valor: str
    numero_baralho: int

    def __str__(self):
        return f"[{self.nome_valor} de {self.nome_naipe}]"

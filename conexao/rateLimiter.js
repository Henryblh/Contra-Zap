// rateLimiter.js
// Limitador de taxa genérico, de janela fixa, por chave qualquer (hoje: IP).
// Não sabe nada sobre socket.io nem sobre o protocolo — só conta e esquece.
// Pensado pra eventos pré-autenticação (ex.: verificarNome, ver
// conexao/eventos.js) onde não existe player.id pra chavear: um socket é de
// graça (é só reconectar), então limitar por socket.id não segura nada de
// verdade — o IP é o que custa alguma coisa pra trocar.
//
// Janela fixa (não sliding window "de verdade"): simples o bastante pra esse
// nível de ameaça — a diferença prática pro sliding window é só permitir uma
// rajada um pouco maior bem na virada da janela, o que não muda a conclusão
// (o objetivo é matar varredura em massa, não contar milimetricamente).
export function criarLimitadorDeTaxa({ janelaMs, maxPorJanela }) {
    // chave -> { contagem, inicioJanela }
    const registros = new Map();

    // true se `chave` ainda pode fazer mais uma chamada dentro da janela
    // atual (e já contabiliza essa chamada); false se estourou o teto —
    // quem chama decide o que fazer (recusar, logar, etc.), isto não lança.
    // Uso típico: contar TODA chamada (ver verificarNome em socketServer.js).
    function permitido(chave) {
        const agora = Date.now();
        const registro = registros.get(chave);

        if (!registro || agora - registro.inicioJanela >= janelaMs) {
            registros.set(chave, { contagem: 1, inicioJanela: agora });
            _podar(agora);
            return true;
        }

        if (registro.contagem >= maxPorJanela) return false;
        registro.contagem++;
        return true;
    }

    // Quantas chamadas `chave` ainda tem de sobra na janela atual — SEM
    // contabilizar nada (não muda estado). Uso típico: contar só as
    // chamadas que FALHARAM (ver `entrar` em socketServer.js — login com
    // senha certa não deve gastar essa cota de ninguém), consultando isto
    // antes de decidir se tenta, e chamando `permitido` só depois de uma
    // falha de verdade pra consumir uma unidade.
    function restantes(chave) {
        const agora = Date.now();
        const registro = registros.get(chave);
        if (!registro || agora - registro.inicioJanela >= janelaMs) return maxPorJanela;
        return Math.max(0, maxPorJanela - registro.contagem);
    }

    // Tira do Map toda chave cuja janela já expirou — sem isso o Map cresce
    // uma entrada por IP que já apareceu alguma vez e nunca encolhe. Rodada
    // dentro de `permitido` (mesmo padrão de `_podarCooldownChat` em
    // SalaManager.js): custo O(n) diluído pela própria janela, e quem está
    // de fato varrendo (muitas chamadas rápidas) paga essa poda com mais
    // frequência, não menos — não abre brecha nova.
    function _podar(agora) {
        for (const [chave, registro] of registros) {
            if (agora - registro.inicioJanela >= janelaMs) {
                registros.delete(chave);
            }
        }
    }

    return { permitido, restantes };
}

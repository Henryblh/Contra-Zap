import { useEffect, useState } from 'react';
import { socket, chamar } from '../socket.js';

// Tela 3: uma sala inteira, da espera até o fim da partida. É um componente
// só (não um por fase) porque é uma assinatura contínua dos mesmos eventos
// do GameController, do início ao fim — ver conexao/PROTOCOLO.md pra tabela
// completa de eventos e payloads.
// `reconexao`, quando presente, vem do ack de "reconectar" (chamado pela
// Lobby depois de sair de uma partida em andamento) — { mao, cartasRodada,
// suaVez, jogadorDaVez, suaVezDaAposta, jogadorDaVezAposta } — e é o que
// permite montar esta tela já em andamento, sem esperar um
// novaRodadaIniciada/suaMao/turnoAposta que já aconteceram antes da gente
// voltar (a partida não pausa enquanto o assento está no automático). As
// duas frentes (aposta e carta) nunca vêm preenchidas ao mesmo tempo — no
// máximo uma delas reflete a espera de verdade, a outra some sozinha assim
// que a fase seguinte começar de verdade.
export default function Partida({ salaId, jogadoresIniciais, segundosIniciais, reconexao, meuNome, onSairDaSala, onSairDaPartida }) {
    // Semeado do ack de criarSala/entrarSala, não do broadcast de
    // listaJogadores — o primeiro broadcast sai antes desta tela existir
    // (e o listener abaixo com ele), então dependeria de um evento que já
    // passou. Broadcasts seguintes (mais gente entrando) chegam normal.
    const [jogadores, setJogadores] = useState(jogadoresIniciais ?? []);
    // Semeado do ack de criarSala/entrarSala (não do broadcast de
    // partidaIniciandoEm): quando os bots — ou a última entrada — lotam a
    // sala, esse broadcast sai antes desta tela existir. Broadcasts
    // seguintes (ex.: forcarInicio cancelado não existe, mas outra lotação
    // depois de um sairSala, sim) chegam normal pelo handler abaixo.
    const [segundosParaIniciar, setSegundosParaIniciar] = useState(segundosIniciais ?? null);
    const [iniciada, setIniciada] = useState(!!reconexao);
    const [mao, setMao] = useState(reconexao?.mao ?? []);
    // { [nome]: string[] } — mãos dos outros que o servidor deixou este
    // jogador ver. Hoje só a rodada de 1 carta ("testa") preenche isto: cada
    // um vê a mão dos outros e esconde a sua. Zera a cada novaRodadaIniciada.
    const [maosReveladas, setMaosReveladas] = useState(
        () => Object.fromEntries((reconexao?.maosReveladas ?? []).map((m) => [m.jogador, m.mao]))
    );
    const [jogadorDaVezAposta, setJogadorDaVezAposta] = useState(reconexao?.jogadorDaVezAposta ?? null);
    const [valorAposta, setValorAposta] = useState('');
    const [cartasRodada, setCartasRodada] = useState(reconexao?.cartasRodada ?? 0);
    const [jogadorDaVez, setJogadorDaVez] = useState(reconexao?.jogadorDaVez ?? null);
    const [mesa, setMesa] = useState([]);
    const [vira, setVira] = useState(null);
    const [ultimoPlacar, setUltimoPlacar] = useState([]);
    const [vencedor, setVencedor] = useState(null);
    const [log, setLog] = useState([]);
    const [erro, setErro] = useState(null);
    // Espelha apostaFeita/jogadoresEliminados num formato fácil de olhar na
    // UI (o log de eventos já registra isso, mas em texto corrido — ruim
    // pra debugar de relance quem já apostou e quem já morreu). `apostas`
    // zera a cada novaRodadaIniciada; `eliminados` só cresce (eliminação é
    // definitiva na partida).
    const [apostas, setApostas] = useState({});
    const [eliminados, setEliminados] = useState([]);

    useEffect(() => {
        const registrar = (linha) => setLog((anterior) => [...anterior.slice(-49), linha]);
        const daSala = (payload) => payload.salaId === salaId;

        if (reconexao) {
            if (reconexao.jogadorDaVezAposta) {
                registrar(`🔌 Reconectado — ${reconexao.suaVezDaAposta ? 'sua vez de apostar agora' : `vez de ${reconexao.jogadorDaVezAposta} apostar`}`);
            } else {
                registrar(`🔌 Reconectado — ${reconexao.suaVez ? 'sua vez agora' : `vez de ${reconexao.jogadorDaVez ?? '...'}`}`);
            }
        }

        const handlers = {
            listaJogadores(p) {
                if (!daSala(p)) return;
                setJogadores(p.jogadores);
                registrar(`Sala: ${p.jogadores.map((j) => j.nome).join(', ')}`);
            },
            partidaIniciandoEm(p) {
                if (!daSala(p)) return;
                setSegundosParaIniciar(p.segundos);
                registrar(`Sala cheia — partida em ${p.segundos}s (ou "Forçar início")`);
            },
            novaRodadaIniciada(p) {
                if (!daSala(p)) return;
                setIniciada(true);
                setMesa([]);
                setVira(null);
                setJogadorDaVezAposta(null);
                setCartasRodada(p.cartas);
                setApostas({});
                setMaosReveladas({});
                registrar(`Rodada ${p.numero} (${p.cartas} carta(s))`);
            },
            suaMao(p) {
                if (!daSala(p)) return;
                setMao(p.mao);
                registrar(`Sua mão: ${p.mao.join(', ')}`);
            },
            maosReveladas(p) {
                if (!daSala(p)) return;
                setMaosReveladas(Object.fromEntries(p.maos.map((m) => [m.jogador, m.mao])));
                registrar(`👁️ Rodada cega — ${p.maos.map((m) => `${m.jogador}: ${m.mao.join(', ')}`).join(' | ')}`);
            },
            manilhaVirada(p) {
                if (!daSala(p)) return;
                setVira({ carta: p.vira, valor: p.viraValor });
                registrar(`Vira: ${p.vira} — manilha valor ${p.viraValor}`);
            },
            turnoAposta(p) {
                if (!daSala(p)) return;
                setJogadorDaVezAposta(p.jogador);
                registrar(`Vez de ${p.jogador} apostar`);
            },
            apostaFeita(p) {
                if (!daSala(p)) return;
                setJogadorDaVezAposta(null);
                setApostas((anterior) => ({ ...anterior, [p.jogador]: p.aposta }));
                registrar(`${p.jogador} apostou ${p.aposta}`);
            },
            turnoJogador(p) {
                if (!daSala(p)) return;
                setJogadorDaVez(p.jogador);
                registrar(`Vez de ${p.jogador}`);
            },
            cartaJogada(p) {
                if (!daSala(p)) return;
                setMesa((anterior) => [...anterior, { jogador: p.jogador, carta: p.carta }]);
                // Cobre a jogada automática por timeout: nesse caso ninguém
                // chamou jogar() localmente, então a carta nunca saiu da
                // mão — sem isso ficava uma carta fantasma na UI. Pra
                // jogada manual (que já removeu por índice em jogar()) isso
                // não acha a carta de novo e não faz nada.
                if (p.jogador === meuNome) {
                    setMao((anterior) => {
                        const indice = anterior.indexOf(p.carta);
                        return indice === -1 ? anterior : anterior.filter((_, i) => i !== indice);
                    });
                }
                registrar(`${p.jogador} jogou ${p.carta}`);
            },
            vazaFinalizada(p) {
                if (!daSala(p)) return;
                setMesa([]);
                registrar(p.vencedor ? `Vaza: ${p.vencedor} venceu com ${p.carta}` : 'Vaza melada — ninguém pontuou');
            },
            rodadaFinalizada(p) {
                if (!daSala(p)) return;
                setUltimoPlacar(p.resultado);
                registrar(`Fim da rodada ${p.numero}`);
            },
            jogadoresEliminados(p) {
                if (!daSala(p)) return;
                const nomes = p.eliminados.map((j) => j.nome);
                setEliminados((anterior) => [...new Set([...anterior, ...nomes])]);
                registrar(`💀 Eliminado(s): ${nomes.join(', ')}`);
            },
            jogoFinalizado(p) {
                if (!daSala(p)) return;
                setVencedor(p.vencedor);
                registrar(`🏆 Vencedor: ${p.vencedor}`);
            },
            jogadaAutomatica(p) {
                if (!daSala(p)) return;
                registrar(`⏱️ ${p.jogador} não respondeu a tempo — jogada automática`);
            },
            jogadorReconectou(p) {
                if (!daSala(p)) return;
                registrar(`🔌 ${p.jogador} reconectou`);
            },
            jogadorExpulsoPorInatividade(p) {
                if (!daSala(p)) return;
                if (p.jogador === meuNome) {
                    registrar('⏱️ Você foi desconectado da sala por inatividade');
                    onSairDaPartida(salaId);
                } else {
                    registrar(`⏱️ ${p.jogador} foi desconectado por inatividade`);
                }
            },
        };

        // Loga todo evento recebido, com nome e payload — cobre qualquer
        // handler acima sem precisar espalhar console.log manual por dentro
        // de cada um. Confira o console do navegador (F12) pra debugar o
        // que chega ao abrir/jogar numa sala.
        const comLog = Object.fromEntries(
            Object.entries(handlers).map(([evento, handler]) => [
                evento,
                (payload) => {
                    console.log(`[socket] ${evento}`, payload);
                    handler(payload);
                },
            ])
        );

        for (const [evento, handler] of Object.entries(comLog)) socket.on(evento, handler);
        return () => {
            for (const [evento, handler] of Object.entries(comLog)) socket.off(evento, handler);
        };
    }, [salaId]);

    async function apostar(evento) {
        evento.preventDefault();
        setErro(null);
        const valor = Number(valorAposta);
        if (!Number.isInteger(valor) || valor < 0 || valor > cartasRodada) {
            setErro(`Aposta precisa ser um número inteiro entre 0 e ${cartasRodada}.`);
            return;
        }
        try {
            await chamar('apostar', { salaId, valor });
            setValorAposta('');
        } catch (erroDaChamada) {
            setErro(erroDaChamada.message);
        }
    }

    async function jogar(indice) {
        setErro(null);
        try {
            await chamar('jogarCarta', { salaId, indice });
            setMao((anterior) => anterior.filter((_, i) => i !== indice));
        } catch (erroDaChamada) {
            setErro(erroDaChamada.message);
        }
    }

    async function forcarInicio() {
        setErro(null);
        try {
            await chamar('forcarInicio', { salaId });
        } catch (erroDaChamada) {
            setErro(erroDaChamada.message);
        }
    }

    // Botão de sair é sempre uma opção, antes ou depois da partida começar —
    // só muda o que significa "sair". Antes: sairSala de verdade (tira o
    // assento, ver PROTOCOLO.md). Depois: sairDaPartida — o assento vira bot
    // na hora no servidor (reaproveita o caminho da expulsão por
    // inatividade), em vez de esperar o timeout de inatividade acumular a
    // cada turno. Nos dois casos a gente volta pra tela de salas; se a
    // partida já tinha começado, a Lobby oferece reconectar (a vaga
    // continua reservada). O onSairDaPartida também é chamado pelo handler
    // de jogadorExpulsoPorInatividade quando o evento chega — chamar aqui
    // cobre o caso de a resposta demorar/falhar, e a dupla chamada é
    // idempotente (mesmo salaId, mesmo setSala(null)).
    async function sair() {
        if (!iniciada) {
            try {
                await chamar('sairSala', { salaId });
            } catch {
                // melhor esforço — se a partida começou bem nesse meio tempo, cai no caso abaixo
            }
            onSairDaSala();
            return;
        }
        try {
            await chamar('sairDaPartida', { salaId });
        } catch {
            // melhor esforço — mesmo se falhar, saímos da tela; o assento
            // acaba virando bot pelo timeout de inatividade de qualquer jeito
        }
        onSairDaPartida(salaId);
    }

    const souEuNaVez = iniciada && jogadorDaVez === meuNome && !vencedor;
    const souEuNaVezDaAposta = iniciada && jogadorDaVezAposta === meuNome && !vencedor;
    // Rodada de 1 carta: a própria carta fica virada (o servidor manda o
    // valor em suaMao, mas aqui a gente não mostra — a mão continua jogável
    // normalmente por índice). As cartas dos outros vêm em maosReveladas.
    const rodadaCega = iniciada && cartasRodada === 1;
    const outrosNaTesta = Object.entries(maosReveladas);

    console.log('vira:', vira);

    return (
        <div className="cartao cartao-larga">
            <div className="linha" style={{ justifyContent: 'space-between' }}>
                <h1>Sala {salaId}</h1>
                <button className="secundario" onClick={sair} type="button">
                    {iniciada ? 'Sair da partida' : 'Sair da sala'}
                </button>
            </div>

            {!iniciada && (
                <section>
                    <h2>Aguardando ({jogadores.length})</h2>
                    <ul>
                        {jogadores.map((j) => <li key={j.nome}>{j.nome}</li>)}
                    </ul>
                    {segundosParaIniciar != null && (
                        <>
                            <p>Sala cheia — começa sozinha em {segundosParaIniciar}s.</p>
                            <button onClick={forcarInicio} type="button">Forçar início agora porra</button>
                        </>
                    )}
                </section>
            )}

            {iniciada && (
                <section>
                    <div className="status-jogadores">
                        {jogadores.map((j) => {
                            const morreu = eliminados.includes(j.nome);
                            const aposta = apostas[j.nome];
                            return (
                                <span
                                    key={j.nome}
                                    className={`status-jogador${morreu ? ' status-jogador-morto' : ''}`}
                                >
                                    {morreu
                                        ? `💀 ${j.nome} morreu`
                                        : aposta !== undefined
                                            ? `${j.nome} apostou ${aposta}`
                                            : j.nome}
                                </span>
                            );
                        })}
                    </div>

                    <h2>{vencedor ? `Vencedor: ${vencedor}` : `Vez de: ${jogadorDaVez ?? '...'}`}</h2>

                    <h3>Mesa</h3>
                    <div className="mesa">
                        {mesa.map((jogada, i) => (
                            <span key={i} className="carta">{jogada.carta}<br /><small>{jogada.jogador}</small></span>
                        ))}
                        {mesa.length === 0 && <span className="vazio">(vazia)</span>}
                    </div>

                    {vira && (
                        <>
                            <h3>Vira</h3>
                            <div className="mao">
                                <span className="carta">{vira.carta}<br /><small>manilha: {vira.valor}</small></span>
                            </div>
                        </>
                    )}

                    {outrosNaTesta.length > 0 && (
                        <>
                            <h3>Rodada cega — cartas dos outros (você não vê a sua)</h3>
                            <div className="mao">
                                {outrosNaTesta.map(([nome, cartas]) => (
                                    <span key={nome} className="carta">
                                        {cartas.join(' ')}<br /><small>{nome}</small>
                                    </span>
                                ))}
                            </div>
                        </>
                    )}

                    {jogadorDaVezAposta && (
                        <>
                            <h3>Aposta{souEuNaVezDaAposta ? ' — sua vez' : ` — vez de ${jogadorDaVezAposta}`}</h3>
                            {souEuNaVezDaAposta ? (
                                <form className="linha" onSubmit={apostar}>
                                    <label>
                                        Quantas vazas você acha que vai fazer?
                                        <input
                                            type="number" min="0" max={cartasRodada}
                                            value={valorAposta}
                                            onChange={(e) => setValorAposta(e.target.value)}
                                            autoFocus
                                        />
                                    </label>
                                    <button type="submit">Apostar</button>
                                </form>
                            ) : (
                                <p>Aguardando {jogadorDaVezAposta} apostar...</p>
                            )}
                        </>
                    )}

                    <h3>
                        Sua mão
                        {rodadaCega ? ' — virada (rodada cega)' : ''}
                        {souEuNaVez ? ' — sua vez, clique numa carta' : ''}
                    </h3>
                    <div className="mao">
                        {mao.map((carta, indice) => (
                            <button
                                key={indice}
                                className="carta carta-clicavel"
                                disabled={!souEuNaVez}
                                onClick={() => jogar(indice)}
                            >
                                {rodadaCega ? '🂠' : carta}
                            </button>
                        ))}
                        {mao.length === 0 && <span className="vazio">(sem cartas)</span>}
                    </div>

                    {ultimoPlacar.length > 0 && (
                        <>
                            <h3>Placar (última rodada)</h3>
                            <ul>
                                {ultimoPlacar.map((jogador) => (
                                    <li key={jogador.nome}>{jogador.nome}: hp {jogador.hp}</li>
                                ))}
                            </ul>
                        </>
                    )}
                </section>
            )}

            {erro && <p className="erro">{erro}</p>}

            <section>
                <h3>Log de eventos (debug)</h3>
                <pre className="log">{log.join('\n')}</pre>
            </section>
        </div>
    );
}

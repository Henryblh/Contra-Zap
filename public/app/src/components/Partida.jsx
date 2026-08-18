import { useEffect, useState } from 'react';
import { socket, chamar } from '../socket.js';

// Tela 3: uma sala inteira, da espera até o fim da partida. É um componente
// só (não um por fase) porque é uma assinatura contínua dos mesmos eventos
// do GameController, do início ao fim — ver conexao/PROTOCOLO.md pra tabela
// completa de eventos e payloads.
export default function Partida({ salaId, jogadoresIniciais, meuNome, onSairDaSala }) {
    // Semeado do ack de criarSala/entrarSala, não do broadcast de
    // listaJogadores — o primeiro broadcast sai antes desta tela existir
    // (e o listener abaixo com ele), então dependeria de um evento que já
    // passou. Broadcasts seguintes (mais gente entrando) chegam normal.
    const [jogadores, setJogadores] = useState(jogadoresIniciais ?? []);
    const [segundosParaIniciar, setSegundosParaIniciar] = useState(null);
    const [iniciada, setIniciada] = useState(false);
    const [mao, setMao] = useState([]);
    const [jogadorDaVez, setJogadorDaVez] = useState(null);
    const [mesa, setMesa] = useState([]);
    const [ultimoPlacar, setUltimoPlacar] = useState([]);
    const [vencedor, setVencedor] = useState(null);
    const [log, setLog] = useState([]);
    const [erro, setErro] = useState(null);

    useEffect(() => {
        const registrar = (linha) => setLog((anterior) => [...anterior.slice(-49), linha]);
        const daSala = (payload) => payload.salaId === salaId;

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
                registrar(`Rodada ${p.numero} (${p.cartas} carta(s))`);
            },
            suaMao(p) {
                if (!daSala(p)) return;
                setMao(p.mao);
                registrar(`Sua mão: ${p.mao.join(', ')}`);
            },
            manilhaVirada(p) {
                if (!daSala(p)) return;
                registrar(`Vira: ${p.vira} — manilha valor ${p.viraValor}`);
            },
            apostaFeita(p) {
                if (!daSala(p)) return;
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
                registrar(`💀 Eliminado(s): ${p.eliminados.map((j) => j.nome).join(', ')}`);
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
        };

        for (const [evento, handler] of Object.entries(handlers)) socket.on(evento, handler);
        return () => {
            for (const [evento, handler] of Object.entries(handlers)) socket.off(evento, handler);
        };
    }, [salaId]);

    async function jogar(indice) {
        setErro(null);
        try {
            await chamar('jogarCarta', { salaId, indice });
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

    async function sairDaSala() {
        try {
            await chamar('sairSala', { salaId });
        } catch {
            // melhor esforço — se já iniciou, o botão nem deveria aparecer
        }
        onSairDaSala();
    }

    const souEuNaVez = iniciada && jogadorDaVez === meuNome && !vencedor;

    return (
        <div className="cartao cartao-larga">
            <div className="linha" style={{ justifyContent: 'space-between' }}>
                <h1>Sala {salaId}</h1>
                {!iniciada && <button className="secundario" onClick={sairDaSala} type="button">Sair da sala</button>}
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
                            <button onClick={forcarInicio} type="button">Forçar início agora</button>
                        </>
                    )}
                </section>
            )}

            {iniciada && (
                <section>
                    <h2>{vencedor ? `Vencedor: ${vencedor}` : `Vez de: ${jogadorDaVez ?? '...'}`}</h2>

                    <h3>Mesa</h3>
                    <div className="mesa">
                        {mesa.map((jogada, i) => (
                            <span key={i} className="carta">{jogada.carta}<br /><small>{jogada.jogador}</small></span>
                        ))}
                        {mesa.length === 0 && <span className="vazio">(vazia)</span>}
                    </div>

                    <h3>Sua mão{souEuNaVez ? ' — sua vez, clique numa carta' : ''}</h3>
                    <div className="mao">
                        {mao.map((carta, indice) => (
                            <button
                                key={indice}
                                className="carta carta-clicavel"
                                disabled={!souEuNaVez}
                                onClick={() => jogar(indice)}
                            >
                                {carta}
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

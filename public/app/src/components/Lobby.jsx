import { useEffect, useState } from 'react';
import { chamar } from '../socket.js';

const INTERVALO_ATUALIZACAO_MS = 10_000;

// Tela 2: criar uma sala nova, listar/entrar numa já aberta, ou reconectar
// numa partida em andamento em que ainda temos assento (expulsão por
// inatividade ou "Sair da partida" manual — ver Partida.jsx).
export default function Lobby({ meuNome, salaParaReconectar, onEntrouNaSala, onReconectou }) {
    const [salas, setSalas] = useState(null); // null = ainda não buscou
    const [numberPlayers, setNumberPlayers] = useState(4);
    const [roundStart, setRoundStart] = useState(3);
    const [botNumber, setBotNumber] = useState(0);
    const [chatAberto, setChatAberto] = useState(false);
    const [reconectando, setReconectando] = useState(false);
    const [erro, setErro] = useState(null);
    // Preenchido quando uma tentativa de criar/entrar numa sala volta
    // JA_EM_PARTIDA: { salaAtivaId, retomar } — `retomar` re-executa a ação
    // original (criar sala / entrar / partida rápida) depois que o jogador
    // resolver a partida antiga (reconectando nela ou desistindo dela).
    const [colisaoPartida, setColisaoPartida] = useState(null);

    // Roda `acao` (uma das entradas de sala) e, se o servidor barrar com
    // JA_EM_PARTIDA, guarda tudo pra oferecer reconectar/desistir em vez de
    // só jogar o erro na tela. Qualquer outro erro é mostrado normalmente.
    async function tentarEntrada(acao) {
        setErro(null);
        try {
            await acao();
        } catch (erroDaChamada) {
            if (erroDaChamada.codigo === 'JA_EM_PARTIDA') {
                setColisaoPartida({ salaAtivaId: erroDaChamada.resposta?.salaId, retomar: acao });
            } else {
                setErro(erroDaChamada.message);
            }
        }
    }

    async function atualizarLista() {
        setErro(null);
        try {
            const resposta = await chamar('listarSalas');
            setSalas(resposta.salas);
        } catch (erroDaChamada) {
            setErro(erroDaChamada.message);
        }
    }

    useEffect(() => {
        atualizarLista();
        const intervalo = setInterval(atualizarLista, INTERVALO_ATUALIZACAO_MS);
        return () => clearInterval(intervalo);
    }, []);

    function partidaRapida() {
        return tentarEntrada(async () => {
            const resposta = await chamar('partidaRapida');
            onEntrouNaSala(resposta.salaId, resposta.jogadores, resposta.segundosParaIniciar, resposta.chatAberto);
        });
    }

    function criarSala(evento) {
        evento.preventDefault();
        return tentarEntrada(async () => {
            const resposta = await chamar('criarSala', {
                numberPlayers: Number(numberPlayers),
                roundStart: Number(roundStart),
                botNumber: Number(botNumber),
                chatAberto,
            });
            // O ack já traz o roster inicial (não só o broadcast de
            // listaJogadores) — a tela da sala só monta depois disso, então
            // dependeria de um broadcast que já passou. Mesma coisa pro
            // segundosParaIniciar quando os bots já lotaram a sala.
            onEntrouNaSala(resposta.salaId, resposta.jogadores, resposta.segundosParaIniciar, resposta.chatAberto);
        });
    }

    function entrarSala(salaId) {
        return tentarEntrada(async () => {
            const resposta = await chamar('entrarSala', { salaId });
            onEntrouNaSala(salaId, resposta.jogadores, resposta.segundosParaIniciar, resposta.chatAberto);
        });
    }

    // Reconectar na partida antiga que barrou a entrada (ver colisaoPartida)
    // — mesma transição de tela do banner de reconexão de sempre.
    async function reconectarNaColisao() {
        setErro(null);
        try {
            const resposta = await chamar('reconectar', { salaId: colisaoPartida.salaAtivaId });
            onReconectou(colisaoPartida.salaAtivaId, resposta);
        } catch (erroDaChamada) {
            setErro(erroDaChamada.message);
            setColisaoPartida(null);
        }
    }

    // Desistir de vez da partida antiga (perde na hora, libera a vaga) e
    // então repetir a ação que tinha sido barrada.
    async function desistirEEntrar() {
        const { salaAtivaId, retomar } = colisaoPartida;
        setColisaoPartida(null);
        setErro(null);
        try {
            await chamar('desistir', { salaId: salaAtivaId });
        } catch (erroDaChamada) {
            setErro(erroDaChamada.message);
            return;
        }
        // tentarEntrada re-arma a colisão se (corrida improvável) ainda barrar.
        tentarEntrada(retomar);
    }

    // A sala nunca aparece em "Salas abertas" (listarSalas só devolve salas
    // não iniciadas) — a partida dela já começou, então o único jeito de
    // voltar é "reconectar" direto pelo salaId guardado no App, sem passar
    // por entrarSala.
    async function reconectar() {
        setErro(null);
        setReconectando(true);
        try {
            const resposta = await chamar('reconectar', { salaId: salaParaReconectar });
            onReconectou(salaParaReconectar, resposta);
        } catch (erroDaChamada) {
            setErro(erroDaChamada.message);
        } finally {
            setReconectando(false);
        }
    }

    return (
        <div className="cartao">
            <h1>Olá, {meuNome}</h1>

            {salaParaReconectar && (
                <section>
                    <h2>🔌 Você saiu da sala {salaParaReconectar}</h2>
                    <p>Sua vaga na partida continua reservada.</p>
                    <button onClick={reconectar} disabled={reconectando} type="button">
                        {reconectando ? 'Reconectando...' : 'Reconectar'}
                    </button>
                </section>
            )}

            {colisaoPartida && (
                <section>
                    <h2>⚠️ Você já está numa partida</h2>
                    <p>
                        Tem uma partida em andamento
                        {colisaoPartida.salaAtivaId ? ` (sala ${colisaoPartida.salaAtivaId})` : ''}.
                        Reconecte nela, ou desista de vez (você perde a partida na
                        hora) pra entrar em outra.
                    </p>
                    <div className="linha">
                        <button type="button" onClick={reconectarNaColisao}>Reconectar</button>
                        <button type="button" className="secundario" onClick={desistirEEntrar}>
                            Desistir e entrar
                        </button>
                        <button type="button" className="secundario" onClick={() => setColisaoPartida(null)}>
                            Cancelar
                        </button>
                    </div>
                </section>
            )}

            <section>
                <button type="button" onClick={partidaRapida} style={{ width: '100%' }}>
                    Partida rápida
                </button>
            </section>

            <section>
                <h2>Criar sala</h2>
                <form className="linha">
                    <label>
                        Jogadores
                        <input
                            type="number" min="2" max="6"
                            value={numberPlayers}
                            onChange={(e) => setNumberPlayers(e.target.value)}
                        />
                    </label>
                    <label>
                        Cartas na 1ª rodada
                        <input
                            type="number" min="1"
                            value={roundStart}
                            onChange={(e) => setRoundStart(e.target.value)}
                        />
                    </label>
                    <label>
                        Bots
                        <input
                            type="number" min="0" max={Math.max(0, Number(numberPlayers) - 1)}
                            value={botNumber}
                            onChange={(e) => setBotNumber(e.target.value)}
                        />
                    </label>
                    <label style={{ flexDirection: 'row', alignItems: 'center', gap: '6px' }}>
                        <input
                            type="checkbox"
                            checked={chatAberto}
                            onChange={(e) => setChatAberto(e.target.checked)}
                        />
                        Chat aberto
                    </label>
                    <button onClick={criarSala}>Criar</button>
                </form>
            </section>

            <section>
                <div className="linha" style={{ justifyContent: 'space-between' }}>
                    <h2>Salas abertas</h2>
                    <button className="secundario" onClick={atualizarLista} type="button">
                        Atualizar lista
                    </button>
                </div>
                {salas === null && <p>Clique em "Atualizar lista" pra ver as salas abertas.</p>}
                {salas?.length === 0 && <p>Nenhuma sala aberta no momento.</p>}
                <ul className="lista-salas">
                    {salas?.map((sala) => (
                        <li key={sala.salaId}>
                            <span>{sala.salaId} — {sala.jogadoresAtual}/{sala.numberPlayers}</span>
                            <button onClick={() => entrarSala(sala.salaId)} type="button">Entrar</button>
                        </li>
                    ))}
                </ul>
            </section>

            {erro && <p className="erro">{erro}</p>}
        </div>
    );
}

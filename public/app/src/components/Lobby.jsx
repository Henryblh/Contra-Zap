import { useState } from 'react';
import { chamar } from '../socket.js';

// Tela 2: criar uma sala nova ou listar/entrar numa já aberta.
export default function Lobby({ meuNome, onEntrouNaSala }) {
    const [salas, setSalas] = useState(null); // null = ainda não buscou
    const [numberPlayers, setNumberPlayers] = useState(4);
    const [roundStart, setRoundStart] = useState(3);
    const [erro, setErro] = useState(null);

    async function atualizarLista() {
        setErro(null);
        try {
            const resposta = await chamar('listarSalas');
            setSalas(resposta.salas);
        } catch (erroDaChamada) {
            setErro(erroDaChamada.message);
        }
    }

    async function criarSala(evento) {
        evento.preventDefault();
        setErro(null);
        try {
            const resposta = await chamar('criarSala', {
                numberPlayers: Number(numberPlayers),
                roundStart: Number(roundStart),
            });
            // O ack já traz o roster inicial (não só o broadcast de
            // listaJogadores) — a tela da sala só monta depois disso, então
            // dependeria de um broadcast que já passou.
            onEntrouNaSala(resposta.salaId, resposta.jogadores);
        } catch (erroDaChamada) {
            setErro(erroDaChamada.message);
        }
    }

    async function entrarSala(salaId) {
        setErro(null);
        try {
            const resposta = await chamar('entrarSala', { salaId });
            onEntrouNaSala(salaId, resposta.jogadores);
        } catch (erroDaChamada) {
            setErro(erroDaChamada.message);
        }
    }

    return (
        <div className="cartao">
            <h1>Olá, {meuNome}</h1>

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

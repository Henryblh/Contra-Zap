import { useState } from 'react';
import Login from './components/Login.jsx';
import Lobby from './components/Lobby.jsx';
import Partida from './components/Partida.jsx';

// Máquina de estado bem simples: sem token/login persistido em lugar
// nenhum (nem localStorage, nem cookie) de propósito — ver socket.js.
export default function App() {
    const [player, setPlayer] = useState(null); // { nome, token }
    const [sala, setSala] = useState(null); // { salaId, jogadoresIniciais } ou { salaId, reconexao }
    // salaId de uma partida em andamento em que ainda temos assento mas cujo
    // socket não está mais na room — seja por expulsão por inatividade (ver
    // jogadorExpulsoPorInatividade em conexao/PROTOCOLO.md), seja por ter
    // clicado em "Sair da partida" (puramente client-side: cair da partida
    // não mexe no assento, ver PROTOCOLO.md). Só em memória, mesma filosofia
    // de socket.js de não persistir nada; some se a aba recarregar. É o que
    // permite a Lobby oferecer "reconectar" de volta especificamente pra
    // essa sala.
    const [salaParaReconectar, setSalaParaReconectar] = useState(null);

    if (!player) {
        return <Login onAutenticado={setPlayer} />;
    }
    if (!sala) {
        return (
            <Lobby
                meuNome={player.nome}
                salaParaReconectar={salaParaReconectar}
                onEntrouNaSala={(salaId, jogadoresIniciais) => {
                    setSalaParaReconectar(null);
                    setSala({ salaId, jogadoresIniciais });
                }}
                onReconectou={(salaId, reconexao) => {
                    setSalaParaReconectar(null);
                    setSala({ salaId, reconexao });
                }}
            />
        );
    }
    return (
        <Partida
            salaId={sala.salaId}
            jogadoresIniciais={sala.jogadoresIniciais}
            reconexao={sala.reconexao}
            meuNome={player.nome}
            onSairDaSala={() => setSala(null)}
            onSairDaPartida={(salaId) => {
                setSalaParaReconectar(salaId);
                setSala(null);
            }}
        />
    );
}

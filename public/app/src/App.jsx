import { useState } from 'react';
import Login from './components/Login.jsx';
import Lobby from './components/Lobby.jsx';
import Partida from './components/Partida.jsx';

// Máquina de estado bem simples: sem token/login persistido em lugar
// nenhum (nem localStorage, nem cookie) de propósito — ver socket.js.
export default function App() {
    const [player, setPlayer] = useState(null); // { nome, token }
    const [sala, setSala] = useState(null); // { salaId, jogadoresIniciais }

    if (!player) {
        return <Login onAutenticado={setPlayer} />;
    }
    if (!sala) {
        return (
            <Lobby
                meuNome={player.nome}
                onEntrouNaSala={(salaId, jogadoresIniciais) => setSala({ salaId, jogadoresIniciais })}
            />
        );
    }
    return (
        <Partida
            salaId={sala.salaId}
            jogadoresIniciais={sala.jogadoresIniciais}
            meuNome={player.nome}
            onSairDaSala={() => setSala(null)}
        />
    );
}

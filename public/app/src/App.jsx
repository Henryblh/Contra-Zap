import { useEffect, useState } from 'react';
import Login from './components/Login.jsx';
import Lobby from './components/Lobby.jsx';
import Partida from './components/Partida.jsx';
import { chamar } from './socket.js';

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

    // Assim que o login termina (inclusive depois de um refresh de página,
    // que reseta todo esse estado e manda a gente pra tela de Login de
    // novo), pergunta pro servidor se esse jogador já tem assento nalguma
    // partida em andamento (ver minhaSalaAtiva em conexao/PROTOCOLO.md) — é
    // o único jeito de descobrir isso sem guardar salaId em lugar nenhum do
    // cliente entre recarregas. Só roda uma vez por login (não por sala): se
    // já estamos numa Partida quando isso resolve, não faz sentido pisar em
    // cima do estado dela.
    useEffect(() => {
        if (!player) return;
        let cancelado = false;
        chamar('minhaSalaAtiva')
            .then((resposta) => {
                if (!cancelado && resposta.salaId) setSalaParaReconectar(resposta.salaId);
            })
            .catch(() => {}); // melhor esforço — se falhar, só não pré-preenche o banner
        return () => { cancelado = true; };
    }, [player]);

    if (!player) {
        return <Login onAutenticado={setPlayer} />;
    }
    if (!sala) {
        return (
            <Lobby
                meuNome={player.nome}
                salaParaReconectar={salaParaReconectar}
                onEntrouNaSala={(salaId, jogadoresIniciais, segundosParaIniciar, chatAberto) => {
                    setSalaParaReconectar(null);
                    setSala({ salaId, jogadoresIniciais, segundosParaIniciar, chatAberto });
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
            segundosIniciais={sala.segundosParaIniciar}
            reconexao={sala.reconexao}
            chatAberto={sala.chatAberto ?? sala.reconexao?.chatAberto ?? false}
            meuNome={player.nome}
            onSairDaSala={() => setSala(null)}
            onSairDaPartida={(salaId) => {
                setSalaParaReconectar(salaId);
                setSala(null);
            }}
        />
    );
}

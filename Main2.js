// Main2.js
// Harness de teste de um jogador de verdade: conecta no Server.js via
// socket.io-client, loga (nome/senha contra o banco, resolvido no servidor),
// e entra num loop pra criar uma sala nova ou entrar numa já aberta. Depois
// de entrar numa sala, imprime a lista de jogadores a cada atualização e,
// quando a sala lota, a partida inteira (mão própria, jogadas, vazas,
// vencedor). Na sua vez, pede pra escolher a carta pelo número (1, 2, 3...)
// — só não manda forcarInicio ainda: pra isso hoje precisa emitir o evento
// manualmente, não tem prompt de CLI pra isso.
//
// Rodar (em dois terminais separados):
//   npm start      -> sobe o servidor em http://localhost:3000
//   node Main2.js  -> um jogador entrando na sala (rode 4x pra simular a mesa)
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { io } from 'socket.io-client';

const URL_SERVIDOR = process.env.SERVIDOR_URL ?? 'http://localhost:3000';

const rl = createInterface({ input: stdin, output: stdout });
const pergunta = (texto) => rl.question(texto);

// Chama um evento do protocolo e devolve o ack; lança se o servidor
// respondeu { ok: false, ... } (ver conexao/PROTOCOLO.md).
function chamar(socket, evento, payload = {}) {
    return new Promise((resolve, reject) => {
        socket.emit(evento, payload, (resposta) => {
            if (resposta?.ok) resolve(resposta);
            else reject(new Error(`[${resposta?.codigo ?? 'ERRO_DESCONHECIDO'}] ${resposta?.mensagem ?? 'Erro sem detalhes.'}`));
        });
    });
}

function conectar() {
    const socket = io(URL_SERVIDOR);
    return new Promise((resolve, reject) => {
        socket.once('connect', () => resolve(socket));
        socket.once('connect_error', reject);
    });
}

async function fazerLogin(socket) {
    const nome = await pergunta('Nome: ');
    const senha = await pergunta('Senha: ');
    const resposta = await chamar(socket, 'entrar', { nome, senha });
    console.log(`\nLogin ok. Bem-vindo, ${resposta.nome}!`);
    console.log(`Token: ${resposta.token}\n`);
    return resposta;
}

async function fluxoCriarSala(socket) {
    const numberPlayers = Number(await pergunta('Número de jogadores (padrão 4): ') || 4);
    const roundStart = Number(await pergunta('Cartas na primeira rodada (padrão 3): ') || 3);
    const randomShuffle = (await pergunta('Embaralhar tudo junto (s/n, padrão s): ') || 's').toLowerCase() !== 'n';

    const resposta = await chamar(socket, 'criarSala', { numberPlayers, roundStart, randomShuffle });
    console.log(`\nSala criada: ${resposta.salaId} (${numberPlayers} jogadores)`);
    return resposta.salaId;
}

async function fluxoEntrarSala(socket) {
    const { salas } = await chamar(socket, 'listarSalas');
    if (salas.length === 0) {
        console.log('\nNenhuma sala aberta no momento.');
        return null;
    }

    console.log('\nSalas abertas:');
    for (const sala of salas) {
        console.log(`  ${sala.salaId} — ${sala.jogadoresAtual}/${sala.numberPlayers} jogadores`);
    }

    const salaId = await pergunta('\nEntrar em qual sala (salaId)? ');
    const resposta = await chamar(socket, 'entrarSala', { salaId: salaId.trim() });
    console.log(`\nEntrou na sala ${resposta.salaId}.`);
    return resposta.salaId;
}

async function menuSala(socket) {
    while (true) {
        const escolha = (await pergunta('\nCriar sala ou entrar em uma existente? (criar/entrar): ')).trim().toLowerCase();

        try {
            if (escolha === 'criar') {
                return await fluxoCriarSala(socket);
            }
            if (escolha === 'entrar') {
                const salaId = await fluxoEntrarSala(socket);
                if (salaId) return salaId;
                continue;
            }
            console.log('Não entendi — digite "criar" ou "entrar".');
        } catch (erro) {
            console.log(`\nNão deu: ${erro.message}`);
        }
    }
}

// Pergunta qual carta jogar (1, 2, 3...), manda jogarCarta e tenta de novo
// se o servidor recusar (fora da vez, índice inválido) — a validação de
// verdade é toda do servidor, aqui é só UI.
async function escolherCarta(socket, salaId, minhaMao) {
    console.log(`\nSua vez! Cartas na mão:`);
    minhaMao.forEach((carta, i) => console.log(`  ${i + 1}) ${carta}`));

    while (true) {
        const escolha = await pergunta('Qual carta jogar (número)? ');
        const indice = Number(escolha) - 1;

        try {
            await chamar(socket, 'jogarCarta', { salaId, indice });
            minhaMao.splice(indice, 1);
            return;
        } catch (erro) {
            console.log(`Não deu: ${erro.message}`);
        }
    }
}

const socket = await conectar();
const { nome: meuNome } = await fazerLogin(socket);
const salaId = await menuSala(socket);

let minhaMao = [];

socket.on('listaJogadores', (payload) => {
    if (payload.salaId !== salaId) return;
    console.log(`\nJogadores na sala (${payload.jogadores.length}):`);
    for (const jogador of payload.jogadores) {
        console.log(`  - ${jogador.nome}`);
    }
});

// Eventos da partida, retransmitidos do GameController (ver PROTOCOLO.md).
// suaMao é privado — só chega aqui se for a mão deste jogador.
socket.on('partidaIniciandoEm', ({ segundos }) => {
    console.log(`\nSala cheia — partida começa em ${segundos}s (ou quando o dono forçar).`);
});
socket.on('novaRodadaIniciada', ({ numero, cartas }) => {
    console.log(`\n===== Rodada ${numero} (${cartas} cartas) =====`);
});
socket.on('suaMao', ({ mao }) => {
    minhaMao = mao;
    console.log(`Sua mão: ${mao.map((c, i) => `${i + 1}) ${c}`).join('  ')}`);
});
socket.on('manilhaVirada', ({ vira, viraValor }) => {
    console.log(`Vira: ${vira} | Manilha: ${viraValor}`);
});
socket.on('turnoJogador', ({ jogador }) => {
    if (jogador !== meuNome) {
        console.log(`Vez de: ${jogador}`);
        return;
    }
    escolherCarta(socket, salaId, minhaMao);
});
socket.on('cartaJogada', ({ jogador, carta, status }) => {
    console.log(`> ${jogador} jogou ${carta} (${status.status})`);
});
socket.on('vazaFinalizada', ({ vencedor, carta }) => {
    console.log(vencedor ? `Vaza: ${vencedor} venceu com ${carta}` : 'Vaza melada, ninguém pontuou');
});
socket.on('rodadaFinalizada', ({ numero, resultado }) => {
    console.log(`\nFim da rodada ${numero}:`);
    for (const { nome, hp } of resultado) {
        console.log(`  ${nome}: hp ${hp}`);
    }
});
socket.on('jogadoresEliminados', ({ eliminados }) => {
    for (const { nome } of eliminados) console.log(`💀 ${nome} foi eliminado`);
});
socket.on('jogoFinalizado', ({ vencedor }) => {
    console.log(`\n🏆 Vencedor: ${vencedor}`);
});

console.log(`\nAguardando na sala ${salaId}... (Ctrl+C para sair)`);
await new Promise(() => {});

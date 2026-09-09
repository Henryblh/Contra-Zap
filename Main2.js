// Main2.js
// Harness de teste de um jogador de verdade: conecta no Server.js via
// socket.io-client, loga (nome/senha contra o banco, resolvido no servidor),
// e entra num loop pra criar uma sala nova ou entrar numa já aberta. Depois
// de entrar numa sala, imprime a lista de jogadores a cada atualização e,
// quando a sala lota, a partida inteira (mão própria, jogadas, vazas,
// vencedor). Na sua vez, é só digitar o número (da aposta ou da carta).
//
// Logo depois do login ele checa `minhaSalaAtiva` e oferece `reconectar`
// numa partida em andamento. Durante a partida, um loop de comando aceita
// `sair` (ou `q`) a qualquer momento pra abandonar — `sairSala` antes de
// começar, `sairDaPartida` depois (o assento vira bot; dá pra voltar rodando
// o Main2.js de novo e reconectando). `forcarInicio` ainda não tem comando —
// pra isso precisa emitir o evento na mão.
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

// Depois do login: pergunta ao servidor se já existe uma partida em andamento
// com assento nosso (minhaSalaAtiva) e, se existir, oferece reconectar antes de
// cair no menu de criar/entrar sala. Devolve { salaId, estado } (estado é o ack
// de reconectar) ou null pra seguir o fluxo normal.
async function tentarReconectar(socket) {
    let salaAtiva;
    try {
        ({ salaId: salaAtiva } = await chamar(socket, 'minhaSalaAtiva'));
    } catch {
        return null;
    }
    if (!salaAtiva) return null;

    const resposta = (await pergunta(`\nVocê tem uma partida em andamento na sala ${salaAtiva}. Reconectar? (s/n): `)).trim().toLowerCase();
    if (resposta.startsWith('n')) return null;

    try {
        const estado = await chamar(socket, 'reconectar', { salaId: salaAtiva });
        console.log(`\nReconectado na sala ${salaAtiva}.`);
        console.log(`Sua mão: ${(estado.mao ?? []).map((c, i) => `${i + 1}) ${c}`).join('  ')}`);
        if (estado.suaVezDaAposta) console.log('É a sua vez de apostar.');
        else if (estado.suaVez) console.log('É a sua vez de jogar.');
        else console.log(`Vez de: ${estado.jogadorDaVezAposta ?? estado.jogadorDaVez ?? '...'}`);
        return { salaId: salaAtiva, estado };
    } catch (erro) {
        console.log(`\nNão deu pra reconectar: ${erro.message}`);
        return null;
    }
}

const socket = await conectar();
const { nome: meuNome } = await fazerLogin(socket);

let minhaMao = [];

const reconexao = await tentarReconectar(socket);
const salaId = reconexao ? reconexao.salaId : await menuSala(socket);
if (reconexao) minhaMao = reconexao.estado.mao ?? [];

// --- estado da entrada de teclado durante a partida ---
// Depois que a fase sequencial de menu/pergunta acaba, todo o input passa por
// um único `rl.on('line')` (registrado no fim do arquivo). `modoEntrada` diz o
// que a linha digitada significa agora; 'sair' funciona em QUALQUER modo.
let modoEntrada = 'ocioso'; // 'ocioso' | 'aposta' | 'carta'
let partidaIniciada = !!reconexao; // antes de começar: sairSala; depois: sairDaPartida
let partidaAcabou = false;
let saindo = false;

// Único caminho de saída da mesa. Antes da partida começar é `sairSala` (tira o
// assento de verdade); com a partida em andamento (ou já terminada) é
// `sairDaPartida` — o assento vira bot na hora e a vaga fica reservada pra um
// `reconectar` (rode o Main2.js de novo). Ver conexao/PROTOCOLO.md.
async function sairDaMesa() {
    if (saindo) return;
    saindo = true;
    const evento = partidaIniciada ? 'sairDaPartida' : 'sairSala';
    try {
        await chamar(socket, evento, { salaId });
        console.log(
            evento === 'sairDaPartida'
                ? '\nVocê saiu da partida — seu assento virou bot. Pra voltar, rode o Main2.js de novo e reconecte.'
                : '\nVocê saiu da sala.'
        );
    } catch (erro) {
        console.log(`\nNão deu pra sair via ${evento}: ${erro.message}`);
    }
    rl.close();
    socket.close();
    process.exit(0);
}

// Despacha cada linha digitada conforme `modoEntrada`. 'sair'/'q' abandona a
// mesa a qualquer momento (é o loop de comando que roda a partida inteira).
async function tratarLinha(linhaCrua) {
    const linha = linhaCrua.trim().toLowerCase();

    if (linha === 'sair' || linha === 'q' || linha === 'quit') {
        await sairDaMesa();
        return;
    }
    if (linha === '') return;

    if (partidaAcabou) {
        console.log("Partida encerrada — digite 'sair' pra fechar.");
        return;
    }

    if (modoEntrada === 'aposta') {
        try {
            await chamar(socket, 'apostar', { salaId, valor: Number(linha) });
            modoEntrada = 'ocioso';
        } catch (erro) {
            console.log(`Não deu: ${erro.message} — tenta outro valor (ou 'sair').`);
        }
        return;
    }

    if (modoEntrada === 'carta') {
        try {
            await chamar(socket, 'jogarCarta', { salaId, indice: Number(linha) - 1 });
            minhaMao.splice(Number(linha) - 1, 1);
            modoEntrada = 'ocioso';
        } catch (erro) {
            console.log(`Não deu: ${erro.message} — tenta outra carta (ou 'sair').`);
        }
        return;
    }

    console.log("Não é sua vez. Digite 'sair' pra abandonar a partida.");
}

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
    partidaIniciada = true;
    console.log(`\n===== Rodada ${numero} (${cartas} cartas) =====`);
    console.log("(digite 'sair' a qualquer momento pra abandonar a partida)");
});
socket.on('suaMao', ({ mao }) => {
    minhaMao = mao;
    console.log(`Sua mão: ${mao.map((c, i) => `${i + 1}) ${c}`).join('  ')}`);
});
// Rodada de 1 carta ("testa"): a mão dos outros vem aqui, a sua não.
socket.on('maosReveladas', ({ maos }) => {
    console.log(`Rodada cega — cartas dos outros: ${maos.map((m) => `${m.jogador}: ${m.mao.join(', ')}`).join(' | ')}`);
});
socket.on('manilhaVirada', ({ vira, viraValor }) => {
    console.log(`Vira: ${vira} | Manilha: ${viraValor}`);
});
socket.on('turnoAposta', ({ jogador }) => {
    if (jogador !== meuNome) {
        console.log(`Vez de ${jogador} apostar`);
        return;
    }
    modoEntrada = 'aposta';
    console.log("Sua vez de apostar — quantas vazas você acha que vai fazer? (número, ou 'sair')");
});
socket.on('apostaFeita', ({ jogador, aposta }) => {
    console.log(`${jogador} apostou ${aposta}`);
    if (jogador === meuNome && modoEntrada === 'aposta') modoEntrada = 'ocioso';
});
socket.on('turnoJogador', ({ jogador }) => {
    if (jogador !== meuNome) {
        console.log(`Vez de: ${jogador}`);
        return;
    }
    modoEntrada = 'carta';
    console.log(`Sua vez! Cartas na mão: ${minhaMao.map((c, i) => `${i + 1}) ${c}`).join('  ')}`);
    console.log("Qual carta jogar? (número, ou 'sair')");
});
socket.on('cartaJogada', ({ jogador, carta, status }) => {
    console.log(`> ${jogador} jogou ${carta} (${status.status})`);
    // Jogada automática por timeout: a carta nunca saiu da mão local nem
    // limpou o modo — faz isso aqui (mesma ideia do front em Partida.jsx).
    if (jogador === meuNome) {
        const i = minhaMao.indexOf(carta);
        if (i !== -1) minhaMao.splice(i, 1);
        if (modoEntrada === 'carta') modoEntrada = 'ocioso';
    }
});
socket.on('jogadaAutomatica', ({ jogador }) => {
    if (jogador === meuNome) console.log('⏱️ Você não respondeu a tempo — o servidor jogou por você.');
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
socket.on('jogadorExpulsoPorInatividade', ({ jogador }) => {
    if (jogador !== meuNome) {
        console.log(`🤖 ${jogador} saiu/ficou inativo — um bot assumiu o lugar dele.`);
        return;
    }
    if (saindo) return; // já foi a gente que pediu pra sair
    console.log('\n⏱️ Você foi removido da sala por inatividade. Rode o Main2.js de novo pra reconectar.');
    rl.close();
    socket.close();
    process.exit(0);
});
socket.on('jogoFinalizado', ({ vencedor }) => {
    partidaAcabou = true;
    modoEntrada = 'ocioso';
    console.log(`\n🏆 Vencedor: ${vencedor}`);
    console.log("Partida encerrada — digite 'sair' pra fechar.");
});
socket.on('chatMensagem', ({ jogador, texto }) => {
    console.log(`💬 ${jogador}: ${texto}`);
});

// Loop de comando da partida inteira: uma única fonte de input a partir daqui
// (a fase sequencial de menu/pergunta já terminou). Cada linha vai pro
// despachante conforme o modo atual; 'sair' abandona a mesa em qualquer modo.
rl.on('line', (linha) => {
    tratarLinha(linha).catch((erro) => console.log(`Erro inesperado: ${erro.message}`));
});
rl.on('SIGINT', () => { rl.close(); socket.close(); process.exit(0); });

console.log(`\nAguardando na sala ${salaId}... (digite 'sair' pra abandonar, Ctrl+C pra fechar)`);

// Se reconectamos no meio de um turno nosso, o servidor não reemite
// turnoAposta/turnoJogador (já passaram) — arma o modo de entrada aqui pelo
// estado que reconectar devolveu.
if (reconexao?.estado?.suaVezDaAposta) {
    modoEntrada = 'aposta';
    console.log("Sua vez de apostar — quantas vazas? (número, ou 'sair')");
} else if (reconexao?.estado?.suaVez) {
    modoEntrada = 'carta';
    console.log(`Sua vez! Cartas na mão: ${minhaMao.map((c, i) => `${i + 1}) ${c}`).join('  ')}`);
    console.log("Qual carta jogar? (número, ou 'sair')");
}

await new Promise(() => {});

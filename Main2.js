// Main2.js
// Harness de teste de um jogador de verdade: conecta no Server.js via
// socket.io-client, loga (nome/senha contra banco.json, resolvido no
// servidor), e entra num loop pra criar uma sala nova ou entrar numa já
// aberta. Depois de entrar numa sala, fica esperando (imprimindo a lista de
// jogadores a cada atualização) — início de partida é o próximo marco.
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

const socket = await conectar();
await fazerLogin(socket);
const salaId = await menuSala(socket);
rl.close();

socket.on('listaJogadores', (payload) => {
    if (payload.salaId !== salaId) return;
    console.log(`\nJogadores na sala (${payload.jogadores.length}):`);
    for (const jogador of payload.jogadores) {
        console.log(`  - ${jogador.nome}`);
    }
});

console.log(`\nAguardando na sala ${salaId}... (Ctrl+C para sair)`);
await new Promise(() => {});

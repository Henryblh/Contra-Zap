// login.js
// Autenticação e sessão do jogador: valida nome/senha contra banco.json (o
// "banco de verdade" vem depois) e emite um token opaco guardado em memória.
// Não sabe nada sobre socket.io — devolve só { token, player }; quem liga
// isso a uma conexão real é a camada de rede, numa etapa futura.
//
// 📌 TODO(JWT): quando a conexão entre processos (servidor <-> outros
// serviços) já estiver estabelecida, trocar este token opaco por um JWT
// assinado (payload com id/nome, expiração, verificável sem precisar
// consultar o Map `sessoes` abaixo). Por enquanto, opaco em memória é
// suficiente: mais simples e revogável na hora, mas não sobrevive a um
// restart do processo.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Player } from '../game/Player.js';
import { CodigosErro } from './eventos.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CAMINHO_BANCO = path.join(__dirname, '..', 'banco.json');

export class ErroLogin extends Error {
    constructor(codigo, mensagem) {
        super(mensagem);
        this.name = 'ErroLogin';
        this.codigo = codigo;
    }
}

// token opaco -> Player autenticado. Só existe em memória: some se o
// processo reiniciar. Aceitável para este marco (sem persistência ainda).
const sessoes = new Map();

let proximoId = 1;

function carregarBanco() {
    const conteudo = readFileSync(CAMINHO_BANCO, 'utf-8');
    return JSON.parse(conteudo);
}

// Autentica nome/senha contra o banco.json. Sucesso: cria uma sessão nova
// (mesmo que o nome já tenha outra sessão ativa — uma sessão por login, não
// por nome) e devolve { token, player }. Falha: lança ErroLogin.
export function login(nome, senha) {
    const banco = carregarBanco();
    const registro = banco.find(usuario => usuario.nome === nome);

    if (!registro) {
        throw new ErroLogin(CodigosErro.USUARIO_NAO_ENCONTRADO, `Usuário "${nome}" não encontrado.`);
    }
    if (registro.senha !== senha) {
        throw new ErroLogin(CodigosErro.SENHA_INCORRETA, 'Senha incorreta.');
    }

    const player = new Player(registro.nome, registro.senha);
    player.id = proximoId++;

    const token = randomUUID();
    sessoes.set(token, player);

    return { token, player };
}

// Devolve o Player dono do token, ou null se o token não existe (nunca
// logou, ou a sessão em memória se perdeu num restart do processo).
export function validarToken(token) {
    return sessoes.get(token) ?? null;
}


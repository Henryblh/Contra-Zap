// login.js
// Autenticação e sessão do jogador: valida nome/senha contra o banco SQLite
// (conexao/db.js) e emite um token opaco guardado em memória.
// Não sabe nada sobre socket.io — devolve só { token, player }; quem liga
// isso a uma conexão real é a camada de rede.
//
// 📌 TODO(JWT): quando a conexão entre processos (servidor <-> outros
// serviços) já estiver estabelecida, trocar este token opaco por um JWT
// assinado (payload com id/nome, expiração, verificável sem precisar
// consultar o Map `sessoes` abaixo). Por enquanto, opaco em memória é
// suficiente: mais simples e revogável na hora, mas não sobrevive a um
// restart do processo.
import { randomUUID } from 'node:crypto';
import { Player } from '../game/Player.js';
import { CodigosErro } from './eventos.js';
import { buscarUsuarioPorNome, verificarSenha } from './db.js';

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

// Autentica nome/senha contra o banco. Sucesso: cria uma sessão nova (mesmo
// que o nome já tenha outra sessão ativa — uma sessão por login, não por
// nome) e devolve { token, player }. Falha: lança ErroLogin.
//
// O id do player vem da linha do usuário no banco, então é o mesmo em todo
// login daquela conta (diferente do token, que é novo a cada vez).
export function login(nome, senha) {
    const usuario = buscarUsuarioPorNome(nome);

    if (!usuario) {
        throw new ErroLogin(CodigosErro.USUARIO_NAO_ENCONTRADO, `Usuário "${nome}" não encontrado.`);
    }
    if (!verificarSenha(senha, usuario.senha_hash)) {
        throw new ErroLogin(CodigosErro.SENHA_INCORRETA, 'Senha incorreta.');
    }

    const player = new Player(usuario.nome, null);
    player.id = usuario.id;

    const token = randomUUID();
    sessoes.set(token, player);

    return { token, player };
}

// Devolve o Player dono do token, ou null se o token não existe (nunca
// logou, ou a sessão em memória se perdeu num restart do processo).
export function validarToken(token) {
    return sessoes.get(token) ?? null;
}

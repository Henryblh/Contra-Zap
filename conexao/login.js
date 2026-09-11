// login.js
// Autenticação e sessão do jogador: valida nome/senha contra o banco SQLite
// (conexao/db.js) e emite um token de sessão assinado (conexao/jwt.js).
// Não sabe nada sobre socket.io — devolve só { token, player }; quem liga
// isso a uma conexão real é a camada de rede.
import { Player } from '../game/Player.js';
import { CodigosErro } from './eventos.js';
import { buscarUsuarioPorNome, verificarSenha, HASH_DUMMY } from './db.js';
import { emitirToken, verificarToken } from './jwt.js';

export class ErroLogin extends Error {
    constructor(codigo, mensagem) {
        super(mensagem);
        this.name = 'ErroLogin';
        this.codigo = codigo;
    }
}

// Autentica nome/senha contra o banco e devolve { token, player }.
// Falha: lança ErroLogin (ou devolve uma Promise rejeitada com ele, já que a
// função é assíncrona — ver comentário abaixo).
//
// O id do player vem da linha do usuário no banco, então é o mesmo em todo
// login daquela conta (diferente do token, que é novo a cada vez — ver
// jwtid em conexao/jwt.js).
//
// ASSÍNCRONA desde o item 4 do backlog de segurança: `verificarSenha`
// (conexao/db.js) agora usa a API assíncrona do bcrypt nativo, que despacha
// o hash pro threadpool do libuv em vez de travar a thread principal por
// ~60-70ms a cada tentativa — sem isso, um login (de qualquer um, malicioso
// ou não) pausava toda partida em andamento no servidor por esse tempo.
// login() só precisou de um `await` a mais pra propagar isso; quem chama
// (socketServer.js) já lida com Promise desde então.
export async function login(nome, senha) {
    const usuario = buscarUsuarioPorNome(nome);

    // Sempre paga o mesmo custo de bcrypt, exista o usuário ou não — só
    // TROCA o hash comparado (o de verdade, ou o HASH_DUMMY de db.js), nunca
    // pula a comparação. É o que fecha o timing oracle: antes disso,
    // "usuário não encontrado" respondia na hora (só o SELECT) e "senha
    // incorreta" só depois do bcrypt (~70ms) — dava pra descobrir quais
    // nomes têm conta só medindo o tempo de resposta do `entrar`, sem
    // precisar nem de `verificarNome` (ver DEV.md, item 3). A ORDEM dos
    // throws abaixo ainda depende de `usuario` (o código de erro tem que
    // continuar certo) — só o TEMPO até chegar aqui que não depende mais.
    //
    // bcrypt lança (aqui, rejeita a Promise) se `senha` não for string
    // (payload malformado, ex.: {nome} sem senha) — antes da correção do
    // item 3 isso só acontecia quando o usuário existia; como os dois ramos
    // agora chamam bcrypt sempre, os dois precisam do mesmo `?? ''` pra
    // continuar devolvendo um ErroLogin normal em vez de um throw cru (que o
    // responder() de socketServer.js até captura, mas vira ERRO_INTERNO em
    // vez do código certo).
    const senhaConfere = await verificarSenha(typeof senha === 'string' ? senha : '', usuario ? usuario.senha_hash : HASH_DUMMY);

    if (!usuario) {
        throw new ErroLogin(CodigosErro.USUARIO_NAO_ENCONTRADO, `Usuário "${nome}" não encontrado.`);
    }
    if (!senhaConfere) {
        throw new ErroLogin(CodigosErro.SENHA_INCORRETA, 'Senha incorreta.');
    }

    const player = new Player(usuario.nome, null);
    player.id = usuario.id;

    const token = emitirToken(player);

    return { token, player };
}

// Devolve um Player reconstruído a partir dos dados do token, ou null se o
// token for inválido, tiver sido adulterado ou expirado. Diferente do
// player devolvido por login(), este é sempre uma instância nova — não há
// mais sessão em memória guardando identidade de objeto, então a
// comparação que importa é por id/nome, não por referência.
export function validarToken(token) {
    const dados = verificarToken(token);
    if (!dados) return null;

    const player = new Player(dados.nome, null);
    player.id = dados.id;
    return player;
}

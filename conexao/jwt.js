// jwt.js
// Emissão e verificação do token de sessão (JWT assinado, HS256).
// Payload carrega só { id, nome } — nunca senha ou hash. Verificar um token
// é pura matemática sobre a assinatura: não existe Map em memória nem
// consulta a banco, então sobrevive a restart do processo.
//
// Segredo: usa JWT_SECRET do ambiente se existir; senão gera um e guarda em
// jwt.secret (raiz do projeto, fora do git — ver .gitignore) na primeira
// execução, e reusa depois. Isso mantém "roda sem configurar nada" (mesmo
// espírito do banco.sqlite se auto-semeando) sem exigir segredo hardcoded
// no código.
import jwt from 'jsonwebtoken';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CAMINHO_SEGREDO = path.join(__dirname, '..', 'jwt.secret');

const EXPIRACAO = '6h';

function obterSegredo() {
    if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
    if (existsSync(CAMINHO_SEGREDO)) return readFileSync(CAMINHO_SEGREDO, 'utf-8').trim();

    const gerado = randomBytes(32).toString('hex');
    writeFileSync(CAMINHO_SEGREDO, gerado, 'utf-8');
    return gerado;
}

const SEGREDO = obterSegredo();

// jwtid (jti) garante token diferente a cada emissão mesmo pro mesmo
// jogador dentro do mesmo segundo — sem isso, dois logins no mesmo segundo
// gerariam o *mesmo* JWT byte a byte (assinatura HMAC é determinística
// pra um payload+iat iguais).
export function emitirToken(player) {
    return jwt.sign({ id: player.id, nome: player.nome }, SEGREDO, {
        expiresIn: EXPIRACAO,
        jwtid: randomUUID(),
    });
}

// Devolve { id, nome } do token, ou null se a assinatura não bater, o token
// tiver expirado, ou vier malformado. Nunca lança.
export function verificarToken(token) {
    try {
        const { id, nome } = jwt.verify(token, SEGREDO);
        return { id, nome };
    } catch {
        return null;
    }
}

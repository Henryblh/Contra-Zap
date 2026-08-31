import express from 'express';
import { createServer } from 'node:http';
import { Server } from 'socket.io';
import path from 'path';
import { fileURLToPath } from 'url';
import { registrarSocketServer } from './conexao/socketServer.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const server = createServer(app);
// pingInterval + pingTimeout = pior caso pra perceber uma queda de conexão
// (aba fechada, rede caiu sem aviso, cabo puxado) — default do socket.io é
// 25s + 20s = 45s. Encolhido pra ~25s (10s + 15s): perceptível rápido o
// bastante pro jogador ver o aviso de conexão perdida (ver public/app/src/socket.js)
// sem exagerar na frequência de ping (ainda troca só um pacote a cada 10s
// por conexão ociosa).
const io = new Server(server, {
    pingInterval: 10_000,
    pingTimeout: 15_000,
});

registrarSocketServer(io);

// Serve o build da interface React (gerado por `npm run build` dentro de
// public/app — ver public/app/vite.config.js, que manda a saída pra cá).
// Se essa pasta não existir ainda, rode o build primeiro; ver README.md.
app.use(express.static('public/dist'));

app.get('/', (req, res) => {
    res.sendFile(__dirname + '/public/dist/index.html');
});

server.listen(3000, () => {
    console.log('Servidor rodando em http://localhost:3000');
});
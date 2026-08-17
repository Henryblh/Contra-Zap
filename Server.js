import express from 'express';
import { createServer } from 'node:http';
import { Server } from 'socket.io';
import path from 'path';
import { fileURLToPath } from 'url';
import { registrarSocketServer } from './conexao/socketServer.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const server = createServer(app);
const io = new Server(server);

registrarSocketServer(io);

// A MÁGICA ESTÁ AQUI:
// Isso faz com que o Express sirva automaticamente o CSS e o JS da pasta public
app.use(express.static('public'));

app.get('/', (req, res) => {
    res.sendFile(__dirname + '/public/index.html');
});

server.listen(3000, () => {
    console.log('Servidor rodando em http://localhost:3000');
});
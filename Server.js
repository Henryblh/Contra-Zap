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
// GameStart.js
// Sobe o sistema inteiro de uma vez só, pra quem não quer rodar os passos
// manuais um por um: instala dependências (raiz e front-end), builda o
// front-end e sobe o Server.js. Equivalente a rodar, na ordem:
//   npm install
//   cd public/app && npm install && npm run build
//   npm start
import { spawnSync, spawn } from 'node:child_process';

// No Windows o executável de verdade é `npm.cmd`, não `npm` — `shell: true`
// resolve isso (e o resto do PATH) sem precisar diferenciar por SO.
function rodar(comando, args, cwd) {
    console.log(`\n> ${comando} ${args.join(' ')}${cwd ? ` (em ${cwd})` : ''}`);
    const resultado = spawnSync(comando, args, { cwd, stdio: 'inherit', shell: true });
    if (resultado.status !== 0) {
        console.error(`\nFalhou: "${comando} ${args.join(' ')}" terminou com código ${resultado.status}.`);
        process.exit(resultado.status ?? 1);
    }
}

rodar('npm', ['install']);
rodar('npm', ['install'], 'public/app');
rodar('npm', ['run', 'build'], 'public/app');

console.log('\nTudo pronto — subindo o servidor em http://localhost:3000 (Ctrl+C para parar)...\n');
const servidor = spawn('node', ['Server.js'], { stdio: 'inherit', shell: true });
servidor.on('exit', (codigo) => process.exit(codigo ?? 0));

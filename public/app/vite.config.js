import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  build: {
    // Sai de public/app/dist (padrão do Vite) pra public/dist — é o que o
    // Server.js serve como estático. `npm run build` aqui dentro é o fluxo
    // principal; `npm run dev` (porta 5173) também funciona, proxiando
    // socket.io pro servidor de verdade rodando em :3000 (`npm start` na raiz).
    outDir: '../dist',
    emptyOutDir: true,
  },
  server: {
    // Partida.jsx importa conexao/chat/mensagensChat.js (fonte única do
    // catálogo de chat, fora da raiz public/app) — libera o acesso do dev
    // server a esse arquivo. O build (Rollup) não depende disto.
    fs: {
      allow: ['..', '../..'],
    },
    proxy: {
      '/socket.io': {
        target: 'http://localhost:3000',
        ws: true,
      },
    },
  },
})

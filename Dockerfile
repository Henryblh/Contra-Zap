# ---------- Stage 1: build do frontend (React + Vite) ----------
FROM node:22-alpine AS frontend-builder
WORKDIR /app/public/app
COPY public/app/package.json public/app/package-lock.json ./
RUN npm ci
COPY public/app/. .
RUN npm run build
# Saída vai pra /app/public/dist (configurado em public/app/vite.config.js)

# ---------- Stage 2: instala dependências do backend ----------
FROM node:22-alpine AS backend-deps
WORKDIR /app
# better-sqlite3 precisa compilar um addon nativo — o prebuild pronto não
# bate com essa combinação exata (Alpine/musl + arm64 + Node 22).
RUN apk add --no-cache python3 make g++
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ---------- Stage 3: imagem final, enxuta ----------
FROM node:22-alpine
WORKDIR /app

# Copia só o node_modules já compilado — NÃO leva python3/make/g++ pra
# imagem final (essas ferramentas só existiam pra compilar, não pra rodar).
COPY --from=backend-deps /app/node_modules ./node_modules

# Código do backend (lista explícita, não "COPY . ." — evita levar
# public/app/node_modules, training/, ou outro lixo de dev pra imagem final)
COPY package.json Server.js GameStart.js index.js banco.json ./
COPY conexao ./conexao
COPY game ./game
COPY bots ./bots

# Build do frontend gerado no stage 1 (sempre fresco, nunca uma cópia
# antiga que porventura exista na sua máquina local)
COPY --from=frontend-builder /app/public/dist ./public/dist

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/health || exit 1

CMD ["node", "Server.js"]
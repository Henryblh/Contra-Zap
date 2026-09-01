FROM node:22-alpine

WORKDIR /app

# O prebuild pronto do better-sqlite3 não bateu certinho com essa
# combinação exata (Node 22 + musl + arm64), então ele cai pra compilar
# do zero — por isso precisamos das ferramentas de build mesmo no Alpine.
RUN apk add --no-cache python3 make g++

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

RUN find node_modules/better-sqlite3 -name "*.node"

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

CMD ["node", "Server.js"]
# ─── Agent vocal IA — image Docker ────────────────────────────────────────────
FROM node:20-alpine

WORKDIR /app

# Dépendances système minimales
RUN apk add --no-cache tini

# Installation des dépendances Node (cache-friendly)
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund || npm install --omit=dev --no-audit --no-fund

# Code applicatif
COPY src/ ./src/
COPY public/ ./public/
COPY salons/*.json ./salons/
COPY docs/ ./docs/

# Répertoires de données (tokens Google, historique d'appels)
RUN mkdir -p data salons

ENV NODE_ENV=production
EXPOSE 3000

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "src/index.js"]

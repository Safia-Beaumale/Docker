# --- Build : compilation TypeScript + génération de la table d'emoji ---
FROM node:24-alpine AS builder

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY tsconfig.json ./
COPY scripts ./scripts
COPY src ./src
RUN npm run build \
  && npm prune --omit=dev

# --- Image finale : uniquement le JS compilé et les dépendances de production ---
FROM node:24-alpine

ENV NODE_ENV=production
WORKDIR /app

COPY --from=builder /app/package.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist

# Correspondance des IDs de messages (volume), propriété de l'utilisateur non-root
RUN mkdir /data && chown node:node /data

USER node

EXPOSE 8080

HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/health || exit 1

CMD ["node", "dist/index.js"]

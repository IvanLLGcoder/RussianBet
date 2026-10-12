# Image de production de « DUyka PARIS » (gamble.dyuka.com) — derrière Nginx Proxy Manager.
# Debian slim (glibc) plutôt qu'Alpine : better-sqlite3 dispose d'un binaire précompilé,
# donc aucun outil de compilation n'est nécessaire.

# ---- Étape 1 : construction (dépendances complètes + build Vite) ----
FROM node:22-bookworm-slim AS construction
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
# « tsc -b && vite build » produit dist/ ; on retire ensuite les dépendances de développement
# (le binaire natif de better-sqlite3 reste dans node_modules).
RUN npm run build && npm prune --omit=dev

# ---- Étape 2 : image d'exécution ----
FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    PORT=3001 \
    DB_PATH=/donnees/oddsroom.sqlite
WORKDIR /app
# Le serveur sert dist/ et lit brand.config.json à la racine de l'application.
COPY --from=construction --chown=node:node /app/package.json ./package.json
COPY --from=construction --chown=node:node /app/node_modules ./node_modules
COPY --from=construction --chown=node:node /app/dist ./dist
COPY --from=construction --chown=node:node /app/server ./server
COPY --from=construction --chown=node:node /app/scripts ./scripts
COPY --from=construction --chown=node:node /app/brand.config.json ./brand.config.json
# L'utilisateur « node » de l'image officielle a l'uid 1000 (comme evg sur le serveur).
RUN mkdir -p /donnees && chown node:node /donnees
USER node
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3001/api/me').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node","server/index.js"]

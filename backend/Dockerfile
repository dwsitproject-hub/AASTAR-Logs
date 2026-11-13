# Astar ERP backend (Express + SQLite mirrors; PostgreSQL migrations).
# Build context: backend/.  Local stack: see docker-compose.yml at the repo root.

FROM node:22-bookworm-slim AS deps
WORKDIR /app
# Toolchain only for native modules (better-sqlite3) when no prebuilt binary matches.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:22-bookworm-slim
WORKDIR /app
ENV PORT=3001 \
    HOST=0.0.0.0 \
    DB_PATH=/app/data/erp.db \
    SERVICE_ACCOUNTS_DIR=/app/service-accounts
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN mkdir -p /app/data /app/service-accounts && chown -R node:node /app/data
USER node
EXPOSE 3001
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]

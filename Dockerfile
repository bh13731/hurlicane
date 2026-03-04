# Stage 1 — Build
FROM node:22-bookworm AS build

WORKDIR /app

# Install build tools for native modules (node-pty)
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

# Install dependencies
COPY package.json package-lock.json ./
RUN npm ci

# Copy source and build
COPY tsconfig.json tsconfig.server.json vite.config.ts ./
COPY src/ src/
RUN npm run build

# Stage 2 — Runtime
FROM node:22-bookworm-slim

WORKDIR /app

# Install runtime system dependencies
RUN apt-get update && \
    apt-get install -y --no-install-recommends tmux git python3 curl && \
    rm -rf /var/lib/apt/lists/*

# Install Claude Code CLI
RUN npm install -g @anthropic-ai/claude-code

# Copy build output, dependencies, and supporting files
COPY --from=build /app/dist/ dist/
COPY --from=build /app/node_modules/ node_modules/
COPY package.json ./
COPY scripts/ scripts/

# Create data directory for SQLite DB, logs, repos
RUN mkdir -p data

ENV NODE_OPTIONS=--experimental-sqlite
ENV PORT=3000
ENV MCP_PORT=3001
ENV DB_PATH=./data/orchestrator.db

EXPOSE 3000 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD curl -f http://localhost:3000/ || exit 1

CMD ["node", "dist/server/index.js"]

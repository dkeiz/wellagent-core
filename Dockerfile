FROM node:20-slim

# better-sqlite3 native module needs a compiler toolchain.
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install (including dev tools for the TypeScript build) in one layer.
COPY package.json package-lock.json* ./
RUN npm install

# Compile the runtime.
COPY tsconfig.json ./
COPY scripts ./scripts
COPY src ./src
COPY shared ./shared
RUN npm run build && npm prune --omit=dev

# Agent content and runtime directories.
COPY agentin ./agentin
RUN mkdir -p \
    data \
    agentin/workspaces \
    agentin/memory/daily \
    agentin/memory/global \
    agentin/memory/images \
    agentin/memory/tasks \
    agentin/subtasks/runs \
    agentin/research/runs \
    agentin/workflows/runs \
    agentin/knowledge/staging

EXPOSE 8788

HEALTHCHECK --interval=30s --timeout=10s --retries=3 \
    CMD node -e "const http=require('http');http.get('http://localhost:8788/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

# Headless agent + HTTP control API (equivalent to the monorepo -nogui mode).
CMD ["node", "dist/src/main/cli.js", "--host", "0.0.0.0", "--port", "8788"]

# syntax=docker/dockerfile:1
#
# Agent Family: one image with the service and the web client it serves (same origin).
# Build context: the REPOSITORY ROOT (the paths below are relative to it):
#   docker build -f app/deploy/Dockerfile -t agent-family .
# What enters the context is decided by app/deploy/Dockerfile.dockerignore (a whitelist).

# --- 1. the web client: app/web -> static files ------------------------------------------
FROM node:24-slim AS web
WORKDIR /build/app/web
COPY app/web/package.json app/web/package-lock.json ./
RUN npm ci
COPY app/web/ ./
RUN npm run build

# --- 2. the service: app/service (TypeScript) -> dist/ ------------------------------------
FROM node:24-slim AS service
WORKDIR /build/app/service
COPY app/service/package.json app/service/package-lock.json ./
RUN npm ci
COPY app/service/tsconfig.json app/service/tsconfig.build.json ./
COPY app/service/src ./src
RUN npm run build

# --- 3. what runs: production dependencies, the build, migrations, the web files ---------
FROM node:24-slim
ENV NODE_ENV=production \
    PORT=3000 \
    WEB_DIST=/app/web \
    BLOB_DIR=/data/blobs
WORKDIR /app/service
COPY app/service/package.json app/service/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=service /build/app/service/dist ./dist
COPY app/service/migrations ./migrations
COPY --from=web /build/app/web/dist /app/web
# The unprivileged user ships with the official Node image. Local blob storage (when S3_* is not set)
# lives in /data/blobs: mount a volume there, or use S3.
RUN mkdir -p /data/blobs && chown -R node:node /data
USER node
EXPOSE 3000
# Node has fetch; the slim image has no curl. PORT is read at run time, so a changed PORT is honoured.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
# Migrations first (idempotent), then the server. `exec` makes node PID 1's replacement, so SIGTERM reaches it.
CMD ["sh", "-c", "node --enable-source-maps dist/cli.js migrate && exec node --enable-source-maps dist/server.js"]

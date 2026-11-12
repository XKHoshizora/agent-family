FROM node:24-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build && node --check dist-server/index.js && npm prune --omit=dev

FROM node:24-bookworm-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends gosu ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/dist-server ./dist-server
COPY --from=build /app/package.json ./package.json
COPY scripts/container-entrypoint.sh /usr/local/bin/agent-family-entrypoint
RUN chmod 755 /usr/local/bin/agent-family-entrypoint && mkdir /app/.local && chown node:node /app/.local && chmod 700 /app/.local
ENV NODE_ENV=production HOST=0.0.0.0 PORT=4317 DATA_DIR=/data
EXPOSE 4317
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["agent-family-entrypoint"]
CMD ["node","dist-server/index.js"]

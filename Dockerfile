FROM node:24-bookworm-slim AS base

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /app

FROM base AS dependencies
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json ./
COPY apps/server/package.json ./apps/server/package.json
COPY apps/web/package.json ./apps/web/package.json
RUN pnpm install --frozen-lockfile

FROM dependencies AS build
COPY apps/server ./apps/server
COPY apps/web ./apps/web
RUN pnpm build

FROM node:24-bookworm-slim AS runtime
RUN apt-get update \
  && apt-get install -y --no-install-recommends postgresql-client \
  && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
WORKDIR /app/apps/server
COPY --from=build /app/node_modules /app/node_modules
COPY --from=build /app/apps/server/node_modules ./node_modules
COPY --from=build /app/apps/server/dist ./dist
COPY --from=build /app/apps/server/package.json ./package.json
COPY --from=build /app/apps/server/drizzle ./drizzle
COPY --from=build /app/apps/web/out /app/apps/web/out
RUN mkdir -p /var/lib/note-gen-server/blobs /var/lib/note-gen-server/backups \
  && chown -R node:node /app /var/lib/note-gen-server
USER node
EXPOSE 3789
VOLUME ["/var/lib/note-gen-server/blobs", "/var/lib/note-gen-server/backups"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3789/health/ready').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
CMD ["node", "dist/entrypoint.js"]

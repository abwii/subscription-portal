# Contexte de build : la racine du monorepo (voir docker-compose.yml).
FROM node:22-alpine AS base
RUN corepack enable
WORKDIR /repo

FROM base AS build
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/config/package.json packages/config/
COPY packages/ui/package.json packages/ui/
COPY apps/web/package.json apps/web/
RUN --mount=type=cache,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --filter @monrepo/web...
COPY packages/config packages/config
COPY packages/ui packages/ui
COPY apps/web apps/web
RUN pnpm --filter @monrepo/web build

FROM node:22-alpine AS runtime
ENV NODE_ENV=production HOSTNAME=0.0.0.0 PORT=3000
WORKDIR /app
# Sortie "standalone" : serveur minimal + node_modules tracés, chemins relatifs à la racine du repo.
COPY --from=build --chown=node:node /repo/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /repo/apps/web/.next/static ./apps/web/.next/static
USER node
EXPOSE 3000
CMD ["node", "apps/web/server.js"]

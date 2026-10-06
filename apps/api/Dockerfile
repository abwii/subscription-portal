# Contexte de build : la racine du monorepo (voir docker-compose.yml).
FROM node:22-alpine AS base
RUN corepack enable
WORKDIR /repo

FROM base AS build
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/config/package.json packages/config/
COPY apps/api/package.json apps/api/
RUN --mount=type=cache,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --filter @subscription-portal/api...
COPY packages/config packages/config
COPY apps/api apps/api
RUN pnpm --filter @subscription-portal/api build \
 && pnpm --filter @subscription-portal/api deploy --legacy --prod /out \
 && cp -r apps/api/dist /out/dist

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /out/package.json ./
COPY --from=build --chown=node:node /out/node_modules ./node_modules
COPY --from=build --chown=node:node /out/dist ./dist
USER node
EXPOSE 3001
CMD ["node", "dist/server.js"]

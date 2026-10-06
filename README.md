# subscription-portal

[![CI](https://github.com/abwii/subscription-portal/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/abwii/subscription-portal/actions/workflows/ci.yml)

Monorepo pnpm + Turborepo : front Next.js, API Fastify, Postgres.

```
apps/web          Next.js (App Router) — UI, consomme @subscription-portal/ui
apps/api          Fastify + Postgres (pg) — /health, /ready
packages/ui       Composants React présentationnels
packages/config   tsconfig + ESLint partagés (aucun code runtime)
```

## Démarrage

```bash
cp .env.example .env        # puis ajustez les valeurs
pnpm install
pnpm test                   # vitest dans chaque package, orchestré par Turbo
docker compose up --build   # db + api (:3001) + web (:3000)
```

Endpoints : `GET /health` (liveness, web et api) · `GET /ready` (readiness, api : vérifie Postgres).

## Frontières entre packages

```
apps/web ──▶ packages/ui
apps/web, apps/api, packages/ui ──▶ packages/config   (devDependency uniquement)
apps/api ──✗ packages/ui, apps/web
```

| Package | Rôle | Peut dépendre de | Ne doit jamais |
|---|---|---|---|
| `config` | Règles TS/ESLint | rien | contenir du code runtime |
| `ui` | Composants React purs | `react` (peer) | importer une app, appeler l'API, lire `process.env` |
| `api` | Logique serveur, accès DB | `fastify`, `pg` | importer du React ou `ui` |
| `web` | Pages, routing, data fetching | `ui` | accéder à Postgres directement |

- **Règle d'or** : les dépendances vont des apps vers les packages, jamais l'inverse ; les apps ne s'importent pas entre elles.
- Appliquée par la structure : avec le `node_modules` strict de pnpm, une dépendance non déclarée dans le `package.json` ne se résout pas.
- `ui` est publié en **TypeScript source** (pas de build) ; Next le compile via `transpilePackages`. Moins de config, mais `ui` ne sert que des consommateurs TS.
- Si un contrat web ↔ api (types partagés) apparaît, il ira dans un nouveau package `packages/contracts` (types/schémas uniquement), pas dans `ui`.

## Choix notables

- **TypeScript 6.0** (pas 7) et **ESLint 9** (pas 10) : `typescript-eslint` et `eslint-plugin-react` ne les supportent pas encore.
- **`/health` ≠ `/ready`** : la liveness ne touche pas la DB, sinon une panne Postgres redémarrerait l'API en boucle.
- L'API reçoit sa DB par injection (`Database.ping()`), donc les tests tournent sans Postgres.

## Déploiement

Mode d'emploi du template : [docs/USAGE.md](docs/USAGE.md).
Staging automatique sur `main`, production sur tag `vX.Y.Z` avec reviewer requis, rollback par tag
(Fly.io, images GHCR). Procédure complète : [docs/DEPLOY.md](docs/DEPLOY.md).

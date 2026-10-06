@AGENTS.md

# CLAUDE.md

Monorepo pnpm + Turborepo : front Next.js, API Fastify + Postgres, déployé sur Fly.io.
Mode d'emploi du template : `docs/USAGE.md`. Infra et déploiement : `docs/DEPLOY.md`.

## Structure et frontières

```
apps/web          Next.js (App Router) : pages, routing, appels à l'API. Dépend de @subscription-portal/ui.
apps/api          Fastify + pg : logique serveur, accès base. Ne dépend ni de ui ni de web.
packages/ui       Composants React présentationnels. Aucune dépendance vers une app.
packages/config   tsconfig + ESLint partagés. Aucun code runtime.
```

Les dépendances vont des apps vers les packages, jamais l'inverse ; les apps ne s'importent pas entre elles.
`web` n'accède jamais à Postgres directement. `ui` ne lit pas `process.env` et n'appelle pas l'API.

## Commandes

```bash
pnpm install                              # dépendances (lockfile figé en CI)
pnpm turbo run lint typecheck test build  # tout vérifier, comme la CI (cache Turbo)
pnpm --filter @subscription-portal/api test           # tests d'un seul package
pnpm --filter @subscription-portal/web typecheck
docker compose up --build                 # stack complète (copier .env.example en .env)
```

`pnpm dev` ne charge pas `.env` : exporter `DATABASE_URL` dans le terminal, ou passer par compose.

## Conventions

- **TypeScript strict** (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`) :
  pas de `any`, `import type` pour les types. ESLint `strictTypeChecked` ; erreurs de lint = bloquant.
- **Tests d'abord** : écrire le test, le voir échouer, puis implémenter. Vitest, fichiers `*.test.ts(x)` à côté du code.
- **API** : imports relatifs avec extension `.js` (NodeNext). La config se lit uniquement dans `src/config.ts`
  (`loadConfig`), jamais `process.env` ailleurs. La base est injectée (`Database`), pas importée en dur.
- **Commits conventionnels**, petits et ciblés : `feat(api): …`, `fix(web): …`, `docs: …`, `ci: …`, `chore(deps): …`.
- **Aucun secret** dans le code, les tests, les logs, les fixtures ni les captures. Les valeurs vivent dans les
  environnements GitHub et les secrets Fly. `.env.example` ne contient que des valeurs locales factices.
- Petites étapes ; en cas d'ambiguïté, poser la question plutôt que supposer.

## Définition de « fini »

Une tâche est terminée seulement si :

1. Les tests couvrant le changement existent, ont été vus échouer avant, et passent.
2. `pnpm turbo run lint typecheck test build` est vert, et le résultat est rapporté tel quel (échec compris).
3. La documentation est à jour si le comportement, la config ou le déploiement change.
4. Le diff ne contient aucun secret ni fichier généré (`.next`, `dist`, `.env`).
5. La PR remplit son template, avec l'impact sur le déploiement (variables, migrations, rollback).

## Périmètre : ce qu'on ne fait pas sans demande explicite

- Pousser sur `main` (protégé : tout passe par une PR dont la CI est verte).
- Créer ou déplacer un tag `v*`, lancer une release, un rollback ou un déploiement.
- Modifier `.github/workflows/**`, les rulesets, les environnements GitHub, les secrets ou la config Fly.
- Mettre à jour en majeur TypeScript, ESLint, Node ou Postgres (voir ci-dessous).

## Pièges connus

- **TypeScript 6.0 et ESLint 9** sont volontaires : `typescript-eslint` et `eslint-plugin-react` ne supportent pas
  encore TS 7 / ESLint 10. Dependabot ignore ces majeures.
- `packages/ui` est publié en TypeScript source : `apps/web` le compile via `transpilePackages`. Ne pas ajouter d'étape de build.
- `/health` (liveness) ne touche pas la base ; `/ready` (readiness) la vérifie. Ne pas fusionner les deux.
- Le tag de rollback accepte `vX.Y.Z` ou `sha-` + 7 caractères, pas un SHA complet.
- Un secret d'environnement n'est pas visible d'un workflow réutilisable : le déploiement est une action composite.

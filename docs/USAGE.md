# Utiliser ce template

Monorepo pnpm + Turborepo prêt pour la production : Next.js, Fastify, Postgres, CI GitHub Actions,
déploiement Fly.io (staging automatique, production sur tag avec reviewer, rollback).
Détail de l'infra : [DEPLOY.md](DEPLOY.md).

## 1. Démarrer un projet

GitHub : **Use this template → Create a new repository** (« Include all branches » décoché).

```bash
git clone https://github.com/<owner>/<projet>.git && cd <projet>
cp .env.example .env
pnpm install
```

Un dépôt créé depuis un template **ne reçoit pas** les environnements, secrets, apps Fly ni rulesets.
Le premier push sur `main` fera échouer `deploy-staging` avec un message clair tant que ce n'est pas fait.

### Checklist de mise en place

- [ ] Renommer le scope `@subscription-portal/*` et le titre du README (optionnel)
- [ ] Fly : 4 apps, 4 tokens de déploiement, `DATABASE_URL` par app api (→ [DEPLOY.md](DEPLOY.md) §1-2)
- [ ] Neon (ou autre) : une base par environnement ; hôte **complet**, sans `-pooler`, `sslmode=verify-full`
- [ ] GitHub, environnements `staging` et `production` (→ [DEPLOY.md](DEPLOY.md) §4) :
      2 secrets `FLY_API_TOKEN_API` / `FLY_API_TOKEN_WEB`, 4 variables `FLY_APP_API`, `FLY_APP_WEB`,
      `API_URL`, `WEB_URL` (sans slash final)
- [ ] `production` : reviewer requis, administrateurs sans contournement, déploiement limité à `main` et au tag `v*`
- [ ] Rulesets (Settings → Rules) :
  - `main`, **Active**, cible la branche par défaut : *Restrict deletions*, *Block force pushes*,
    *Require a pull request* (0 approbation si vous êtes seul), *Require status checks*
    (`Lint, typecheck, test, build`, `Smoke test (docker compose)`, `Image api`, `Image web`)
  - `release-tags`, **Active**, cible le motif `v*` : *Restrict deletions*, *Block force pushes*
- [ ] Après le 1er run sur `main` : paquets GHCR `<repo>-api` et `<repo>-web` en **Public**, puis *Re-run failed jobs*
- [ ] Automatisation du dépôt (voir §6) : alertes Dependabot, CodeQL, app Claude + secret `CLAUDE_CODE_OAUTH_TOKEN`
- [ ] Vérifier `/health` et `/ready` sur staging, puis tag `v0.1.0` pour la production

## 2. Développer

```bash
git checkout main && git pull
git checkout -b feat/ma-fonctionnalite
```

- Tests d'abord (Vitest), commits conventionnels (`feat(api): …`, `fix(web): …`, `docs: …`).
- Avant de pousser : `pnpm turbo run lint typecheck test build` (le 2ᵉ run est servi par le cache Turbo).
- Stack complète avec Postgres : `docker compose up --build`. Les `pnpm dev` des apps ne chargent pas
  `.env` : exportez `DATABASE_URL` dans le terminal ou passez par compose.
- Base locale (API) : `DATABASE_URL` exporté, puis `pnpm --filter @subscription-portal/api db:migrate`
  (applique `apps/api/migrations/*.sql`) et `db:seed` (plans, droits et compte de démo, local uniquement).
  Pour appeler `GET /me/entitlements` en local : `DEV_AUTH=true` puis l'en-tête
  `X-Account-Id: 00000000-0000-4000-8000-000000000001`. `DEV_AUTH` est refusé si `NODE_ENV=production` ;
  sans lui, les routes authentifiées répondent 401 (fournisseur d'identité à choisir, voir ADR-001).
- L'API limite le débit par IP (100 requêtes/minute, hors `/health` et `/ready`). Derrière Fly, définir
  `TRUST_PROXY=true`, sinon tous les clients partagent l'IP du proxy.
- Checkout (`POST /subscriptions`, en-tête `Idempotency-Key` obligatoire, corps `{ "planPriceId": "<uuid>" }`) :
  sans fournisseur de paiement (`PAYMENT_PROVIDER=none`, défaut) l'API répond 503 ; en local, `PAYMENT_PROVIDER=fake`
  (refusé en production). Les abonnements `pending` non payés expirent après 24 h via
  `expirePendingSubscriptions` (`apps/api/src/subscriptions.ts`) : **cette fonction n'est pas encore planifiée**.
- Stripe : `PAYMENT_PROVIDER=stripe` exige `STRIPE_SECRET_KEY` et `STRIPE_WEBHOOK_SECRET` (secrets Fly en production,
  clés de test en local ; jamais dans le dépôt). Le webhook est `POST /webhooks/payments` (événements
  `payment_intent.succeeded` et `payment_intent.payment_failed` ; les autres sont acquittés et ignorés). En local :
  `stripe listen --forward-to localhost:3001/webhooks/payments` fournit le secret `whsec_…`. Avec `PAYMENT_PROVIDER=fake`,
  simuler un événement par `POST /webhooks/payments` avec l'en-tête `x-fake-signature: fake` et le corps
  `{ "id": "evt_1", "type": "payment.succeeded", "providerRef": "<providerRef du checkout>" }`.
- Upgrade : `POST /subscriptions/:id/change-plan` (`Idempotency-Key` obligatoire, corps `{ "planPriceId": "<uuid>" }`).
  Prorata au jour : crédit du temps non utilisé et débit du nouveau plan pour le temps restant (jour entamé = dû,
  arrondi au centime supérieur à la moitié, une fois par ligne). Une facture `open` est créée ; le plan ne change qu'au
  paiement (webhook), la fin de période reste inchangée sauf passage mensuel → annuel (nouvelle période annuelle, crédit
  déduit). Une seule demande ouverte par abonnement (409 sinon), fermée au bout de 24 h comme un checkout non payé.
  Un échec de paiement laisse l'abonnement et le plan intacts ; le client peut retenter avec le même PaymentIntent.
- Downgrade : le même `POST /subscriptions/:id/change-plan` vers un plan de rang inférieur (ou annuel → mensuel du même
  plan) ne facture rien et ne rembourse rien : il programme le changement (`pending_plan_price_id`, réponse
  `scheduledChange`) pour la fin de période ; les droits actuels restent. `DELETE /subscriptions/:id/scheduled-change`
  l'annule (204, idempotent) ; demander un upgrade l'annule aussi.
- Pause : `POST /subscriptions/:id/pause` avec `{ "resumeAt": "<date ISO>" }` (dans le futur, 90 jours maximum, une seule pause
  par période de 12 mois, abonnement `active` uniquement, aucune facture de renouvellement ou de changement impayée).
  La facturation et les droits sont suspendus ; la période en cours n'est ni remboursée ni reportée (ADR-001 : à la
  reprise une nouvelle période démarre). Chaque pause est journalisée dans `subscription_events` (append-only).
- Reprise : `POST /subscriptions/:id/resume` (abonnement `paused` uniquement, sinon 409) ou automatiquement quand `resume_at`
  est passé (`jobs:resume`). L'abonnement redevient `active` immédiatement, une nouvelle période démarre, une facture de reprise
  `open` est émise (au prix d'un downgrade programmé s'il existe) et son paiement créé. Si le paiement échoue (webhook),
  l'abonnement passe `past_due` ; s'il n'a pas pu être créé (502, avec `invoiceId`), `POST /invoices/:id/pay` le recrée.
  `POST /invoices/:id/pay` (facture `open` du compte) utilise une clé fournisseur stable par facture : des appels répétés
  rendent le même paiement pour les factures de renouvellement et de reprise.
- Annulation : `POST /subscriptions/:id/cancel`. Un abonnement `active` est annulé **en fin de période** (droits conservés
  jusqu'à `currentPeriodEnd`, aucun remboursement, plus de renouvellement) ; `paused` et `past_due` sont annulés
  immédiatement (factures ouvertes annulées) ; déjà annulé ou déjà programmé → 200 sans nouvel événement ; `pending` et
  `expired` → 409. `DELETE /subscriptions/:id/cancellation` révoque une annulation programmée tant que la période n'est pas
  terminée. À l'échéance, `jobs:close-ended` passe l'abonnement en `canceled` ; les droits, eux, s'arrêtent à
  `currentPeriodEnd` même si le job n'a pas encore tourné.
- Cadeaux : `POST /gifts` (`Idempotency-Key` obligatoire ; `{ "planPriceId", "durationPeriods": 1-12, "recipientEmail"? }`) crée un
  cadeau `awaiting_payment` et une facture `open` au nom de l'offrant (prix × durée). Le code (128 bits, base64url) n'est **jamais**
  renvoyé à l'achat : au paiement (webhook) le cadeau devient `pending`, valable 12 mois, et le destinataire est prévenu par
  e-mail si `MAILER` le permet ; l'offrant retrouve le code par `GET /gifts` tant que le cadeau est utilisable (jamais celui d'un
  autre compte). Un remboursement (`charge.refunded` Stripe, à activer dans le endpoint webhook) avant échange passe le cadeau `refunded` : son code est inutilisable.
  Un cadeau non payé est fermé au bout de 24 h (`jobs:expire-pending`, qui expire aussi les cadeaux périmés).
  `MAILER=console` (local, refusé en production) écrit les e-mails, **code compris**, sur la sortie standard ; par défaut
  (`none`) aucun e-mail n'est envoyé : aucun fournisseur d'e-mail n'est branché (port `Mailer`).
- Échange d'un cadeau : `POST /gifts/redeem` avec `{ "code": "…" }` (le code est dans le **corps**, jamais dans l'URL : les URL sont
  journalisées). Cadeau `pending` non périmé et compte sans abonnement vivant → abonnement `active` créé **sans paiement**, sur
  toute la durée offerte (une seule période longue) avec annulation programmée à son terme : jamais renouvelé, clos par
  `jobs:close-ended`, droits coupés à l'échéance même avant le job. Réponses : 404 code inconnu (ou cadeau non payé), 410 déjà
  échangé / périmé / remboursé, 409 abonnement vivant (le cadeau reste utilisable). Limite : 10 tentatives par minute et par client,
  tous résultats confondus. Un abonnement offert ne peut être ni mis en pause, ni changé de plan, ni « dé-annulé » (409
  `gifted_subscription`) ; il peut être annulé.
- Fidélité : `GET /me/loyalty` (XP, palier et distance au suivant). Chaque facture payée (cadeaux compris, pour l'offrant) rapporte
  **10 XP par euro entier payé** (19,99 € → 190 XP), une seule fois par facture ; un remboursement retire ces XP (écriture
  négative). Paliers (table `loyalty_tiers`, modifiable) : Bronze 0, Argent 500 (2 %), Or 2 000 (5 %), Platine 5 000 (10 %). Le
  palier monte dès que le total le permet et ne descend jamais dans les 12 mois suivant son obtention. Les factures de
  **renouvellement** portent une ligne `discount` selon le palier (arrondi à l'entier le plus proche, moitié vers le haut). Le
  journal `xp_ledger` est append-only ; `loyalty_accounts.xp_total` en est la projection (toujours égale à la somme du journal).
  Valeurs initiales proposées dans l'ADR, à confirmer.
- Jobs périodiques (à planifier hors de l'API : cron, machine planifiée Fly — **pas encore planifiés**) :
  `pnpm --filter @subscription-portal/api jobs:renew` (facture les renouvellements échus ; au paiement la période
  avance et le downgrade programmé s'applique ; un échec passe l'abonnement en `past_due`) et `jobs:expire-pending`
  (ferme les checkouts et changements non payés après 24 h) , `jobs:resume` (reprend les abonnements dont la date de reprise est passée) et `jobs:close-ended` (clôt les annulations programmées arrivées à terme). Tous sont rejouables. Limite : le paiement de
  renouvellement est créé comme un checkout ; un prélèvement automatique hors session exige un moyen de paiement
  enregistré (pas dans le modèle actuel).
- Factures : `GET /invoices` et `GET /invoices/:id` (authentifiées, limitées aux factures du compte). Une facture
  émise est immuable (trigger SQL) : seuls son statut et sa date de paiement changent.
- Tests d'intégration SQL (`*.pg.test.ts`) : exécutés par la CI (service Postgres) ; en local, ignorés sans `TEST_DATABASE_URL`. Pointer vers une base **jetable**
  (les tables sont vidées), p. ex. `docker run --rm -e POSTGRES_PASSWORD=local -e POSTGRES_DB=t -p 127.0.0.1:55432:5432 postgres:17-alpine`
  puis `TEST_DATABASE_URL=postgres://postgres:local@127.0.0.1:55432/t pnpm --filter @subscription-portal/api test`.
- `main` est protégé : tout passe par une PR dont la CI est verte.

## 3. Staging puis production

| Étape | Action | À vérifier |
|---|---|---|
| Staging | Merger la PR sur `main` : déploiement automatique | job `Deploy to staging` vert ; `/health` (web, api) et `/ready` (api) ; la fonctionnalité elle-même |
| Production | `git checkout main && git pull && git tag v0.2.0 && git push origin v0.2.0` | approuver le déploiement (Actions → *Review deployments*) ; `/health` et `/ready` en prod |

Une image est construite **une fois** sur `main` (`sha-xxxxxxx`) ; la release la retague en `vX.Y.Z`
sans la reconstruire. Le tag doit pointer un commit de `main` dont la CI est terminée.
Ne jamais réutiliser un tag (le ruleset l'interdit).

## 4. Rollback

Actions → **Rollback** → *Run workflow* : environnement + tag **`vX.Y.Z`** ou **`sha-` suivi de 7
caractères** (ex. `sha-2632072`). Un SHA complet de 40 caractères est refusé. Les tags disponibles sont
dans GitHub → Packages → `<repo>-api` → Tags. Même approbation de reviewer en production.
Limite : après une migration de schéma, une image plus ancienne peut ne plus être compatible.

## 5. Pièges déjà rencontrés

- Secrets d'environnement vides : ils ne sont pas visibles d'un workflow réutilisable (d'où l'action composite).
- `getaddrinfo ENOTFOUND` sur `/ready` : hôte de `DATABASE_URL` tronqué.
- Pull d'image refusé par Fly : paquet GHCR encore privé (renommer le dépôt crée de nouveaux paquets).
- `WEB_URL` / `API_URL` avec faute de frappe : le smoke test échoue alors que le déploiement a réussi.
- Un token ou un mot de passe collé dans un chat, une issue ou un commit est compromis : le renouveler.

## 6. Automatisation du dépôt

Déjà dans le template (rien à écrire, quelques réglages à faire) :

| Élément | Fichier | À faire une fois |
|---|---|---|
| Dependabot (npm, actions, Docker, compose), hebdo, groupé | `.github/dependabot.yml` | Settings → Advanced Security : activer *Dependabot alerts* et *security updates* |
| CodeQL (JS/TS + workflows), sur PR, `main` et chaque lundi | `.github/workflows/codeql.yml` | Laisser *Code scanning → Default setup* **désactivé** (il entrerait en conflit) |
| Templates d'issue (bug, fonctionnalité) et de PR | `.github/ISSUE_TEMPLATE/`, `pull_request_template.md` | rien |
| Consignes pour Claude Code : commandes, conventions, définition de fini | `CLAUDE.md` | rien |
| `@claude` dans issues et PR | `.github/workflows/claude.yml` | voir ci-dessous |

**`@claude`** : le workflow ne démarre que pour un propriétaire, membre ou collaborateur (le dépôt est public),
avec `contents/pull-requests/issues: write` et `id-token: write` (jeton OIDC court pour l'app Claude : requis, clé API ou non) seulement, 20 tours maximum et un Bash limité à `pnpm install|test|lint|typecheck|build`
et `pnpm turbo run`. Il ne pousse jamais sur `main` (ruleset) : il ouvre une branche, vous créez la PR.

1. Installer l'app GitHub **Claude** sur le dépôt (`/install-github-app` dans Claude Code, ou la page de l'app).
2. Dans un terminal : `claude setup-token` (connexion à votre abonnement Claude dans le navigateur), puis copier le jeton affiché.
   **Piège** : le jeton fait ~108 caractères et le terminal peut le couper en deux lignes ; copié tel quel, il contient un saut de
   ligne et l'API répond « Invalid auth token ». Agrandir la fenêtre, ou coller d'abord dans un éditeur de texte pour le
   remettre sur **une seule ligne**, puis copier.
3. Settings → Secrets and variables → Actions → **New repository secret** : `CLAUDE_CODE_OAUTH_TOKEN`. Ne jamais le coller ailleurs ;
   s'il fuite, le révoquer et en régénérer un.
4. Utiliser : commenter `@claude …` sur une issue ou une PR. Ne l'invoquer que sur du contenu de confiance :
   un texte écrit par un tiers peut tenter de détourner ses instructions.

Coût : l'usage passe sur le **quota de l'abonnement** (même fenêtre que votre usage interactif), sans facturation API séparée.
Pour une clé API à la place (facturation à l'usage, plafond à régler dans la console Anthropic), remplacer
`claude_code_oauth_token` par `anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}` dans `claude.yml`.

Les PR de Dependabot suivent les mêmes règles que les autres : CI verte requise, merge manuel. Ses PR n'ont pas accès
aux secrets (inutile : la CI n'en utilise pas).

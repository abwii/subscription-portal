# Déploiement (Fly.io)

> Mode d'emploi du template (checklist, workflow quotidien, rollback) : [USAGE.md](USAGE.md).

```
push sur main ──▶ CI (check, images :sha-xxxxxxx, smoke) ──▶ deploy-staging   (automatique)
tag vX.Y.Z    ──▶ release : retag sha-xxxxxxx → vX.Y.Z ──▶ deploy-production (reviewer requis)
Actions > Rollback (environnement + tag) ──▶ redéploie une image existante
```

**Une image est construite une fois** (par la CI, sur `main`) puis promue : staging et production
exécutent exactement les mêmes octets. Rien n'est reconstruit au déploiement ni au rollback.

## Mise en place (une seule fois par projet)

### 1. Apps Fly (4) et secrets runtime

```bash
fly auth login
for env in staging prod; do
  fly apps create <projet>-api-$env
  fly apps create <projet>-web-$env
done

# La base est un simple secret : Fly Managed Postgres (dès ~38 $/mois), Neon, Supabase…
# Collez la chaîne de connexion fournie par votre base, entre apostrophes.
fly secrets set DATABASE_URL='<chaîne de connexion>' --app <projet>-api-staging --stage
fly secrets set DATABASE_URL='<chaîne de connexion>' --app <projet>-api-prod --stage
```

Forme attendue (exemple Neon) :

```
postgresql://<user>:<mot-de-passe>@<hôte-complet>/<base>?sslmode=verify-full
```

Points d'attention, tous rencontrés en pratique :

- **Hôte complet** : `ep-xxx.c-2.eu-west-2.aws.neon.tech`, pas seulement `ep-xxx`
  (sinon `getaddrinfo ENOTFOUND` et `/ready` renvoie 503).
- **Connexion directe** (sans `-pooler` dans l'hôte) : le pool `pg` de l'API suffit, et le pooleur
  gêne les migrations.
- **`sslmode=verify-full`** : `pg` traite `require` comme `verify-full` et l'annonce par un avertissement ;
  on le dit explicitement. Inutile d'ajouter `channel_binding`.
- Ne collez jamais cette URL (elle contient le mot de passe) dans un chat, une issue ou un commit.
  Si elle fuite, réinitialisez le mot de passe chez le fournisseur.
- Après un changement de secret sans `--stage`, les machines redémarrent ; avec `--stage`,
  il prend effet au prochain déploiement.

`DATABASE_URL` vit **chez Fly uniquement**. GitHub ne le voit jamais.

Sous Windows (PowerShell), les boucles s'écrivent :

```powershell
$p = "<projet>"
foreach ($e in "staging","prod") { fly apps create "$p-api-$e"; fly apps create "$p-web-$e" }
```

### 2. Tokens de déploiement (un par app : un token Fly est limité à une app)

```bash
fly tokens create deploy --app <projet>-api-staging -x 999999h
# idem pour <projet>-web-staging, <projet>-api-prod, <projet>-web-prod
```

Copiez chaque token en entier, préfixe `FlyV1 ` compris.

### 3. Images publiques sur GHCR

Après le premier run de CI sur `main` : GitHub > Packages > `<repo>-api` et `<repo>-web` >
Package settings > *Change visibility* > Public. Fly tire alors les images sans authentification.
**Renommer le dépôt change le nom des images** (`ghcr.io/<owner>/<repo>-api`) : les nouveaux paquets
sont créés privés au premier run de CI et doivent être rendus publics à leur tour.

### 4. Environnements GitHub (Settings > Environments)

| | `staging` | `production` |
|---|---|---|
| Secrets | `FLY_API_TOKEN_API`, `FLY_API_TOKEN_WEB` (apps staging) | idem (apps prod) |
| Variables | `FLY_APP_API`, `FLY_APP_WEB`, `API_URL`, `WEB_URL` | idem |
| Required reviewers | non | **oui** |
| Deployment branches and tags | `main` | **Selected tags : `v*`** |

Pour `production` : cochez *Prevent self-review* si un second compte peut approuver.
Un dépôt public peut utiliser ces protections sur le plan gratuit.
`rollback.yml` est lancé depuis `main` : autorisez aussi `main` côté `production` pour pouvoir
rollback (la protection par reviewer reste la même).

## Utilisation

**Staging** : automatique à chaque merge sur `main`.

**Production** :

```bash
git checkout main && git pull
git tag v1.2.0 && git push origin v1.2.0
```

Le workflow *Release* vérifie que le commit est sur `main` et que sa CI est passée (image présente),
retague l'image en `v1.2.0`, puis attend l'approbation du reviewer avant de déployer.

**Rollback** : Actions > *Rollback* > *Run workflow* > environnement + tag (`v1.1.0`, ou
`sha-1a2b3c4` pour staging). Même approbation en production.
Les tags disponibles : GitHub > Packages > `<repo>-api` > Tags.

## Limites connues

- Migrations de base : aucune pour l'instant. Quand elles arriveront, elles devront être
  compatibles avec la version précédente, sinon un rollback d'image ne suffira pas.
- Machines en scale-to-zero (`min_machines_running = 0`) : premier appel lent après inactivité.
  Passez à 1 dans `apps/*/fly.toml` si la latence compte en production.
- Déploiement *rolling* : Fly abandonne la release si le health check `/health` échoue.
- Le déploiement est une **action composite** (`.github/actions/fly-deploy`), pas un workflow
  réutilisable : un workflow appelé ne reçoit pas les *secrets d'environnement* comme un job
  normal (ils arrivent vides). Chaque job de déploiement déclare donc lui-même `environment:`.

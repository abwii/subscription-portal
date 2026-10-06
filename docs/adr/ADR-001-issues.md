# ADR-001 : issues

Backlog dérivé de [ADR-001](./ADR-001-modele-abonnements.md). Chaque issue : tests d'abord (Vitest), migration additive,
`pnpm turbo run lint typecheck test build` vert. Ordre conseillé : 1 → 2 → 3, puis 4–8 (dépend de 3), 9–10 (dépend de 3),
11–12 (dépend de 3), 13–14 (UI, dépendent de 2–10), 15 (dépend de 13), 16 (dépend de 3), 17 (dépend de 13–14), 18 en dernier.

Étiquettes proposées : `area:api`, `area:web`, `adr-001`.

---

## 1. Catalogue des plans, prix et droits

**User story** : En tant que visiteur, je veux consulter les plans, leurs prix et leurs droits afin de choisir une offre.

**Périmètre** : migrations `accounts`, `plans`, `plan_prices`, `entitlements`, `plan_entitlements` ; seed local ;
`GET /plans` ; `GET /me/entitlements` ; injection de `Clock`.

**Critères d'acceptation**
- **Given** des plans actifs avec prix mensuel et annuel, **When** j'appelle `GET /plans`, **Then** je reçois chaque plan
  avec ses prix actifs (centimes + devise) et ses droits, triés par `rank`.
- **Given** un plan inactif ou un prix désactivé, **When** j'appelle `GET /plans`, **Then** ils n'apparaissent pas.
- **Given** un compte avec un abonnement `active`, **When** j'appelle `GET /me/entitlements`, **Then** je reçois les droits
  du plan souscrit avec leurs limites.
- **Given** un compte sans abonnement vivant (ou `paused`, `expired`), **When** j'appelle `GET /me/entitlements`,
  **Then** la liste est vide.

---

## 2. Checkout : souscrire à un plan

**User story** : En tant qu'utilisateur connecté, je veux souscrire à un plan afin d'accéder à ses droits.

**Périmètre** : `POST /subscriptions` ; port `PaymentProvider` ; état `pending` → `active` ; index unique partiel.

**Critères d'acceptation**
- **Given** un compte sans abonnement vivant et un `plan_price` actif, **When** je souscris, **Then** une souscription
  `pending` est créée avec une facture `open`, et la réponse contient les informations pour finaliser le paiement.
- **Given** une souscription `pending`, **When** le paiement réussit, **Then** elle passe `active`, la période
  démarre à la date du paiement et les droits sont accordés.
- **Given** une souscription `pending`, **When** le paiement n'aboutit pas sous 24 h, **Then** elle passe `expired`
  et aucun droit n'est accordé.
- **Given** un compte avec un abonnement vivant, **When** je souscris à nouveau, **Then** l'API répond `409`.
- **Given** un `plan_price` inactif, **When** je souscris, **Then** l'API répond `422`.
- **Given** une requête rejouée avec la même clé d'idempotence, **When** elle est envoyée deux fois, **Then** une seule
  souscription est créée.

---

## 3. Factures et webhooks de paiement

**User story** : En tant qu'abonné, je veux retrouver mes factures et être sûr que chaque paiement est enregistré
une seule fois.

**Périmètre** : `invoices`, `invoice_lines`, `payments`, `payment_events` ; `POST /webhooks/payments` ;
`GET /invoices`, `GET /invoices/:id` ; numérotation séquentielle.

**Critères d'acceptation**
- **Given** un webhook signé `payment.succeeded`, **When** il est reçu, **Then** le paiement est `succeeded`, la facture
  `paid` et l'événement journalisé.
- **Given** le même `provider_event_id` reçu deux fois, **When** le second arrive, **Then** aucun effet de bord
  supplémentaire et la réponse est `200`.
- **Given** une signature invalide, **When** le webhook est reçu, **Then** `401` et rien n'est écrit.
- **Given** une facture `open` ou `paid`, **When** on tente de modifier ses lignes, **Then** l'opération est refusée.
- **Given** des factures de plusieurs comptes, **When** je liste `GET /invoices`, **Then** je ne vois que les miennes ;
  l'accès à la facture d'un autre compte renvoie `404`.
- **Given** un échec de renouvellement, **When** le webhook `payment.failed` arrive, **Then** l'abonnement passe
  `past_due` et les droits sont conservés pendant la période de grâce.

---

## 4. Upgrade avec prorata

**User story** : En tant qu'abonné, je veux passer immédiatement à un plan supérieur en ne payant que la différence
pour la période restante.

**Périmètre** : `POST /subscriptions/:id/change-plan` (cas upgrade) ; calcul de prorata pur et testé ;
facture à deux lignes.

**Critères d'acceptation**
- **Given** un plan à 10,00 € / mois, une période de 30 jours dont 15 restent, et un plan cible à 20,00 € / mois,
  **When** je passe au plan cible, **Then** la facture contient un crédit de −5,00 € et un débit de 10,00 €, total 5,00 €.
- **Given** un prorata donnant des fractions de centime, **When** il est calculé, **Then** chaque ligne est arrondie
  half-up une seule fois.
- **Given** l'upgrade payée, **When** le paiement réussit, **Then** le plan change, `current_period_end` est inchangé et
  les nouveaux droits sont actifs.
- **Given** le paiement de l'upgrade échoué, **When** le webhook arrive, **Then** le plan reste l'ancien.
- **Given** un changement mensuel → annuel, **When** je confirme, **Then** une nouvelle période annuelle démarre et le
  crédit restant est déduit de la facture.
- **Given** un abonnement `paused` ou `canceled`, **When** je demande un upgrade, **Then** `409`.

---

## 5. Downgrade programmé

**User story** : En tant qu'abonné, je veux passer à un plan inférieur au prochain renouvellement sans perdre ce que j'ai
déjà payé.

**Critères d'acceptation**
- **Given** un abonnement actif, **When** je demande un plan de `rank` inférieur, **Then** `pending_plan_price_id` est
  renseigné, aucun remboursement n'est émis et mes droits actuels sont conservés.
- **Given** un downgrade programmé, **When** la période se termine et que le renouvellement réussit, **Then** le nouveau
  plan s'applique, facturé au nouveau prix.
- **Given** un downgrade programmé, **When** je l'annule avant la fin de période, **Then** `pending_plan_price_id`
  est vidé.
- **Given** un downgrade programmé, **When** je demande un upgrade, **Then** le downgrade est annulé et l'upgrade suit
  les règles du ticket 4.

---

## 6. Mettre en pause un abonnement

**User story** : En tant qu'abonné, je veux suspendre temporairement mon abonnement afin de ne pas payer pendant une
absence.

**Critères d'acceptation**
- **Given** un abonnement `active`, **When** je demande une pause avec `resume_at` ≤ 90 jours, **Then** il passe
  `paused`, la facturation est suspendue et les droits payants sont retirés.
- **Given** `resume_at` > 90 jours, **When** je demande la pause, **Then** `422`.
- **Given** une pause déjà utilisée dans les 12 derniers mois, **When** j'en redemande une, **Then** `409`.
- **Given** un abonnement `past_due` ou `pending`, **When** je demande une pause, **Then** `409`.
- **Given** une pause, **When** elle est créée, **Then** un `subscription_events` `paused` est écrit et la série de
  fidélité est gelée.

---

## 7. Reprendre un abonnement en pause

**User story** : En tant qu'abonné en pause, je veux reprendre mon abonnement, manuellement ou à la date prévue.

**Critères d'acceptation**
- **Given** un abonnement `paused`, **When** je reprends manuellement, **Then** il passe `active`, une nouvelle période
  démarre à cet instant, une facture est émise pour cette période et les droits sont rétablis.
- **Given** `resume_at` atteint, **When** le job de reprise s'exécute, **Then** la reprise se fait comme ci-dessus.
- **Given** un paiement de reprise échoué, **When** le webhook arrive, **Then** l'abonnement passe `past_due`.
- **Given** un abonnement non `paused`, **When** je demande la reprise, **Then** `409`.
- **Given** le job exécuté deux fois, **When** il rencontre la même pause, **Then** une seule reprise a lieu.

---

## 8. Annuler un abonnement

**User story** : En tant qu'abonné, je veux annuler mon abonnement tout en profitant de ce que j'ai payé.

**Critères d'acceptation**
- **Given** un abonnement `active`, **When** j'annule, **Then** `cancel_at_period_end = true`, les droits restent
  jusqu'à `current_period_end` et aucun remboursement n'est émis.
- **Given** une annulation demandée, **When** la période se termine, **Then** le statut passe `canceled`, aucun
  renouvellement n'est tenté et les droits sont retirés.
- **Given** une annulation demandée mais pas encore effective, **When** je la révoque, **Then**
  `cancel_at_period_end = false` et le renouvellement reste prévu.
- **Given** un abonnement `paused`, **When** j'annule, **Then** il passe `canceled` immédiatement.
- **Given** un abonnement déjà `canceled`, **When** j'annule, **Then** la réponse est idempotente (`200`, aucun
  nouvel événement).

---

## 9. Offrir un abonnement (achat de cadeau)

**User story** : En tant qu'utilisateur, je veux offrir un abonnement à quelqu'un afin de lui faire plaisir.

**Périmètre** : `POST /gifts`, table `gifts`, facture payée par l'offrant, e-mail au destinataire (port `Mailer`).

**Critères d'acceptation**
- **Given** un `plan_price` actif et une durée en périodes, **When** j'achète un cadeau et que le paiement réussit,
  **Then** un `gift` `pending` existe avec un code unique de ≥ 128 bits et une expiration à 12 mois.
- **Given** un paiement non abouti, **When** le webhook d'échec arrive, **Then** aucun cadeau actif n'est créé.
- **Given** un cadeau acheté, **When** je consulte mes factures, **Then** la facture du cadeau apparaît à mon nom.
- **Given** un cadeau `pending`, **When** il est remboursé avant rédemption, **Then** il passe `refunded` et son code
  devient inutilisable.
- **Given** le code d'un cadeau, **When** il apparaît dans les logs ou réponses d'un tiers, **Then** il est absent
  (visible uniquement de l'offrant et du destinataire).

---

## 10. Échanger un cadeau

**User story** : En tant que destinataire, je veux activer mon cadeau avec un code afin de bénéficier de l'abonnement.

**Critères d'acceptation**
- **Given** un cadeau `pending` non expiré et un compte sans abonnement vivant, **When** j'échange le code, **Then** une
  souscription `active` est créée pour `duration_periods`, sans paiement, et le cadeau passe `redeemed`.
- **Given** un cadeau déjà `redeemed`, `expired` ou `refunded`, **When** j'échange le code, **Then** `410`.
- **Given** un code inconnu, **When** j'échange, **Then** `404` et la tentative est comptée (limitation de débit).
- **Given** un compte avec un abonnement vivant, **When** j'échange un code, **Then** `409` et le cadeau reste `pending`.
- **Given** deux échanges simultanés du même code, **When** ils s'exécutent, **Then** un seul réussit.
- **Given** la fin des périodes offertes, **When** la dernière période se termine, **Then** l'abonnement passe
  `canceled` sans renouvellement automatique.

---

## 11. XP et paliers de fidélité

**User story** : En tant qu'abonné, je veux gagner des XP à chaque paiement et monter de palier afin d'obtenir des
remises.

**Périmètre** : `loyalty_tiers`, `loyalty_accounts`, `xp_ledger` ; consommation de l'événement « facture payée » ;
`GET /me/loyalty` ; remise de palier appliquée aux renouvellements.

**Critères d'acceptation**
- **Given** une facture payée de 19,99 €, **When** l'événement est traité, **Then** 190 XP sont inscrits au journal
  (10 XP/€, arrondi inférieur).
- **Given** le même événement traité deux fois, **When** la seconde écriture arrive, **Then** la clé d'idempotence la
  rejette et le total reste inchangé.
- **Given** un total qui franchit 500 XP, **When** le journal est mis à jour, **Then** le palier passe à Argent.
- **Given** un palier Argent, **When** le renouvellement est facturé, **Then** une ligne de remise de 2 % apparaît.
- **Given** un remboursement, **When** il est enregistré, **Then** une écriture XP négative est ajoutée sans
  rétrograder le palier dans les 12 mois suivant son obtention.
- **Given** le journal, **When** on recalcule le total, **Then** il est égal à `loyalty_accounts.xp_total`.

---

## 12. Séries (streaks)

**User story** : En tant qu'abonné, je veux que mes périodes payées consécutives soient récompensées afin d'être
encouragé à rester.

**Critères d'acceptation**
- **Given** une période payée dans les délais, **When** la facture est payée, **Then** `streak_current` augmente de 1 et
  `streak_best = max(streak_best, streak_current)`.
- **Given** une série atteignant 3, **When** elle est incrémentée, **Then** un bonus de 50 XP est inscrit une seule fois
  pour ce palier de série.
- **Given** un abonnement qui passe `past_due` sans être rattrapé, **When** la période expire, **Then**
  `streak_current = 0` et `streak_best` est inchangé.
- **Given** un abonnement `paused`, **When** il est repris, **Then** la série reprend là où elle était (gelée, pas
  remise à zéro, pas incrémentée).
- **Given** un paiement rattrapé pendant la période de grâce, **When** il réussit, **Then** la série n'est pas rompue.
- **Given** un paiement rejoué (webhook en double), **When** il est traité, **Then** la série n'est incrémentée
  qu'une fois.

---

## 13. Page des plans et tunnel de paiement (UI)

**User story** : En tant que visiteur, je veux comparer les plans et finaliser ma souscription dans un tunnel clair afin de
m'abonner sans friction.

**Périmètre** : `apps/web` (page `/plans`, tunnel `/checkout`) ; composants présentationnels dans `packages/ui`
(carte de plan, bascule mensuel/annuel, récapitulatif) ; appels à `GET /plans` et `POST /subscriptions` uniquement
via l'API (jamais Postgres).

**Critères d'acceptation**
- **Given** le catalogue, **When** j'ouvre `/plans`, **Then** chaque plan affiche prix, droits et un bouton de souscription ;
  la bascule mensuel/annuel met à jour les prix sans rechargement.
- **Given** un visiteur non connecté, **When** il choisit un plan, **Then** il est dirigé vers la connexion puis revient au
  tunnel avec son choix conservé.
- **Given** le tunnel, **When** je valide, **Then** un récapitulatif (plan, intervalle, montant, date de renouvellement) est
  affiché avant le paiement.
- **Given** un paiement refusé, **When** l'API renvoie une erreur, **Then** un message explicite est affiché et je peux
  réessayer sans ressaisir mon choix.
- **Given** un abonné déjà actif, **When** il ouvre `/plans`, **Then** son plan courant est signalé et les autres plans
  mènent à l'upgrade/downgrade, pas au checkout.
- **Given** l'API indisponible, **When** la page se charge, **Then** un état d'erreur avec nouvelle tentative s'affiche.

---

## 14. Portail abonné (UI)

**User story** : En tant qu'abonné, je veux gérer mon abonnement, mes factures et ma fidélité depuis un espace unique.

**Périmètre** : `apps/web` (`/account`) : abonnement, factures, cadeaux, fidélité.

**Critères d'acceptation**
- **Given** un abonnement actif, **When** j'ouvre le portail, **Then** je vois plan, statut, prochaine échéance, droits
  et palier/série de fidélité.
- **Given** le portail, **When** je demande un upgrade, **Then** le montant du prorata est affiché avant confirmation.
- **Given** le portail, **When** je mets en pause, reprends ou annule, **Then** une confirmation explicite précise les
  conséquences (droits, date d'effet) avant l'appel API.
- **Given** un downgrade ou une annulation programmés, **When** j'ouvre le portail, **Then** ils sont visibles avec la
  date d'effet et un bouton pour les révoquer.
- **Given** mes factures, **When** j'ouvre la liste, **Then** je peux consulter chaque facture et son statut.
- **Given** un cadeau, **When** je saisis un code, **Then** le résultat (succès, expiré, déjà utilisé, abonnement
  existant) est affiché clairement.

---

## 15. Feature flag et A/B test sur la page des plans

**User story** : En tant que produit, je veux tester des variantes de la page des plans derrière un flag afin de mesurer
leur effet sur la conversion sans redéployer.

**Périmètre** : mécanisme de flags lu côté serveur (config via `loadConfig` ou table dédiée), attribution stable de
variante, événements de conversion.

**Critères d'acceptation**
- **Given** un flag désactivé, **When** j'ouvre `/plans`, **Then** la variante de contrôle est servie à tous.
- **Given** un flag actif avec 50 % de trafic, **When** un visiteur arrive, **Then** une variante lui est attribuée de
  façon déterministe (même visiteur, même variante) et persistée.
- **Given** une variante, **When** le visiteur voit la page, choisit un plan ou finalise le paiement, **Then** les
  événements `plans_viewed`, `plan_selected`, `checkout_completed` sont émis avec la variante.
- **Given** une panne du service de flags, **When** la page se charge, **Then** la variante de contrôle est servie
  (échec ouvert sur le contrôle).
- **Given** un visiteur ayant refusé le suivi, **When** il navigue, **Then** aucune donnée personnelle n'est collectée
  et il voit le contrôle.
- **Given** l'A/B test terminé, **When** le flag est retiré, **Then** le code de la variante perdante est supprimé
  (critère de clôture de l'issue).

---

## 16. Observabilité : échecs de webhook et alertes

**User story** : En tant qu'opérateur, je veux être alerté quand des paiements ou webhooks échouent afin d'intervenir
avant que des clients perdent leurs droits.

**Périmètre** : logs structurés (sans secret ni donnée de carte), métriques, alertes ; dépend de l'issue 3.

**Critères d'acceptation**
- **Given** un webhook traité, rejeté (signature) ou en erreur, **When** il est reçu, **Then** un log structuré indique
  type, `provider_event_id`, résultat et durée, sans secret ni donnée personnelle superflue.
- **Given** un webhook en erreur 5xx, **When** le taux d'échec dépasse un seuil sur une fenêtre définie, **Then** une
  alerte est émise.
- **Given** aucun webhook reçu pendant une durée anormale en heures ouvrées, **When** la fenêtre expire, **Then** une
  alerte « silence » est émise.
- **Given** des abonnements `pending` ou `past_due` au-delà de leur délai, **When** le job de contrôle s'exécute,
  **Then** leur nombre est exposé en métrique et alerte au-delà du seuil.
- **Given** une alerte, **When** elle se déclenche, **Then** elle renvoie vers un runbook dans `docs/` décrivant les
  actions de reprise (rejeu de webhook idempotent).
- **Given** `/health` et `/ready`, **When** l'observabilité est ajoutée, **Then** leur contrat reste inchangé
  (`/health` ne touche pas la base).

---

## 17. Accessibilité et tests E2E

**User story** : En tant qu'utilisateur, y compris avec un handicap, je veux pouvoir parcourir les plans, payer et gérer
mon abonnement ; en tant qu'équipe, je veux que ces parcours soient vérifiés automatiquement.

**Critères d'acceptation**
- **Given** `/plans`, le tunnel et le portail, **When** un audit automatisé (axe) s'exécute en CI, **Then** aucune
  violation de niveau sérieux ou critique n'est relevée (WCAG 2.2 AA).
- **Given** le tunnel, **When** je navigue au clavier seul, **Then** tous les contrôles sont atteignables, l'ordre de
  focus est logique et le focus est visible.
- **Given** une erreur de formulaire ou de paiement, **When** elle survient, **Then** elle est annoncée aux lecteurs
  d'écran et associée au champ concerné.
- **Given** un environnement de test avec fournisseur de paiement simulé, **When** les E2E s'exécutent, **Then** les
  parcours checkout réussi, checkout refusé, upgrade, pause/reprise, annulation et échange de cadeau sont couverts.
- **Given** la CI, **When** un E2E échoue, **Then** la capture et la trace sont conservées comme artefacts, sans secret.
- **Given** les données E2E, **When** les tests se terminent, **Then** la base de test est remise à l'état initial.

---

## 18. Déploiement staging/prod et rollback

**User story** : En tant qu'équipe, je veux déployer le domaine abonnements en staging puis en production, avec un retour
arrière maîtrisé.

**Périmètre** : migrations, secrets Fly (clés fournisseur de paiement, secret de webhook), documentation dans
`docs/DEPLOY.md`. Toute modification de workflows ou de config Fly requiert une validation explicite avant exécution.

**Critères d'acceptation**
- **Given** une release candidate, **When** elle est déployée en staging, **Then** les migrations s'appliquent, `/ready`
  est vert et les E2E (issue 17) passent contre staging avec le fournisseur en mode test.
- **Given** les secrets de paiement, **When** ils sont configurés, **Then** ils vivent uniquement dans les secrets Fly /
  environnements GitHub et jamais dans le code, les logs ou `.env.example`.
- **Given** la production, **When** un tag `vX.Y.Z` est déployé, **Then** les migrations additives passent avant le
  nouveau code et le webhook de production est enregistré avec son propre secret.
- **Given** un incident après déploiement, **When** on lance le rollback vers `vX.Y.Z` ou `sha-` + 7 caractères,
  **Then** le code précédent redémarre et reste compatible avec le schéma migré (migrations rétro-compatibles).
- **Given** une migration à annuler, **When** la procédure `down` est suivie, **Then** elle est documentée, testée sur
  staging et n'est jamais exécutée automatiquement.
- **Given** `docs/DEPLOY.md`, **When** l'issue est terminée, **Then** variables, migrations et procédure de rollback
  y figurent.

import type { FastifyInstance } from "fastify";
import type { Clock } from "./clock.js";

export type PriceInterval = "month" | "year";
export type EntitlementKind = "boolean" | "limit";
export type SubscriptionStatus =
  | "pending"
  | "active"
  | "past_due"
  | "paused"
  | "canceled"
  | "expired";

export interface PriceView {
  id: string;
  interval: PriceInterval;
  amountCents: number;
  currency: string;
}

/** `limit` vaut `null` pour un droit booléen. */
export interface EntitlementView {
  code: string;
  kind: EntitlementKind;
  limit: number | null;
}

export interface PlanView {
  id: string;
  code: string;
  name: string;
  rank: number;
  prices: PriceView[];
  entitlements: EntitlementView[];
}

export interface SubscriptionRef {
  status: SubscriptionStatus;
  planId: string;
  currentPeriodEnd: Date;
}

/** Port de lecture du catalogue : l'implémentation SQL est dans `catalog.pg.ts`. */
export interface CatalogRepository {
  /** Plans actifs, prix actifs uniquement, triés par `rank`. */
  listPlans(): Promise<PlanView[]>;
  /** Abonnement « vivant » du compte (pending, active, past_due, paused), s'il existe. */
  findSubscription(accountId: string): Promise<SubscriptionRef | null>;
  listPlanEntitlements(planId: string): Promise<EntitlementView[]>;
}

export type Authenticate = (req: {
  headers: Record<string, string | string[] | undefined>;
}) => Promise<string | null>;

const GRACE_PERIOD_MS = 7 * 24 * 60 * 60 * 1000;

/** ADR-001 : `active` accorde les droits ; `past_due` les garde 7 jours après la fin de période. */
export function grantsEntitlements(sub: SubscriptionRef, now: Date): boolean {
  if (sub.status === "active") return true;
  if (sub.status === "past_due") {
    return now.getTime() < sub.currentPeriodEnd.getTime() + GRACE_PERIOD_MS;
  }
  return false;
}

interface CatalogRoutesOptions {
  catalog: CatalogRepository;
  clock: Clock;
  authenticate: Authenticate;
}

export function registerCatalogRoutes(
  app: FastifyInstance,
  { catalog, clock, authenticate }: CatalogRoutesOptions,
): void {
  app.get("/plans", async () => ({ plans: await catalog.listPlans() }));

  app.get("/me/entitlements", async (req, reply) => {
    const accountId = await authenticate(req);
    if (accountId === null) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    const sub = await catalog.findSubscription(accountId);
    if (sub === null || !grantsEntitlements(sub, clock.now())) {
      return { entitlements: [] };
    }
    return { entitlements: await catalog.listPlanEntitlements(sub.planId) };
  });
}

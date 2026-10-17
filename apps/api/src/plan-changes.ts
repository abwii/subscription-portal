import type { FastifyInstance } from "fastify";
import type { Authenticate, PriceInterval, SubscriptionStatus } from "./catalog.js";
import type { Clock } from "./clock.js";
import type { PaymentDetails, PaymentProvider } from "./payments.js";
import { isUpgrade, quoteUpgrade, type QuotedLine, type UpgradeQuote } from "./proration.js";
import {
  DuplicateIdempotencyKeyError,
  type SubscriptionRepository,
} from "./subscriptions.js";

export interface SubscriptionForChange {
  id: string;
  status: SubscriptionStatus;
  planPriceId: string;
  planId: string;
  rank: number;
  interval: PriceInterval;
  amountCents: number;
  currency: string;
  periodStart: Date;
  periodEnd: Date;
  /** Prix visé par un downgrade programmé, appliqué au prochain renouvellement. */
  pendingPlanPriceId: string | null;
  cancelAtPeriodEnd: boolean;
}

export interface CreateChangeInvoiceInput {
  accountId: string;
  subscriptionId: string;
  targetPlanPriceId: string;
  idempotencyKey: string;
  quote: UpgradeQuote;
  currency: string;
  now: Date;
}

export interface ChangeRecord {
  invoiceId: string;
  invoiceNumber: string;
  invoiceStatus: string;
  totalCents: number;
  currency: string;
  subscriptionId: string;
  targetPlanPriceId: string;
  lines: QuotedLine[];
}

/** Une demande de changement est déjà en attente de paiement pour cet abonnement. */
export class ChangeInProgressError extends Error {
  constructor() {
    super("a plan change is already awaiting payment");
  }
}

/** Les demandes de changement expirent comme les checkouts non payés (24 h, voir `expirePending`). */

type ChangeResult =
  | { kind: "created" | "replayed"; record: ChangeRecord; payment: PaymentDetails | null }
  | { kind: "scheduled"; planPriceId: string; effectiveAt: Date }
  | {
      kind:
        | "not_found"
        | "not_active"
        | "price_unavailable"
        | "currency_mismatch"
        | "same_plan"
        | "invalid_proration"
        | "change_in_progress"
        | "idempotency_key_reused";
    };

interface ChangeInput {
  accountId: string;
  subscriptionId: string;
  planPriceId: string;
  idempotencyKey: string;
}

async function changePlan(
  deps: { repo: SubscriptionRepository; payments: PaymentProvider; clock: Clock },
  input: ChangeInput,
): Promise<ChangeResult> {
  const { repo, payments, clock } = deps;
  // Espace de clés distinct du checkout côté fournisseur.
  const providerKey = `change:${input.idempotencyKey}`;

  const replay = async (record: ChangeRecord): Promise<ChangeResult> => {
    if (
      record.subscriptionId !== input.subscriptionId ||
      record.targetPlanPriceId !== input.planPriceId
    ) {
      return { kind: "idempotency_key_reused" };
    }
    const payment =
      record.invoiceStatus === "open"
        ? await payments.createPayment({
            accountId: input.accountId,
            invoiceId: record.invoiceId,
            amountCents: record.totalCents,
            currency: record.currency,
            idempotencyKey: providerKey,
          })
        : null;
    return { kind: "replayed", record, payment };
  };

  const sub = await repo.findSubscriptionForChange(input.accountId, input.subscriptionId);
  if (!sub) return { kind: "not_found" };

  const existing = await repo.findChangeByIdempotencyKey(
    input.accountId,
    input.idempotencyKey,
  );
  if (existing) return replay(existing);

  if (sub.status !== "active") return { kind: "not_active" };

  const target = await repo.findPlanPrice(input.planPriceId);
  if (!target?.active) return { kind: "price_unavailable" };
  if (target.currency !== sub.currency) return { kind: "currency_mismatch" };
  if (target.id === sub.planPriceId) return { kind: "same_plan" };
  if (!isUpgrade(sub, target)) {
    // Downgrade : aucun argent ne bouge, le changement s'applique au prochain renouvellement.
    await repo.scheduleDowngrade(sub.id, target.id);
    return { kind: "scheduled", planPriceId: target.id, effectiveAt: sub.periodEnd };
  }

  const now = clock.now();
  const quote = quoteUpgrade({ current: sub, target, now });
  // Un prélèvement nul ou négatif n'a pas de sens ici (fin de période imminente).
  if (quote.totalCents <= 0) return { kind: "invalid_proration" };

  let record: ChangeRecord;
  try {
    record = await repo.createChangeInvoice({
      accountId: input.accountId,
      subscriptionId: sub.id,
      targetPlanPriceId: target.id,
      idempotencyKey: input.idempotencyKey,
      quote,
      currency: sub.currency,
      now,
    });
  } catch (err) {
    const conflict =
      err instanceof ChangeInProgressError || err instanceof DuplicateIdempotencyKeyError;
    if (!conflict) throw err;
    // Course avec une requête de même clé : si la clé existe désormais, c'est un rejeu.
    const winner = await repo.findChangeByIdempotencyKey(input.accountId, input.idempotencyKey);
    if (winner) return replay(winner);
    if (err instanceof ChangeInProgressError) return { kind: "change_in_progress" };
    throw err;
  }

  const payment = await payments.createPayment({
    accountId: input.accountId,
    invoiceId: record.invoiceId,
    amountCents: record.totalCents,
    currency: record.currency,
    idempotencyKey: providerKey,
  });
  await repo.recordPayment(record.invoiceId, payment.providerRef, record.totalCents);
  return { kind: "created", record, payment };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UUID_PATTERN = UUID.source;

interface PlanChangeRoutesOptions {
  subscriptions: SubscriptionRepository;
  payments: PaymentProvider | undefined;
  clock: Clock;
  authenticate: Authenticate;
}

export function registerPlanChangeRoutes(
  app: FastifyInstance,
  { subscriptions, payments, clock, authenticate }: PlanChangeRoutesOptions,
): void {
  app.post<{ Params: { id: string }; Body: { planPriceId: string } }>(
    "/subscriptions/:id/change-plan",
    {
      schema: {
        body: {
          type: "object",
          required: ["planPriceId"],
          additionalProperties: false,
          properties: { planPriceId: { type: "string", pattern: UUID_PATTERN } },
        },
        headers: {
          type: "object",
          required: ["idempotency-key"],
          properties: {
            "idempotency-key": { type: "string", minLength: 1, maxLength: 128 },
          },
        },
      },
    },
    async (req, reply) => {
      const accountId = await authenticate(req);
      if (accountId === null) return reply.code(401).send({ error: "unauthorized" });
      if (!payments) {
        return reply.code(503).send({ error: "payment_provider_unconfigured" });
      }
      // 404 (et non 403) pour l'abonnement d'un autre compte : son existence reste cachée.
      if (!UUID.test(req.params.id)) return reply.code(404).send({ error: "not_found" });

      let result: ChangeResult;
      try {
        result = await changePlan(
          { repo: subscriptions, payments, clock },
          {
            accountId,
            subscriptionId: req.params.id,
            planPriceId: req.body.planPriceId,
            idempotencyKey: String(req.headers["idempotency-key"]),
          },
        );
      } catch (err) {
        req.log.error({ err }, "plan change failed");
        // La demande ouverte expire au bout de 24 h ; un rejeu avec la même clé reprend le paiement.
        return reply.code(502).send({ error: "payment_provider_error" });
      }

      switch (result.kind) {
        case "not_found":
          return reply.code(404).send({ error: "not_found" });
        case "not_active":
          return reply.code(409).send({ error: "subscription_not_active" });
        case "change_in_progress":
        case "idempotency_key_reused":
          return reply.code(409).send({ error: result.kind });
        case "price_unavailable":
        case "currency_mismatch":
        case "same_plan":
        case "invalid_proration":
          return reply.code(422).send({ error: result.kind });
        case "scheduled":
          return reply.code(200).send({
            scheduledChange: {
              planPriceId: result.planPriceId,
              effectiveAt: result.effectiveAt,
            },
          });
        case "created":
        case "replayed": {
          const { record, payment } = result;
          return reply.code(result.kind === "created" ? 201 : 200).send({
            invoice: {
              id: record.invoiceId,
              number: record.invoiceNumber,
              status: record.invoiceStatus,
              totalCents: record.totalCents,
              currency: record.currency,
              lines: record.lines,
            },
            payment,
          });
        }
      }
    },
  );

  // Annule un downgrade programmé. Idempotent : 204 même s'il n'y en avait pas.
  app.delete<{ Params: { id: string } }>(
    "/subscriptions/:id/scheduled-change",
    async (req, reply) => {
      const accountId = await authenticate(req);
      if (accountId === null) return reply.code(401).send({ error: "unauthorized" });
      if (!UUID.test(req.params.id)) return reply.code(404).send({ error: "not_found" });
      const outcome = await subscriptions.clearScheduledChange(accountId, req.params.id);
      if (outcome === "not_found") return reply.code(404).send({ error: "not_found" });
      return reply.code(204).send();
    },
  );
}

import type { FastifyInstance } from "fastify";
import type { Authenticate, PriceInterval, SubscriptionStatus } from "./catalog.js";
import type { Clock } from "./clock.js";
import type {
  PaymentDetails,
  PaymentEvent,
  PaymentEventOutcome,
  PaymentProvider,
} from "./payments.js";
import type {
  ChangeRecord,
  CreateChangeInvoiceInput,
  SubscriptionForChange,
} from "./plan-changes.js";
import type {
  CreateRenewalInvoiceInput,
  DueRenewal,
  RenewalInvoice,
} from "./renewals.js";

export interface PlanPriceRef {
  id: string;
  planId: string;
  rank: number;
  interval: PriceInterval;
  amountCents: number;
  currency: string;
  active: boolean;
}

export interface CreatePendingInput {
  accountId: string;
  planPriceId: string;
  idempotencyKey: string;
  amountCents: number;
  currency: string;
  interval: PriceInterval;
  now: Date;
}

export interface CheckoutRecord {
  subscriptionId: string;
  status: SubscriptionStatus;
  planPriceId: string;
  invoiceId: string;
  invoiceNumber: string;
  invoiceStatus: string;
  totalCents: number;
  currency: string;
}

/** L'index unique partiel refuse un second abonnement vivant pour le compte. */
export class LiveSubscriptionExistsError extends Error {
  constructor() {
    super("account already has a live subscription");
  }
}

/** Même (compte, clé d'idempotence) déjà utilisé : une requête concurrente a gagné. */
export class DuplicateIdempotencyKeyError extends Error {
  constructor() {
    super("idempotency key already used");
  }
}

export interface SubscriptionRepository {
  findPlanPrice(id: string): Promise<PlanPriceRef | null>;
  findByIdempotencyKey(
    accountId: string,
    key: string,
  ): Promise<CheckoutRecord | null>;
  /**
   * Crée atomiquement l'abonnement `pending`, sa facture `open` et la ligne de facture.
   * Lève `LiveSubscriptionExistsError` ou `DuplicateIdempotencyKeyError`.
   */
  createPending(input: CreatePendingInput): Promise<CheckoutRecord>;
  /** Sans effet si `providerRef` est déjà enregistré (rejeu). */
  recordPayment(
    invoiceId: string,
    providerRef: string,
    amountCents: number,
  ): Promise<void>;
  /**
   * Enregistre l'événement (idempotence) et applique son effet, en une seule requête atomique :
   * - `payment.succeeded` : paiement `succeeded`, facture `paid`, abonnement `pending` → `active`
   *   avec une période qui démarre à `now` ;
   * - `payment.failed` : paiement `failed` ; un abonnement `active` passe `past_due` (un `pending`
   *   reste `pending` : le client peut réessayer jusqu'à l'expiration).
   */
  applyPaymentEvent(event: PaymentEvent, now: Date): Promise<PaymentEventOutcome>;
  /** Abonnement du compte avec le plan courant, pour chiffrer un changement. `null` si absent ou à un autre compte. */
  findSubscriptionForChange(
    accountId: string,
    subscriptionId: string,
  ): Promise<SubscriptionForChange | null>;
  findChangeByIdempotencyKey(
    accountId: string,
    key: string,
  ): Promise<ChangeRecord | null>;
  /**
   * Crée atomiquement la facture `open` de changement (prix visé, lignes de prorata).
   * Lève `ChangeInProgressError` ou `DuplicateIdempotencyKeyError`.
   */
  createChangeInvoice(input: CreateChangeInvoiceInput): Promise<ChangeRecord>;
  /** Programme un downgrade pour le prochain renouvellement (abonnement `active` uniquement). */
  scheduleDowngrade(subscriptionId: string, planPriceId: string): Promise<void>;
  /** `cleared` : un downgrade était programmé ; `none` : rien à annuler ; `not_found` : inconnu ou autre compte. */
  clearScheduledChange(
    accountId: string,
    subscriptionId: string,
  ): Promise<"cleared" | "none" | "not_found">;
  /** Abonnements `active` échus, sans facture de renouvellement ouverte ni annulation programmée. */
  listDueRenewals(now: Date, limit: number): Promise<DueRenewal[]>;
  /** `null` si une facture de renouvellement est déjà ouverte pour cet abonnement. */
  createRenewalInvoice(
    input: CreateRenewalInvoiceInput,
  ): Promise<RenewalInvoice | null>;
  /**
   * Ferme ce qui n'a pas été payé à temps : `pending` créés avant `createdBefore` → `expired`, et
   * demandes de changement ouvertes émises avant `createdBefore`. Factures `void`. Retourne le nombre
   * d'éléments fermés.
   */
  expirePending(createdBefore: Date): Promise<number>;
}

export const PENDING_TTL_MS = 24 * 60 * 60 * 1000;

/** À planifier (ex. toutes les 15 minutes) : ferme les checkouts non payés au bout de 24 h. */
export function expirePendingSubscriptions(
  repo: SubscriptionRepository,
  clock: Clock,
): Promise<number> {
  return repo.expirePending(new Date(clock.now().getTime() - PENDING_TTL_MS));
}

interface SubscribeInput {
  accountId: string;
  planPriceId: string;
  idempotencyKey: string;
}

type SubscribeResult =
  | {
      kind: "created" | "replayed";
      record: CheckoutRecord;
      payment: PaymentDetails | null;
    }
  | {
      kind:
        | "price_unavailable"
        | "live_subscription_exists"
        | "idempotency_key_reused";
    };

async function subscribe(
  deps: { repo: SubscriptionRepository; payments: PaymentProvider; clock: Clock },
  input: SubscribeInput,
): Promise<SubscribeResult> {
  const { repo, payments, clock } = deps;

  const replay = async (
    record: CheckoutRecord,
  ): Promise<SubscribeResult> => {
    if (record.planPriceId !== input.planPriceId) {
      return { kind: "idempotency_key_reused" };
    }
    // Toujours rappelé : le fournisseur dédoublonne sur la clé et rend le même paiement.
    const payment =
      record.status === "pending"
        ? await payments.createPayment(paymentInput(record, input))
        : null;
    return { kind: "replayed", record, payment };
  };

  const existing = await repo.findByIdempotencyKey(
    input.accountId,
    input.idempotencyKey,
  );
  if (existing) return replay(existing);

  const price = await repo.findPlanPrice(input.planPriceId);
  if (!price?.active) return { kind: "price_unavailable" };

  let record: CheckoutRecord;
  try {
    record = await repo.createPending({
      accountId: input.accountId,
      planPriceId: price.id,
      idempotencyKey: input.idempotencyKey,
      amountCents: price.amountCents,
      currency: price.currency,
      interval: price.interval,
      now: clock.now(),
    });
  } catch (err) {
    const conflict =
      err instanceof LiveSubscriptionExistsError ||
      err instanceof DuplicateIdempotencyKeyError;
    if (!conflict) throw err;
    // Course avec une requête de même clé : Postgres signale l'un ou l'autre index. Si la clé
    // existe désormais, c'est un rejeu et non un conflit.
    const winner = await repo.findByIdempotencyKey(
      input.accountId,
      input.idempotencyKey,
    );
    if (winner) return replay(winner);
    if (err instanceof LiveSubscriptionExistsError) {
      return { kind: "live_subscription_exists" };
    }
    throw err;
  }

  const payment = await payments.createPayment(paymentInput(record, input));
  await repo.recordPayment(record.invoiceId, payment.providerRef, record.totalCents);
  return { kind: "created", record, payment };
}

function paymentInput(record: CheckoutRecord, input: SubscribeInput) {
  return {
    accountId: input.accountId,
    invoiceId: record.invoiceId,
    amountCents: record.totalCents,
    currency: record.currency,
    idempotencyKey: input.idempotencyKey,
  };
}

const UUID_PATTERN =
  "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";

interface SubscriptionRoutesOptions {
  subscriptions: SubscriptionRepository;
  payments: PaymentProvider | undefined;
  clock: Clock;
  authenticate: Authenticate;
}

export function registerSubscriptionRoutes(
  app: FastifyInstance,
  { subscriptions, payments, clock, authenticate }: SubscriptionRoutesOptions,
): void {
  app.post<{ Body: { planPriceId: string } }>(
    "/subscriptions",
    {
      schema: {
        body: {
          type: "object",
          required: ["planPriceId"],
          additionalProperties: false,
          properties: {
            planPriceId: { type: "string", pattern: UUID_PATTERN },
          },
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
      if (accountId === null) {
        return reply.code(401).send({ error: "unauthorized" });
      }
      if (!payments) {
        return reply.code(503).send({ error: "payment_provider_unconfigured" });
      }

      let result: SubscribeResult;
      try {
        result = await subscribe(
          { repo: subscriptions, payments, clock },
          {
            accountId,
            planPriceId: req.body.planPriceId,
            idempotencyKey: String(req.headers["idempotency-key"]),
          },
        );
      } catch (err) {
        req.log.error({ err }, "checkout failed");
        // La souscription `pending` éventuelle est fermée au bout de 24 h ; un rejeu avec la même
        // clé reprend le paiement.
        return reply.code(502).send({ error: "payment_provider_error" });
      }

      switch (result.kind) {
        case "price_unavailable":
          return reply.code(422).send({ error: "price_unavailable" });
        case "live_subscription_exists":
          return reply.code(409).send({ error: "live_subscription_exists" });
        case "idempotency_key_reused":
          return reply.code(409).send({ error: "idempotency_key_reused" });
        case "created":
        case "replayed": {
          const { record, payment } = result;
          return reply.code(result.kind === "created" ? 201 : 200).send({
            subscription: { id: record.subscriptionId, status: record.status },
            invoice: {
              id: record.invoiceId,
              number: record.invoiceNumber,
              status: record.invoiceStatus,
              totalCents: record.totalCents,
              currency: record.currency,
            },
            payment,
          });
        }
      }
    },
  );
}

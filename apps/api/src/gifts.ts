import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { Authenticate } from "./catalog.js";
import type { Clock } from "./clock.js";
import type { PaymentDetails, PaymentProvider } from "./payments.js";
import type { SubscriptionRepository } from "./subscriptions.js";

export type GiftStatus = "awaiting_payment" | "pending" | "redeemed" | "expired" | "refunded";

/** 16 octets aléatoires = 128 bits, en base64url (22 caractères) : non devinable. */
export function generateGiftCode(): string {
  return randomBytes(16).toString("base64url");
}

export interface CreateGiftInput {
  purchaserAccountId: string;
  planPriceId: string;
  durationPeriods: number;
  recipientEmail: string | null;
  idempotencyKey: string;
  code: string;
  /** Prix d'une période ; le total facturé est `amountCents × durationPeriods`. */
  amountCents: number;
  currency: string;
  now: Date;
}

export interface GiftCheckout {
  giftId: string;
  status: GiftStatus;
  planPriceId: string;
  durationPeriods: number;
  invoiceId: string;
  invoiceNumber: string;
  invoiceStatus: string;
  totalCents: number;
  currency: string;
}

export interface GiftSummary {
  id: string;
  status: GiftStatus;
  planPriceId: string;
  durationPeriods: number;
  recipientEmail: string | null;
  expiresAt: Date | null;
  redeemedAt: Date | null;
  /** Rempli seulement pour un cadeau encore utilisable. */
  code: string | null;
}

export interface GiftNotification {
  giftId: string;
  code: string;
  recipientEmail: string;
  planName: string;
  durationPeriods: number;
  expiresAt: Date;
}

/** Même (offrant, clé d'idempotence) déjà utilisé : une requête concurrente a gagné. */
export class DuplicateGiftKeyError extends Error {
  constructor() {
    super("gift idempotency key already used");
  }
}

export interface GiftRepository {
  findByIdempotencyKey(accountId: string, key: string): Promise<GiftCheckout | null>;
  /**
   * Crée atomiquement le cadeau `awaiting_payment`, sa facture `open` (au nom de l'offrant) et la ligne.
   * Lève `DuplicateGiftKeyError`.
   */
  create(input: CreateGiftInput): Promise<GiftCheckout>;
  listForPurchaser(accountId: string): Promise<GiftSummary[]>;
  /** Cadeau payé, avec destinataire, pas encore notifié, lié à ce paiement. `null` sinon. */
  findNotification(providerRef: string): Promise<GiftNotification | null>;
  markNotified(giftId: string, at: Date): Promise<void>;
  /**
   * Échange atomique : cadeau `pending` non périmé et compte sans abonnement vivant → abonnement `active` sur
   * toute la durée offerte (annulation programmée à son terme), cadeau `redeemed`. Un seul échange réussit si le
   * même code est présenté en parallèle.
   */
  redeem(input: { code: string; accountId: string; now: Date }): Promise<RedeemResult>;
  /** `pending` dont la validité est dépassée → `expired`. Retourne leur nombre ; rejouable. */
  expireStale(now: Date): Promise<number>;
}

/** Tentatives d'échange par minute et par client (toutes issues confondues). */
const REDEEM_ATTEMPTS_PER_MINUTE = 10;

const UUID_PATTERN =
  "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";
const EMAIL_PATTERN = "^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$";

interface GiftRoutesOptions {
  gifts: GiftRepository;
  subscriptions: SubscriptionRepository;
  payments: PaymentProvider | undefined;
  clock: Clock;
  authenticate: Authenticate;
  newCode: () => string;
}

interface PurchaseInput {
  accountId: string;
  planPriceId: string;
  durationPeriods: number;
  recipientEmail: string | null;
  idempotencyKey: string;
}

type PurchaseResult =
  | { kind: "created" | "replayed"; record: GiftCheckout; payment: PaymentDetails | null }
  | { kind: "price_unavailable" | "idempotency_key_reused" };

export function registerGiftRoutes(
  app: FastifyInstance,
  { gifts, subscriptions, payments, clock, authenticate, newCode }: GiftRoutesOptions,
): void {
  async function purchase(provider: PaymentProvider, input: PurchaseInput): Promise<PurchaseResult> {
    // Espace de clés distinct du checkout côté fournisseur.
    const providerKey = `gift:${input.idempotencyKey}`;

    const replay = async (record: GiftCheckout): Promise<PurchaseResult> => {
      if (
        record.planPriceId !== input.planPriceId ||
        record.durationPeriods !== input.durationPeriods
      ) {
        return { kind: "idempotency_key_reused" };
      }
      const payment =
        record.invoiceStatus === "open"
          ? await provider.createPayment({
              accountId: input.accountId,
              invoiceId: record.invoiceId,
              amountCents: record.totalCents,
              currency: record.currency,
              idempotencyKey: providerKey,
            })
          : null;
      return { kind: "replayed", record, payment };
    };

    const existing = await gifts.findByIdempotencyKey(input.accountId, input.idempotencyKey);
    if (existing) return replay(existing);

    const price = await subscriptions.findPlanPrice(input.planPriceId);
    if (!price?.active) return { kind: "price_unavailable" };

    let record: GiftCheckout;
    try {
      record = await gifts.create({
        purchaserAccountId: input.accountId,
        planPriceId: price.id,
        durationPeriods: input.durationPeriods,
        recipientEmail: input.recipientEmail,
        idempotencyKey: input.idempotencyKey,
        code: newCode(),
        amountCents: price.amountCents,
        currency: price.currency,
        now: clock.now(),
      });
    } catch (err) {
      if (!(err instanceof DuplicateGiftKeyError)) throw err;
      // Course avec une requête de même clé : la clé existe désormais, c'est un rejeu.
      const winner = await gifts.findByIdempotencyKey(input.accountId, input.idempotencyKey);
      if (winner) return replay(winner);
      throw err;
    }

    const payment = await provider.createPayment({
      accountId: input.accountId,
      invoiceId: record.invoiceId,
      amountCents: record.totalCents,
      currency: record.currency,
      idempotencyKey: providerKey,
    });
    await subscriptions.recordPayment(record.invoiceId, payment.providerRef, record.totalCents);
    return { kind: "created", record, payment };
  }

  app.post<{
    Body: { planPriceId: string; durationPeriods: number; recipientEmail?: string };
  }>(
    "/gifts",
    {
      schema: {
        body: {
          type: "object",
          required: ["planPriceId", "durationPeriods"],
          additionalProperties: false,
          properties: {
            planPriceId: { type: "string", pattern: UUID_PATTERN },
            durationPeriods: { type: "integer", minimum: 1, maximum: 12 },
            recipientEmail: { type: "string", maxLength: 254, pattern: EMAIL_PATTERN },
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
      if (accountId === null) return reply.code(401).send({ error: "unauthorized" });
      if (!payments) {
        return reply.code(503).send({ error: "payment_provider_unconfigured" });
      }

      let result: PurchaseResult;
      try {
        result = await purchase(payments, {
          accountId,
          planPriceId: req.body.planPriceId,
          durationPeriods: req.body.durationPeriods,
          recipientEmail: req.body.recipientEmail ?? null,
          idempotencyKey: String(req.headers["idempotency-key"]),
        });
      } catch (err) {
        req.log.error({ err }, "gift purchase failed");
        // Le cadeau non payé est fermé au bout de 24 h ; un rejeu avec la même clé reprend le paiement.
        return reply.code(502).send({ error: "payment_provider_error" });
      }

      switch (result.kind) {
        case "price_unavailable":
          return reply.code(422).send({ error: "price_unavailable" });
        case "idempotency_key_reused":
          return reply.code(409).send({ error: "idempotency_key_reused" });
        case "created":
        case "replayed": {
          const { record, payment } = result;
          // Le code n'est jamais renvoyé ici : il n'existe qu'une fois le paiement confirmé.
          return reply.code(result.kind === "created" ? 201 : 200).send({
            gift: {
              id: record.giftId,
              status: record.status,
              planPriceId: record.planPriceId,
              durationPeriods: record.durationPeriods,
            },
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

  // Le code est dans le corps (jamais dans l'URL, que les journaux enregistrent). Chaque tentative est
  // comptée par une limite stricte par client, quel qu'en soit le résultat : deviner un code est coûteux.
  app.post<{ Body: { code: string } }>(
    "/gifts/redeem",
    {
      config: { rateLimit: { max: REDEEM_ATTEMPTS_PER_MINUTE, timeWindow: 60_000 } },
      schema: {
        body: {
          type: "object",
          required: ["code"],
          additionalProperties: false,
          properties: { code: { type: "string", minLength: 1, maxLength: 128 } },
        },
      },
    },
    async (req, reply) => {
      const accountId = await authenticate(req);
      if (accountId === null) return reply.code(401).send({ error: "unauthorized" });

      const result = await gifts.redeem({
        code: req.body.code,
        accountId,
        now: clock.now(),
      });
      switch (result.kind) {
        case "not_found":
          return reply.code(404).send({ error: "gift_not_found" });
        case "unavailable":
          return reply.code(410).send({ error: "gift_unavailable" });
        case "live_subscription":
          return reply.code(409).send({ error: "live_subscription_exists" });
        case "redeemed":
          return reply.code(201).send({
            subscription: {
              id: result.subscriptionId,
              status: "active",
              currentPeriodEnd: result.periodEnd,
              giftedUntil: result.periodEnd,
            },
          });
      }
    },
  );

  app.get("/gifts", async (req, reply) => {
    const accountId = await authenticate(req);
    if (accountId === null) return reply.code(401).send({ error: "unauthorized" });
    const list = await gifts.listForPurchaser(accountId);
    return {
      gifts: list.map((gift) => ({
        ...gift,
        // Le code n'est montré qu'à l'offrant, tant que le cadeau est utilisable.
        code: gift.status === "pending" ? gift.code : null,
      })),
    };
  });
}

export type RedeemResult =
  | { kind: "redeemed"; subscriptionId: string; periodStart: Date; periodEnd: Date }
  /** Code inconnu, ou cadeau pas encore payé : on ne révèle rien de plus. */
  | { kind: "not_found" }
  /** Déjà échangé, périmé ou remboursé. */
  | { kind: "unavailable" }
  /** Le compte a déjà un abonnement vivant : le cadeau reste utilisable. */
  | { kind: "live_subscription" };

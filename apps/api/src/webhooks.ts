import type { FastifyInstance } from "fastify";
import type { Clock } from "./clock.js";
import type { GiftRepository } from "./gifts.js";
import type { Mailer } from "./mailer.js";
import type { PaymentWebhookVerifier } from "./payments.js";
import type { SubscriptionRepository } from "./subscriptions.js";

interface WebhookRoutesOptions {
  subscriptions: SubscriptionRepository;
  verifier: PaymentWebhookVerifier | undefined;
  clock: Clock;
  /** Avec `mailer` : e-mail au destinataire quand un cadeau vient d'être payé. */
  gifts: GiftRepository | undefined;
  mailer: Mailer | undefined;
}

export function registerWebhookRoutes(
  app: FastifyInstance,
  { subscriptions, verifier, clock, gifts, mailer }: WebhookRoutesOptions,
): void {
  // Portée isolée : la signature porte sur les octets exacts reçus, le corps reste donc une chaîne
  // brute (le parseur JSON par défaut s'applique toujours aux autres routes).
  void app.register((scope, _opts, done) => {
    scope.addContentTypeParser(
      "application/json",
      { parseAs: "string" },
      (_req, body, parsed) => {
        parsed(null, body);
      },
    );

    scope.post("/webhooks/payments", async (req, reply) => {
      if (!verifier) {
        return reply.code(503).send({ error: "payment_provider_unconfigured" });
      }
      const now = clock.now();
      const event = verifier.parse(String(req.body), req.headers, now);
      if (event === null) {
        return reply.code(401).send({ error: "invalid_signature" });
      }
      if (event === "ignored") return { received: true };

      let outcome;
      try {
        outcome = await subscriptions.applyPaymentEvent(event, now);
      } catch (err) {
        // 500 : le fournisseur rejouera l'événement, qui n'a pas été enregistré (écriture atomique).
        req.log.error({ err, eventId: event.id }, "webhook processing failed");
        return reply.code(500).send({ error: "processing_failed" });
      }

      if (outcome === "unmatched" && event.type === "payment.succeeded") {
        // Paiement encaissé sans abonnement à activer (ex. checkout expiré) : à rembourser.
        req.log.error(
          { eventId: event.id, providerRef: event.providerRef },
          "payment_without_activation",
        );
      }

      if (outcome === "applied" && event.type === "payment.succeeded" && gifts && mailer) {
        // L'événement est déjà enregistré : un échec d'e-mail ne doit pas faire rejouer le webhook.
        // Le cadeau n'est marqué notifié qu'après l'envoi ; le code reste consultable par l'offrant
        // (`GET /gifts`). Jamais le code dans les journaux.
        try {
          const gift = await gifts.findNotification(event.providerRef);
          if (gift) {
            await mailer.sendGiftEmail({
              to: gift.recipientEmail,
              code: gift.code,
              planName: gift.planName,
              durationPeriods: gift.durationPeriods,
              expiresAt: gift.expiresAt,
            });
            await gifts.markNotified(gift.giftId, now);
          }
        } catch (err) {
          req.log.error({ err, eventId: event.id }, "gift notification failed");
        }
      }
      return { received: true };
    });
    done();
  });
}

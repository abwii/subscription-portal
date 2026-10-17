import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import type { CatalogRepository } from "./catalog.js";
import type { InvoiceDetail, InvoiceRepository } from "./invoices.js";
import type { PaymentProvider } from "./payments.js";
import type { SubscriptionRepository } from "./subscriptions.js";

const ID = "11111111-1111-4111-8111-111111111111";

const invoice = (status: string): InvoiceDetail => ({
  id: ID,
  number: "INV-000001",
  status,
  totalCents: 1999,
  currency: "EUR",
  issuedAt: new Date("2026-10-17T12:00:00Z"),
  paidAt: null,
  lines: [],
});

describe("POST /invoices/:id/pay", () => {
  const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
  const make = async (opts: {
    found?: InvoiceDetail | null;
    payments?: PaymentProvider | null;
    accountId?: string | null;
    recorded?: [string, string, number][];
  }) => {
    const recorded = opts.recorded ?? [];
    const app = await buildApp({
      db: { ping: () => Promise.resolve() },
      catalog: {} as CatalogRepository,
      subscriptions: {
        recordPayment: (invoiceId: string, ref: string, amount: number) => {
          recorded.push([invoiceId, ref, amount]);
          return Promise.resolve();
        },
      } as unknown as SubscriptionRepository,
      invoices: {
        findInvoice: (accountId: string, id: string) => {
          expect([accountId, id]).toEqual(["acc-1", ID]);
          return Promise.resolve(opts.found === undefined ? invoice("open") : opts.found);
        },
      } as unknown as InvoiceRepository,
      ...(opts.payments === null
        ? {}
        : {
            payments: opts.payments ?? {
              createPayment: (input) =>
                Promise.resolve({
                  providerRef: `pi_${input.invoiceId}`,
                  clientSecret: `secret_${input.idempotencyKey}`,
                }),
            },
          }),
      authenticate: () =>
        Promise.resolve(opts.accountId === undefined ? "acc-1" : opts.accountId),
      logger: false,
    });
    apps.push(app);
    return app;
  };
  const pay = (app: Awaited<ReturnType<typeof buildApp>>, id = ID) =>
    app.inject({ method: "POST", url: `/invoices/${id}/pay` });
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  it("creates a payment for an open invoice, with a stable provider key", async () => {
    const recorded: [string, string, number][] = [];
    const app = await make({ recorded });
    const res = await pay(app);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      payment: { providerRef: `pi_${ID}`, clientSecret: `secret_invoice:${ID}` },
    });
    expect(recorded).toEqual([[ID, `pi_${ID}`, 1999]]);
    // appel répété : même clé fournisseur, donc même paiement
    expect((await pay(app)).json()).toEqual(res.json());
  });

  it.each(["paid", "void", "draft", "uncollectible"])("returns 409 for a %s invoice", async (status) => {
    const res = await pay(await make({ found: invoice(status) }));
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: "invoice_not_open" });
  });

  it("returns 404 for an unknown or foreign invoice and a bad id; 401 when anonymous; 503 without provider", async () => {
    expect((await pay(await make({ found: null }))).statusCode).toBe(404);
    expect((await pay(await make({}), "not-a-uuid")).statusCode).toBe(404);
    expect((await pay(await make({ accountId: null }))).statusCode).toBe(401);
    expect((await pay(await make({ payments: null }))).statusCode).toBe(503);
  });

  it("returns 502 without leaking the cause when the provider fails", async () => {
    const res = await pay(
      await make({ payments: { createPayment: () => Promise.reject(new Error("boom")) } }),
    );
    expect(res.statusCode).toBe(502);
    expect(res.body).not.toContain("boom");
  });
});

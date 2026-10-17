import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import type { CatalogRepository } from "./catalog.js";
import type { InvoiceDetail, InvoiceRepository, InvoiceSummary } from "./invoices.js";
import type { SubscriptionRepository } from "./subscriptions.js";

const ID = "11111111-1111-4111-8111-111111111111";

const summary: InvoiceSummary = {
  id: ID,
  number: "INV-000001",
  status: "paid",
  totalCents: 1999,
  currency: "EUR",
  issuedAt: new Date("2026-10-17T12:00:00Z"),
  paidAt: new Date("2026-10-17T12:05:00Z"),
};
const detail: InvoiceDetail = {
  ...summary,
  lines: [
    {
      type: "plan",
      description: "Abonnement",
      amountCents: 1999,
      periodStart: null,
      periodEnd: null,
    },
  ],
};

describe("invoice routes", () => {
  const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
  const make = async (
    repo: Partial<InvoiceRepository>,
    accountId: string | null = "acc-1",
  ) => {
    const app = await buildApp({
      db: { ping: () => Promise.resolve() },
      catalog: {} as CatalogRepository,
      subscriptions: {} as SubscriptionRepository,
      invoices: repo as InvoiceRepository,
      authenticate: () => Promise.resolve(accountId),
      logger: false,
    });
    apps.push(app);
    return app;
  };
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  it("lists only the invoices of the authenticated account", async () => {
    const asked: string[] = [];
    const app = await make({
      listInvoices: (accountId) => {
        asked.push(accountId);
        return Promise.resolve([summary]);
      },
    });
    const res = await app.inject({ method: "GET", url: "/invoices" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      invoices: [
        {
          ...summary,
          issuedAt: "2026-10-17T12:00:00.000Z",
          paidAt: "2026-10-17T12:05:00.000Z",
        },
      ],
    });
    expect(asked).toEqual(["acc-1"]);
  });

  it("returns an invoice with its lines", async () => {
    const app = await make({
      findInvoice: (accountId, id) => {
        expect([accountId, id]).toEqual(["acc-1", ID]);
        return Promise.resolve(detail);
      },
    });
    const res = await app.inject({ method: "GET", url: `/invoices/${ID}` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      invoice: { number: "INV-000001", lines: [{ amountCents: 1999 }] },
    });
  });

  it("returns 404 for another account's invoice (not 403: its existence stays hidden)", async () => {
    const app = await make({ findInvoice: () => Promise.resolve(null) });
    const res = await app.inject({ method: "GET", url: `/invoices/${ID}` });
    expect(res.statusCode).toBe(404);
  });

  it("returns 404 for an id that is not a uuid, without querying", async () => {
    const app = await make({
      findInvoice: () => Promise.reject(new Error("must not be called")),
    });
    const res = await app.inject({ method: "GET", url: "/invoices/not-a-uuid" });
    expect(res.statusCode).toBe(404);
  });

  it("returns 401 without an authenticated account", async () => {
    const app = await make({}, null);
    expect((await app.inject({ method: "GET", url: "/invoices" })).statusCode).toBe(401);
    expect(
      (await app.inject({ method: "GET", url: `/invoices/${ID}` })).statusCode,
    ).toBe(401);
  });
});

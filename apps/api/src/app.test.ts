import { afterEach, describe, expect, it } from "vitest";
import { buildApp, type Database } from "./app.js";
import type { CatalogRepository } from "./catalog.js";
import type { InvoiceRepository } from "./invoices.js";
import type { SubscriptionRepository } from "./subscriptions.js";

const noCatalog = {} as CatalogRepository;
const noSubs = {} as SubscriptionRepository;
const noInvoices = {} as InvoiceRepository;
const healthyDb: Database = { ping: () => Promise.resolve() };
const brokenDb: Database = {
  ping: () => Promise.reject(new Error("connection refused")),
};

describe("api", () => {
  const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
  const make = async (db: Database) => {
    const app = await buildApp({ db, catalog: noCatalog, subscriptions: noSubs, invoices: noInvoices, logger: false });
    apps.push(app);
    return app;
  };
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  it("GET /health returns 200 without touching the database", async () => {
    const app = await make(brokenDb);
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
  });

  it("rate-limits routes but never the health probes", async () => {
    const app = await buildApp({
      db: healthyDb,
      catalog: { listPlans: () => Promise.resolve([]) } as unknown as CatalogRepository,
      subscriptions: noSubs,
      invoices: noInvoices,
      rateLimit: { max: 2, timeWindowMs: 60_000 },
      logger: false,
    });
    apps.push(app);
    const codes: number[] = [];
    for (let i = 0; i < 4; i++) {
      codes.push((await app.inject({ method: "GET", url: "/plans" })).statusCode);
    }
    expect(codes).toEqual([200, 200, 429, 429]);
    for (let i = 0; i < 5; i++) {
      expect((await app.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
      expect((await app.inject({ method: "GET", url: "/ready" })).statusCode).toBe(200);
    }
  });

  it("GET /ready returns 200 when the database answers", async () => {
    const app = await make(healthyDb);
    const res = await app.inject({ method: "GET", url: "/ready" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ready" });
  });

  it("GET /ready returns 503 and hides the error when the database is down", async () => {
    const app = await make(brokenDb);
    const res = await app.inject({ method: "GET", url: "/ready" });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ status: "unavailable" });
    expect(res.body).not.toContain("refused");
  });
});

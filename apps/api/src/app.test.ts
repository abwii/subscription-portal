import { afterEach, describe, expect, it } from "vitest";
import { buildApp, type Database } from "./app.js";

const healthyDb: Database = { ping: () => Promise.resolve() };
const brokenDb: Database = {
  ping: () => Promise.reject(new Error("connection refused")),
};

describe("api", () => {
  const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
  const make = async (db: Database) => {
    const app = await buildApp({ db, logger: false });
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

import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

const valid = { DATABASE_URL: "postgres://u:p@localhost:5432/db" };

describe("loadConfig", () => {
  it("applies defaults for port and host", () => {
    expect(loadConfig(valid)).toEqual({
      databaseUrl: valid.DATABASE_URL,
      port: 3001,
      host: "0.0.0.0",
      devAuth: false,
      trustProxy: false,
      paymentProvider: "none",
      mailer: "none",
    });
  });

  it("reads PORT and HOST overrides", () => {
    const config = loadConfig({ ...valid, PORT: "4000", HOST: "127.0.0.1" });
    expect(config.port).toBe(4000);
    expect(config.host).toBe("127.0.0.1");
  });

  it("throws when DATABASE_URL is missing", () => {
    expect(() => loadConfig({})).toThrow(/DATABASE_URL/);
  });

  it("throws when PORT is not a valid port", () => {
    expect(() => loadConfig({ ...valid, PORT: "abc" })).toThrow(/PORT/);
    expect(() => loadConfig({ ...valid, PORT: "70000" })).toThrow(/PORT/);
  });

  it("enables the dev header authentication only when DEV_AUTH=true", () => {
    expect(loadConfig({ ...valid, DEV_AUTH: "true" }).devAuth).toBe(true);
    expect(loadConfig({ ...valid, DEV_AUTH: "false" }).devAuth).toBe(false);
  });

  it("refuses DEV_AUTH=true in production", () => {
    expect(() =>
      loadConfig({ ...valid, DEV_AUTH: "true", NODE_ENV: "production" }),
    ).toThrow(/DEV_AUTH/);
  });

  it("enables trustProxy only when TRUST_PROXY=true", () => {
    expect(loadConfig({ ...valid, TRUST_PROXY: "true" }).trustProxy).toBe(true);
    expect(loadConfig(valid).trustProxy).toBe(false);
  });

  it("selects the payment provider with PAYMENT_PROVIDER", () => {
    expect(loadConfig({ ...valid, PAYMENT_PROVIDER: "fake" }).paymentProvider).toBe(
      "fake",
    );
    expect(() => loadConfig({ ...valid, PAYMENT_PROVIDER: "nope" })).toThrow(
      /PAYMENT_PROVIDER/,
    );
  });

  it("refuses the fake payment provider in production", () => {
    expect(() =>
      loadConfig({ ...valid, PAYMENT_PROVIDER: "fake", NODE_ENV: "production" }),
    ).toThrow(/PAYMENT_PROVIDER/);
  });

  it("requires both Stripe secrets with PAYMENT_PROVIDER=stripe", () => {
    const stripe = { ...valid, PAYMENT_PROVIDER: "stripe" };
    expect(() => loadConfig(stripe)).toThrow(/STRIPE_SECRET_KEY/);
    expect(() => loadConfig({ ...stripe, STRIPE_SECRET_KEY: "sk_test_x" })).toThrow(
      /STRIPE_WEBHOOK_SECRET/,
    );
    const config = loadConfig({
      ...stripe,
      STRIPE_SECRET_KEY: "sk_test_x",
      STRIPE_WEBHOOK_SECRET: "whsec_x",
      NODE_ENV: "production",
    });
    expect(config).toMatchObject({
      paymentProvider: "stripe",
      stripeSecretKey: "sk_test_x",
      stripeWebhookSecret: "whsec_x",
    });
  });

  it("selects the mailer with MAILER and refuses the console mailer in production", () => {
    expect(loadConfig(valid).mailer).toBe("none");
    expect(loadConfig({ ...valid, MAILER: "console" }).mailer).toBe("console");
    expect(() => loadConfig({ ...valid, MAILER: "smtp" })).toThrow(/MAILER/);
    expect(() => loadConfig({ ...valid, MAILER: "console", NODE_ENV: "production" })).toThrow(
      /MAILER/,
    );
  });
});

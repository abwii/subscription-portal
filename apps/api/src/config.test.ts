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
});

import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

const valid = { DATABASE_URL: "postgres://u:p@localhost:5432/db" };

describe("loadConfig", () => {
  it("applies defaults for port and host", () => {
    expect(loadConfig(valid)).toEqual({
      databaseUrl: valid.DATABASE_URL,
      port: 3001,
      host: "0.0.0.0",
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
});

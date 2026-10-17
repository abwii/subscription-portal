import { describe, expect, it } from "vitest";
import { createAuthenticate } from "./auth.js";

const id = "00000000-0000-4000-8000-000000000001";

describe("createAuthenticate", () => {
  it("rejects everything when dev auth is disabled", async () => {
    const authenticate = createAuthenticate({ devAuth: false });
    expect(await authenticate({ headers: { "x-account-id": id } })).toBeNull();
  });

  it("reads the account id from X-Account-Id when dev auth is enabled", async () => {
    const authenticate = createAuthenticate({ devAuth: true });
    expect(await authenticate({ headers: { "x-account-id": id } })).toBe(id);
  });

  it("rejects a missing or malformed header", async () => {
    const authenticate = createAuthenticate({ devAuth: true });
    expect(await authenticate({ headers: {} })).toBeNull();
    expect(
      await authenticate({ headers: { "x-account-id": "'; DROP TABLE" } }),
    ).toBeNull();
    expect(await authenticate({ headers: { "x-account-id": [id, id] } })).toBeNull();
  });
});

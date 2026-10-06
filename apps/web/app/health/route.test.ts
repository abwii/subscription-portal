import { describe, expect, it } from "vitest";
import { GET } from "./route";

describe("GET /health", () => {
  it("returns 200 with status ok", async () => {
    const res = GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  it("is never cached", () => {
    expect(GET().headers.get("cache-control")).toBe("no-store");
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { verifyDatadogCredentials } from "../preflight.js";
import { ctxWith, makeHttp } from "./helpers.js";

describe("verifyDatadogCredentials", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("dates each probe when it runs, not when the module loaded", async () => {
    // Years past any date this module could have been loaded on.
    const now = Date.parse("2031-05-20T10:30:00Z");
    vi.useFakeTimers({ now, toFake: ["Date"] });
    const { http, calls } = makeHttp(() => ({ body: {} }));

    await verifyDatadogCredentials(ctxWith(http));

    const param = (path: string, name: string) =>
      calls.find((c) => c.url.pathname === path)?.url.searchParams.get(name);
    expect(param("/api/v2/usage/estimated_cost", "start_month")).toBe("2031-05");
    expect(param("/api/v2/usage/hourly_usage", "filter[timestamp][start]")).toBe("2031-05-20T08");
    const nowS = now / 1000;
    expect(param("/api/v1/query", "from")).toBe(String(nowS - 300));
    expect(param("/api/v1/query", "to")).toBe(String(nowS));
    expect(param("/api/v1/metrics", "from")).toBe(String(nowS - 300));
  });
});

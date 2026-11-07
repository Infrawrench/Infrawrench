import { hostClient } from "@infrawrench/plugin-base/effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SplunkObservabilityClient } from "../client.js";
import { CREDS, makeHttp } from "./helpers.js";
import type { Reply } from "./helpers.js";

const UNREAD_HOOK = Symbol.for("infrawrench.unreadListPart");

/** Any route the test did not plan for fails the test instead of answering. */
function strictHttp(route: (url: URL, method: string, body: unknown) => Reply | undefined) {
  return makeHttp((url, method, body) => {
    const reply = route(url, method, body);
    if (!reply) throw new Error(`unexpected request ${method} ${url.href}`);
    return reply;
  });
}

function rows(n: number, from: number, prefix = "D") {
  return Array.from({ length: n }, (_, i) => ({
    id: `${prefix}${from + i}`,
    name: `n${from + i}`,
  }));
}

const offsetOf = (url: URL) => Number(url.searchParams.get("offset"));
const limitOf = (url: URL) => Number(url.searchParams.get("limit"));

beforeEach(() => {
  vi.stubGlobal("fetch", () => {
    throw new Error("no real provider traffic");
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  Reflect.deleteProperty(globalThis, UNREAD_HOOK);
});

describe("offset lists", () => {
  it("refuses a list that never ends, after exactly the page cap", async () => {
    const { http, calls } = strictHttp((url) =>
      url.pathname === "/v2/detector"
        ? { body: { results: rows(limitOf(url), offsetOf(url)) } }
        : undefined,
    );
    const client = hostClient(new SplunkObservabilityClient(CREDS, { http }));
    await expect(client.listResources("detector", "acct")).rejects.toThrow(
      "has more than Infrawrench reads",
    );
    expect(calls).toHaveLength(100);
  });

  it("refuses a list cut at Splunk's 10,000-object ceiling", async () => {
    const { http } = strictHttp((url) => {
      if (url.pathname !== "/v2/detector") return undefined;
      const offset = offsetOf(url);
      const n = Math.max(0, Math.min(limitOf(url), 10_000 - offset));
      return { body: { count: 12_000, results: rows(n, offset) } };
    });
    const client = hostClient(new SplunkObservabilityClient(CREDS, { http }));
    await expect(client.listResources("detector", "acct")).rejects.toThrow(
      "has more than Infrawrench reads",
    );
  });

  it("keeps reading while the count says more, when a page comes back shorter than asked", async () => {
    const all = rows(250, 0);
    const { http } = strictHttp((url) =>
      url.pathname === "/v2/team"
        ? { body: { count: 250, results: all.slice(offsetOf(url), offsetOf(url) + 100) } }
        : undefined,
    );
    const client = hostClient(new SplunkObservabilityClient(CREDS, { http }));
    const list = await client.listResources("team", "acct");
    expect(list.map((r) => r.externalId)).toEqual(all.map((r) => r.id));
  });

  it("refuses a page whose list is renamed, first or later", async () => {
    const first = strictHttp((url) =>
      url.pathname === "/v2/team" ? { body: { count: 3, items: rows(3, 0) } } : undefined,
    );
    await expect(
      hostClient(new SplunkObservabilityClient(CREDS, { http: first.http })).listResources(
        "team",
        "acct",
      ),
    ).rejects.toThrow("is not a list");

    const later = strictHttp((url) =>
      url.pathname === "/v2/team"
        ? offsetOf(url) === 0
          ? { body: { count: 1500, results: rows(1000, 0) } }
          : { body: { count: 1500, error: "busy" } }
        : undefined,
    );
    await expect(
      hostClient(new SplunkObservabilityClient(CREDS, { http: later.http })).listResources(
        "team",
        "acct",
      ),
    ).rejects.toThrow("is not a list");
  });

  it("sends list reads through the host's HTTP service, with no CA and no fetch", async () => {
    const fetchStub = vi.fn(() => {
      throw new Error("no real provider traffic");
    });
    vi.stubGlobal("fetch", fetchStub);
    const { http, calls } = strictHttp((url) =>
      url.pathname === "/v2/team" ? { body: { count: 1, results: rows(1, 0) } } : undefined,
    );
    const request = vi.spyOn(http, "request");
    await hostClient(new SplunkObservabilityClient(CREDS, { http })).listResources("team", "acct");
    expect(calls).toHaveLength(1);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]?.[0]).not.toHaveProperty("caCert");
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it("does not read chart owners as none when the dashboard list is cut short", async () => {
    const { http } = strictHttp((url) => {
      if (url.pathname === "/v2/chart") return { body: { count: 1, results: rows(1, 0, "C") } };
      if (url.pathname === "/v2/dashboard")
        return { body: { results: rows(limitOf(url), offsetOf(url), "B") } };
      return undefined;
    });
    const client = hostClient(new SplunkObservabilityClient(CREDS, { http }));
    await expect(client.listResources("chart", "acct")).rejects.toThrow(
      "has more than Infrawrench reads",
    );
  });
});

describe("synthetic tests", () => {
  it("refuses a list that never ends, after exactly the page cap", async () => {
    const { http, calls } = strictHttp((url) => {
      if (url.pathname !== "/v2/synthetics/tests") return undefined;
      const page = Number(url.searchParams.get("page"));
      const perPage = Number(url.searchParams.get("perPage"));
      return {
        body: {
          tests: Array.from({ length: perPage }, (_, i) => ({
            id: (page - 1) * perPage + i + 1,
            name: "t",
          })),
        },
      };
    });
    await expect(
      hostClient(new SplunkObservabilityClient(CREDS, { http })).listResources(
        "synthetic-test",
        "acct",
      ),
    ).rejects.toThrow("has more than Infrawrench reads");
    expect(calls).toHaveLength(100);
  });

  it("refuses a page with no tests list", async () => {
    const { http } = strictHttp((url) =>
      url.pathname === "/v2/synthetics/tests" ? { body: { totalCount: 4 } } : undefined,
    );
    await expect(
      hostClient(new SplunkObservabilityClient(CREDS, { http })).listResources(
        "synthetic-test",
        "acct",
      ),
    ).rejects.toThrow("is not a list");
  });
});

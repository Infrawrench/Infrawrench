import type { UnreadListPart } from "@infrawrench/plugin-base";
import { hostClient } from "@infrawrench/plugin-base/effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CoreWeaveClient } from "../client.js";
import { fetchCoreWeaveCostData } from "../cost-data.js";
import { fetchFocusRows } from "../focus.js";
import { gpuHourSeries } from "../metrics.js";
import { listAccessKeys, listBuckets } from "../object-storage.js";
import { parseNegotiatedRates } from "../rates.js";

type Answer = { status?: number; body: object | string };

/** A fetch that answers only what a test names, and throws on anything else. */
function stubFetch(answer: (url: URL) => Answer | undefined): URL[] {
  const seen: URL[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (raw: string) => {
      const url = new URL(raw);
      seen.push(url);
      const reply = answer(url);
      if (!reply) throw new Error(`unexpected request to ${raw}`);
      const body = typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body);
      return new Response(body, { status: reply.status ?? 200 });
    }),
  );
  return seen;
}

const CTX = { token: "t" };
const fullPage = (n = 1000) => Array.from({ length: n }, (_, i) => ({ name: `row-${i}` }));

afterEach(() => vi.unstubAllGlobals());

describe.each([
  ["buckets", "/v1/cwobject/bucket-info", listBuckets],
  ["access keys", "/v1/cwobject/access-key", listAccessKeys],
])("listing %s", (_name, path, list) => {
  it("reads every page and stops at a short one", async () => {
    const seen = stubFetch((url) => {
      if (url.pathname !== path) return undefined;
      return { body: { info: fullPage(url.searchParams.get("offset") === "0" ? 1000 : 3) } };
    });
    await expect(list(CTX)).resolves.toHaveLength(1003);
    expect(seen.map((u) => u.searchParams.get("offset"))).toEqual(["0", "1000"]);
    expect(seen[0]?.searchParams.get("limit")).toBe("1000");
  });

  it("throws at the cap instead of returning part of the list", async () => {
    const seen = stubFetch((url) =>
      url.pathname === path ? { body: { info: fullPage() } } : undefined,
    );
    await expect(list(CTX)).rejects.toThrow("has more than Infrawrench reads");
    expect(seen).toHaveLength(50);
  });

  it("reads an answer with no list at all as empty, as proto3 JSON writes one", async () => {
    stubFetch(() => ({ body: {} }));
    await expect(list(CTX)).resolves.toEqual([]);
  });

  it("refuses a renamed key on the first page", async () => {
    stubFetch(() => ({ body: { rows: fullPage() } }));
    await expect(list(CTX)).rejects.toThrow("is not a list");
  });

  it("refuses a renamed key on a later page", async () => {
    stubFetch((url) => ({
      body: url.searchParams.get("offset") === "0" ? { info: fullPage() } : { rows: fullPage() },
    }));
    await expect(list(CTX)).rejects.toThrow("is not a list");
  });

  it("refuses a list that is not an array", async () => {
    stubFetch(() => ({ body: { info: "nope" } }));
    await expect(list(CTX)).rejects.toThrow("is not a list");
  });
});

describe("the sync's read of buckets and access keys", () => {
  it("carries a truncated list out of listResources as a failure", async () => {
    stubFetch(() => ({ body: { info: fullPage() } }));
    const client = hostClient(new CoreWeaveClient({ apiToken: "t" }));
    await expect(client.listResources("bucket", "acc")).rejects.toThrow(
      "has more than Infrawrench reads",
    );
    await expect(client.listResources("access-key", "acc")).rejects.toThrow(
      "has more than Infrawrench reads",
    );
  });
});

describe("the FOCUS export", () => {
  const QUERY = {
    startTime: "2026-09-01T00:00:00Z",
    endTime: "2026-09-02T00:00:00Z",
    groupBy: "location",
  } as const;
  const endless = (url: URL): Answer | undefined =>
    url.pathname === "/v1/billing/focus"
      ? { body: { data: [{ SkuId: "s" }], next_page_token: "more" } }
      : undefined;

  it("throws at the page cap instead of returning part of a window", async () => {
    const seen = stubFetch(endless);
    await expect(fetchFocusRows(CTX, QUERY)).rejects.toThrow("has more than Infrawrench reads");
    expect(seen).toHaveLength(500);
  });

  it("fails a cost read that hits the cap", async () => {
    stubFetch(endless);
    await expect(
      fetchCoreWeaveCostData(
        CTX,
        parseNegotiatedRates(""),
        { fromDate: "2026-09-01", toDate: "2026-09-02" },
        Date.parse("2026-10-01T00:00:00Z"),
      ),
    ).rejects.toThrow("has more than Infrawrench reads");
  });

  it("refuses a page with its rows under another key", async () => {
    stubFetch(() => ({ body: { rows: [{ SkuId: "s" }] } }));
    await expect(fetchFocusRows(CTX, QUERY)).rejects.toThrow("is not a list");
  });

  it("refuses a later page with its rows under another key", async () => {
    stubFetch((url) => ({
      body: url.searchParams.get("page_token")
        ? { rows: [] }
        : { data: [{ SkuId: "s" }], next_page_token: "more" },
    }));
    await expect(fetchFocusRows(CTX, QUERY)).rejects.toThrow("is not a list");
  });

  it("reads an empty page as the end of the rows", async () => {
    stubFetch(() => ({ body: { data: [], next_page_token: "" } }));
    await expect(fetchFocusRows(CTX, QUERY)).resolves.toEqual([]);
  });

  it("still charts what it read for a window past the cap", async () => {
    stubFetch((url) =>
      url.pathname === "/v1/billing/focus"
        ? {
            body: {
              data: [
                {
                  ChargePeriodStart: "2026-09-01T03:00:00Z",
                  PricingQuantity: 2,
                  PricingUnit: "GPU-Hour",
                  SkuId: "s",
                },
              ],
              next_page_token: "more",
            },
          }
        : undefined,
    );
    const [series] = await gpuHourSeries(CTX, {
      startMs: Date.parse("2026-09-01T00:00:00Z"),
      endMs: Date.parse("2026-09-02T00:00:00Z"),
    });
    expect(series?.points).toEqual([
      { timestamp: Date.parse("2026-09-01T00:00:00Z"), value: 1000 },
    ]);
  });
});

describe("the capacity plan view behind a cost read", () => {
  const RANGE = { fromDate: "2026-09-10", toDate: "2026-09-10" };
  const NOW = Date.parse("2026-10-01T00:00:00Z");
  const ROW = {
    ChargePeriodStart: "2026-09-10T03:00:00Z",
    PricingQuantity: 16,
    PricingUnit: "Instance-Hour",
    SkuId: "gd-8xh100ib-i128",
    x_ClusterId: "c-1",
  };
  const planAnswers = (plan: Answer) =>
    stubFetch((url) =>
      url.searchParams.get("group_by") === "location" ? { body: { data: [ROW] } } : plan,
    );

  it("fails on a throttle rather than re-pricing every row at the list rate", async () => {
    planAnswers({ status: 429, body: "slow down" });
    await expect(fetchCoreWeaveCostData(CTX, parseNegotiatedRates(""), RANGE, NOW)).rejects.toThrow(
      /429/,
    );
  });

  it("fails when the plan view is cut short", async () => {
    planAnswers({ body: { data: [ROW], next_page_token: "more" } });
    await expect(fetchCoreWeaveCostData(CTX, parseNegotiatedRates(""), RANGE, NOW)).rejects.toThrow(
      "has more than Infrawrench reads",
    );
  });

  it("reads the documented refusal as no plan split, keeping the usage", async () => {
    planAnswers({ status: 403, body: "forbidden" });
    const rows = await fetchCoreWeaveCostData(CTX, parseNegotiatedRates(""), RANGE, NOW);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.tags?.["capacityPlan"]).toBe("unattributed");
  });
});

/** The host's side of `reportUnreadListPart`, which a sync installs around a list. */
function trackUnread(): UnreadListPart[] {
  const parts: UnreadListPart[] = [];
  vi.stubGlobal(Symbol.for("infrawrench.unreadListPart"), (part: UnreadListPart) =>
    parts.push(part),
  );
  return parts;
}

describe("a token its provider refuses for a whole type", () => {
  const refused = () => stubFetch(() => ({ status: 403, body: "forbidden" }));

  it.each(["cks-cluster", "node-pool", "vpc", "bucket", "access-key"])(
    "keeps the stored %s rows without an error",
    async (typeId) => {
      refused();
      const parts = trackUnread();
      const client = hostClient(new CoreWeaveClient({ apiToken: "t" }));
      await expect(client.listResources(typeId, "acc")).resolves.toEqual([]);
      expect(parts).toEqual([{ idPrefixes: [""] }]);
    },
  );

  it("still shows the refusal on a host that keeps no track", async () => {
    refused();
    const client = hostClient(new CoreWeaveClient({ apiToken: "t" }));
    await expect(client.listResources("bucket", "acc")).rejects.toThrow(/403/);
  });

  it("fails the type on anything but a refusal", async () => {
    stubFetch(() => ({ status: 401, body: "bad token" }));
    const parts = trackUnread();
    const client = hostClient(new CoreWeaveClient({ apiToken: "t" }));
    await expect(client.listResources("bucket", "acc")).rejects.toThrow(/401/);
    expect(parts).toEqual([]);
  });
});

describe("Node Pools across clusters", () => {
  const cluster = (id: string, apiServerEndpoint?: string) => ({
    id,
    name: id,
    zone: "US-EAST-04A",
    ...(apiServerEndpoint ? { apiServerEndpoint } : {}),
  });
  const POOL = { metadata: { name: "p" }, spec: { instanceType: "gd-8xh100ib-i128" } };

  /** Cluster `good` answers with one pool; `bad` answers with whatever the test says. */
  const twoClusters = (bad: () => Answer) =>
    stubFetch((url) => {
      if (url.host === "api.coreweave.com" && url.pathname === "/v1beta1/cks/clusters") {
        return { body: { items: [cluster("good", "good.k8s"), cluster("bad", "bad.k8s")] } };
      }
      if (url.pathname !== "/apis/compute.coreweave.com/v1alpha1/nodepools") return undefined;
      return url.host === "good.k8s" ? { body: { items: [POOL] } } : bad();
    });
  const listPools = () =>
    hostClient(new CoreWeaveClient({ apiToken: "t" })).listResources("node-pool", "acc");

  it.each([
    ["a 5xx", 503],
    ["a refusal", 403],
  ])("keeps a cluster's stored pools through %s, and lists the others", async (_name, status) => {
    twoClusters(() => ({ status, body: "no" }));
    const parts = trackUnread();
    const rows = await listPools();
    expect(rows.map((r) => r.id)).toEqual(["acc:node-pool:good/p"]);
    expect(parts).toEqual([{ parentResourceIds: ["acc:cks-cluster:bad"] }]);
  });

  it("keeps the stored pools of a cluster it cannot connect to", async () => {
    twoClusters(() => {
      throw new TypeError("fetch failed");
    });
    const parts = trackUnread();
    const rows = await listPools();
    expect(rows.map((r) => r.id)).toEqual(["acc:node-pool:good/p"]);
    expect(parts).toEqual([{ parentResourceIds: ["acc:cks-cluster:bad"] }]);
  });

  it("keeps the stored pools of a cluster with no API server endpoint yet", async () => {
    stubFetch((url) =>
      url.pathname === "/v1beta1/cks/clusters" ? { body: { items: [cluster("new")] } } : undefined,
    );
    const parts = trackUnread();
    await expect(listPools()).resolves.toEqual([]);
    expect(parts).toEqual([{ parentResourceIds: ["acc:cks-cluster:new"] }]);
  });

  it("reports nothing when every cluster answered", async () => {
    twoClusters(() => ({ body: { items: [] } }));
    const parts = trackUnread();
    await expect(listPools()).resolves.toHaveLength(1);
    expect(parts).toEqual([]);
  });

  it("fails the type on a 2xx with no list, on every list path", async () => {
    twoClusters(() => ({ body: { error: "wrapped" } }));
    await expect(listPools()).rejects.toThrow("is not a list");
    const client = hostClient(new CoreWeaveClient({ apiToken: "t" }));
    await expect(client.listResources("cks-cluster", "acc")).rejects.toThrow("is not a list");
    await expect(client.listResources("instance-type", "acc")).rejects.toThrow("is not a list");
  });
});

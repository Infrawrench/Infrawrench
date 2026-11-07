import { hostClient } from "@infrawrench/plugin-base/effect";
import { describe, expect, it } from "vitest";
import { createConfluentContext } from "../api.js";
import { ConfluentCloudClient } from "../client.js";
import { fetchClusterUsage, fetchConnectorUsage } from "../metrics.js";
import { makeHttp } from "./helpers.js";
import type { Reply } from "./helpers.js";

interface QueryBody {
  aggregations: Array<{ metric: string }>;
  filter: { field?: string; value?: string; filters?: Array<{ value: string }> };
  group_by?: string[];
  granularity: string;
  intervals: string[];
  limit?: number;
}

function isQuery(body: unknown): body is QueryBody {
  return typeof body === "object" && body !== null && "aggregations" in body;
}

function usage(route: (url: URL, q: QueryBody) => Reply) {
  const { http, calls } = makeHttp((url, _method, body) => {
    if (url.hostname !== "api.telemetry.confluent.cloud" || !isQuery(body)) {
      throw new Error(`unexpected request: ${url.href}`);
    }
    return route(url, body);
  });
  return { ctx: createConfluentContext({ apiKey: "k", apiSecret: "s", http }), calls };
}

function filtered(q: QueryBody): string[] {
  return q.filter.filters ? q.filter.filters.map((f) => f.value) : [q.filter.value ?? ""];
}

/** What the document says the API does with `limit`: at most that many groups, default 100. */
function atMostLimit<T>(rows: T[], q: QueryBody): T[] {
  return rows.slice(0, q.limit ?? 100);
}

function topicQuery(q: QueryBody): boolean {
  return q.group_by?.includes("metric.topic") ?? false;
}

const ids = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix}-${i}`);

describe("topic counts (#480)", () => {
  /** 2,500 topics in one cluster, paged as the document says: only on a time-based granularity. */
  function pagedTopics() {
    const topics = ids("topic", 2500);
    return usage((url, q) => {
      if (!topicQuery(q)) return { body: { data: [] } };
      if (q.granularity === "ALL") {
        return {
          body: {
            data: atMostLimit(topics, q).map((t) => ({
              "resource.kafka.id": "lkc-1",
              "metric.topic": t,
              value: 1,
            })),
            meta: { pagination: { page_size: 1000 } },
          },
        };
      }
      const start = Number(url.searchParams.get("page_token") ?? 0);
      const end = start + (q.limit ?? 100);
      return {
        body: {
          // Two buckets a group, since an hour's interval crosses an hour boundary.
          data: topics.slice(start, end).flatMap((t) =>
            ["2026-09-01T10:00:00Z", "2026-09-01T11:00:00Z"].map((timestamp) => ({
              timestamp,
              "resource.kafka.id": "lkc-1",
              "metric.topic": t,
              value: 1,
            })),
          ),
          meta: {
            pagination: {
              page_size: q.limit,
              ...(end < topics.length ? { next_page_token: String(end) } : {}),
            },
          },
        },
      };
    });
  }

  it("counts every topic past the first 1,000 groups", async () => {
    const { ctx } = pagedTopics();
    const out = await fetchClusterUsage(ctx, ["lkc-1"]);
    expect(out.topics.get("lkc-1")).toBe(2500);
  });

  it("sends the same body for each page, with absolute times and the token", async () => {
    const { ctx, calls } = pagedTopics();
    await fetchClusterUsage(ctx, ["lkc-1"]);
    const pages = calls.filter((c) => isQuery(c.body) && topicQuery(c.body));
    expect(pages).toHaveLength(3);
    expect(pages.map((c) => c.url.searchParams.get("page_token"))).toEqual([null, "1000", "2000"]);
    for (const page of pages) expect(page.body).toEqual(pages[0]!.body);
    const body = pages[0]!.body;
    if (!isQuery(body)) throw new Error("not a query");
    expect(body.granularity).toBe("PT1H");
    expect(body.limit).toBe(1000);
    expect(body.intervals[0]).not.toContain("now");
  });

  it("does not report a low count when the pages never end", async () => {
    let n = 0;
    const { ctx, calls } = usage((_url, q) => {
      if (!topicQuery(q)) return { body: { data: [{ "resource.kafka.id": "lkc-1", value: 7 }] } };
      n++;
      return {
        body: {
          data: [{ "resource.kafka.id": "lkc-1", "metric.topic": `t-${n}`, value: 1 }],
          meta: { pagination: { page_size: 1000, next_page_token: `p${n}` } },
        },
      };
    });
    const out = await fetchClusterUsage(ctx, ["lkc-1"]);
    expect(out.topics.has("lkc-1")).toBe(false);
    expect(out.partitions.get("lkc-1")).toBe(7);
    expect(calls.filter((c) => isQuery(c.body) && topicQuery(c.body))).toHaveLength(100);
  });

  it("does not report a low count when a full page names no next one", async () => {
    const { ctx } = usage((_url, q) => {
      if (!topicQuery(q)) return { body: { data: [] } };
      return {
        body: {
          data: ids("t", 1000).map((t) => ({
            "resource.kafka.id": "lkc-1",
            "metric.topic": t,
            value: 1,
          })),
          meta: { pagination: { page_size: 1000 } },
        },
      };
    });
    const out = await fetchClusterUsage(ctx, ["lkc-1"]);
    expect(out.topics.has("lkc-1")).toBe(false);
  });

  it("does not report a low count when a later page fails", async () => {
    const { ctx } = usage((url, q) => {
      if (!topicQuery(q)) return { body: { data: [] } };
      if (url.searchParams.get("page_token")) return { status: 500, body: {} };
      return {
        body: {
          data: [{ "resource.kafka.id": "lkc-1", "metric.topic": "a", value: 1 }],
          meta: { pagination: { page_size: 1000, next_page_token: "p2" } },
        },
      };
    });
    const out = await fetchClusterUsage(ctx, ["lkc-1"]);
    expect(out.topics.has("lkc-1")).toBe(false);
  });

  it("gives a cluster with no topics a count of zero", async () => {
    const { ctx } = usage(() => ({ body: { data: [] } }));
    const out = await fetchClusterUsage(ctx, ["lkc-1"]);
    expect(out.topics.get("lkc-1")).toBe(0);
  });
});

describe("totals per resource (#480)", () => {
  const perResource = (field: string) => (_url: URL, q: QueryBody) => {
    if (topicQuery(q)) return { body: { data: [] } };
    return {
      body: {
        data: atMostLimit(filtered(q), q).map((id) => ({ [field]: id, value: 1 })),
      },
    };
  };

  it("reads every cluster's total past 1,000 clusters, a query per 1,000", async () => {
    const clusters = ids("lkc", 1500);
    const { ctx, calls } = usage(perResource("resource.kafka.id"));
    const out = await fetchClusterUsage(ctx, clusters);
    expect(out.partitions.size).toBe(1500);
    expect(out.retainedBytes.size).toBe(1500);
    expect(out.bytesIn.size).toBe(1500);
    expect(out.bytesOut.size).toBe(1500);
    const partitions = calls.flatMap((c) =>
      isQuery(c.body) && c.body.aggregations[0]!.metric.endsWith("partition_count")
        ? [filtered(c.body).length]
        : [],
    );
    expect(partitions).toEqual([1000, 500]);
  });

  it("reads every connector's records past 1,000 connectors", async () => {
    const connectors = ids("lcc", 1001);
    const { ctx } = usage(perResource("resource.connector.id"));
    const out = await fetchConnectorUsage(ctx, connectors);
    expect(out.known).toBe(true);
    expect(out.recordsIn.size).toBe(1001);
    expect(out.recordsOut.size).toBe(1001);
  });

  it("asks once for an account under the limit", async () => {
    const { ctx, calls } = usage(perResource("resource.connector.id"));
    await fetchConnectorUsage(ctx, ids("lcc", 3));
    expect(calls).toHaveLength(2);
  });

  it("knows nothing when one batch fails", async () => {
    let n = 0;
    const { ctx } = usage((_url, q) => {
      n++;
      if (n === 2) return { status: 500, body: {} };
      return {
        body: { data: filtered(q).map((id) => ({ "resource.connector.id": id, value: 1 })) },
      };
    });
    const out = await fetchConnectorUsage(ctx, ids("lcc", 1500));
    expect(out.known).toBe(false);
  });
});

describe("usage that is not known (#668)", () => {
  const CLUSTER = {
    id: "lkc-1",
    spec: { display_name: "c", config: { kind: "Basic" }, environment: { id: "env-1" } },
  };

  function client(telemetry: (q: QueryBody) => Reply) {
    const { http } = makeHttp((url, _method, body) => {
      if (url.hostname === "api.telemetry.confluent.cloud" && isQuery(body)) return telemetry(body);
      if (url.pathname === "/org/v2/environments") {
        return { body: { data: [{ id: "env-1" }], metadata: {} } };
      }
      if (url.pathname === "/cmk/v2/clusters") return { body: { data: [CLUSTER], metadata: {} } };
      if (url.pathname === "/cmk/v2/clusters/lkc-1") return { body: CLUSTER };
      throw new Error(`unexpected request: ${url.href}`);
    });
    return hostClient(new ConfluentCloudClient({ apiKey: "k", apiSecret: "s" }, { http }));
  }

  const failing = (suffix: string) => (q: QueryBody) =>
    !topicQuery(q) && q.aggregations[0]!.metric.endsWith(suffix)
      ? { status: 500, body: {} }
      : { body: { data: [] } };

  it.each([
    ["partition_count", "partitions"],
    ["retained_bytes", "retainedBytes"],
  ])("leaves a field unknown when its query, %s, failed", async (suffix, field) => {
    const c = client(failing(suffix));
    const [listed] = await c.listResources("kafka-cluster", "acc");
    expect(listed!.fields[field]).toBeUndefined();
    const read = await c.getResource("kafka-cluster", "acc:kafka-cluster:env-1/lkc-1", "acc");
    expect(read.fields[field]).toBeUndefined();
    expect(read.fields["topics"]).toBe(0);
  });

  it("still reads zero when a query succeeded with no rows", async () => {
    const c = client(() => ({ body: { data: [] } }));
    const [listed] = await c.listResources("kafka-cluster", "acc");
    expect(listed!.fields).toMatchObject({
      partitions: 0,
      retainedBytes: 0,
      bytesIn7d: 0,
      idle: "true",
    });
  });

  it("does not call a cluster idle on a 2xx with no data", async () => {
    const c = client((q) =>
      q.aggregations[0]!.metric.endsWith("received_bytes") ? { body: {} } : { body: { data: [] } },
    );
    const [listed] = await c.listResources("kafka-cluster", "acc");
    expect(listed!.fields["bytesIn7d"]).toBeUndefined();
    expect(listed!.fields["idle"]).toBeUndefined();
  });

  it("does not count zero topics on a 2xx with no data", async () => {
    const { ctx } = usage((_url, q) => (topicQuery(q) ? {} : { body: { data: [] } }));
    const out = await fetchClusterUsage(ctx, ["lkc-1"]);
    expect(out.topics.has("lkc-1")).toBe(false);
  });

  it("does not report connector records on a 2xx that is not a list", async () => {
    const { ctx } = usage(() => ({ body: { data: { errors: [] } } }));
    const out = await fetchConnectorUsage(ctx, ["lcc-1"]);
    expect(out.known).toBe(false);
  });

  it("does not fail the inventory over it, which an incomplete-list error would", async () => {
    const c = client(() => ({ body: {} }));
    await expect(c.listResources("kafka-cluster", "acc")).resolves.toHaveLength(1);
  });
});

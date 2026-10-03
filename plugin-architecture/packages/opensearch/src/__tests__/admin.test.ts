import { describe, expect, it, vi } from "vitest";
import type {
  DetailViewSchema,
  HostServices,
  ResourceInstance,
  SectionNode,
} from "@infrawrench/plugin-base";
import { OpenSearchClient } from "../client.js";

const BASE = "https://search.example.com:9200";

type Responder = (method: string, url: URL, body: unknown) => { status: number; body: unknown };

function host(responder: Responder) {
  const request = vi.fn(async (req: { url: string; method: string; body?: string }) => {
    const url = new URL(req.url);
    const r = responder(req.method, url, req.body ? JSON.parse(req.body) : undefined);
    return { status: r.status, headers: {}, body: JSON.stringify(r.body) };
  });
  return { services: { http: { request } } as unknown as HostServices, request };
}

function client(services: HostServices) {
  return new OpenSearchClient({ endpoint: BASE, username: "admin", password: "secret" }, services);
}

const CLUSTER: ResourceInstance = {
  id: "acct:opensearch-cluster:search.example.com:9200",
  pluginId: "opensearch",
  resourceTypeId: "opensearch-cluster",
  accountId: "acct",
  displayName: "cluster-a",
  fields: { endpoint: BASE },
  resolvedOutputs: {},
  secretStates: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const INDEX = {
  index: "logs-1",
  health: "green",
  status: "open",
  uuid: "u1",
  pri: "1",
  rep: "1",
  "docs.count": "1",
  "docs.deleted": "0",
  "store.size": "10",
  "pri.store.size": "5",
};

function allSections(detail: DetailViewSchema): SectionNode[] {
  return [...detail.sections, ...(detail.customTabs ?? []).flatMap((t) => t.sections ?? [])];
}

describe("enrichDetail admin extras", () => {
  it("reads snapshots, policies, aliases, streams, shards and top queries", async () => {
    const { services } = host((method, url) => {
      switch (url.pathname) {
        case "/_cat/indices":
          return { status: 200, body: [INDEX] };
        case "/_snapshot/_all":
          return { status: 200, body: { s3repo: { type: "s3" } } };
        case "/_snapshot/s3repo/_all":
          return {
            status: 200,
            body: {
              snapshots: [
                {
                  snapshot: "nightly-1",
                  state: "SUCCESS",
                  indices: ["logs-1"],
                  start_time_in_millis: 1_700_000_000_000,
                  duration_in_millis: 65_000,
                  shards: { total: 2, successful: 2, failed: 0 },
                },
              ],
            },
          };
        case "/_cat/aliases":
          return {
            status: 200,
            body: [
              { alias: "logs", index: "logs-1", is_write_index: "true", filter: "-" },
              { alias: ".kibana", index: ".kibana_1" },
            ],
          };
        case "/_data_stream":
          return {
            status: 200,
            body: {
              data_streams: [
                { name: "metrics", generation: 3, status: "GREEN", indices: [{}, {}, {}] },
              ],
            },
          };
        case "/_cat/shards":
          return {
            status: 200,
            body: [
              { index: "logs-1", shard: "0", prirep: "p", state: "STARTED" },
              {
                index: "logs-1",
                shard: "0",
                prirep: "r",
                state: "UNASSIGNED",
                "unassigned.reason": "INDEX_CREATED",
              },
            ],
          };
        case "/_plugins/_ism/policies":
          return {
            status: 200,
            body: {
              policies: [
                {
                  _id: "retain-30d",
                  policy: {
                    policy_id: "retain-30d",
                    states: [{ name: "hot" }, { name: "delete" }],
                    ism_template: [{ index_patterns: ["logs-*"] }],
                  },
                },
              ],
              total_policies: 1,
            },
          };
        case "/_plugins/_sm/policies":
          return {
            status: 200,
            body: {
              policies: [
                {
                  _id: "daily-sm-policy",
                  sm_policy: {
                    name: "daily",
                    enabled: true,
                    creation: { schedule: { cron: { expression: "0 2 * * *", timezone: "UTC" } } },
                    deletion: { condition: { max_age: "30d", min_count: 7 } },
                    snapshot_config: { repository: "s3repo" },
                  },
                },
              ],
            },
          };
        case "/_insights/top_queries":
          return {
            status: 200,
            body: {
              top_queries: [
                {
                  timestamp: 1_700_000_000_000,
                  indices: ["logs-1"],
                  source: { query: { match_all: {} } },
                  total_shards: 1,
                  measurements: { latency: { number: 42 }, cpu: { number: 3_000_000 } },
                },
              ],
            },
          };
        default:
          return { status: 200, body: {} };
      }
    });
    const c = client(services);
    const detail = c.renderDetail(await c.enrichDetail(CLUSTER));
    const text = JSON.stringify(allSections(detail));
    expect(text).toContain("Snapshots in s3repo (1)");
    expect(text).toContain("restore-snapshot:s3repo/nightly-1");
    expect(text).toContain("delete-snapshot:s3repo/nightly-1");
    expect(text).toContain("Snapshot policies (1)");
    expect(text).toContain("stop-sm-policy:daily");
    expect(text).toContain("Index State Management policies (1)");
    expect(text).toContain("hot > delete");
    expect(text).toContain("remove-alias:logs-1/logs");
    expect(text).not.toContain(".kibana");
    expect(text).toContain("rollover:metrics");
    expect(text).toContain("Unassigned shards (1)");
    expect(text).toContain("42 ms");
    expect(detail.customTabs!.map((t) => t.id)).toEqual([
      "snapshots",
      "aliases",
      "lifecycle",
      "query-insights",
    ]);
    expect(detail.headerActions!.map((a) => a.label)).toContain("Retry allocation");

    // Index fields become pickers fed by the index listing.
    const search = detail.headerActions!.find((a) => a.label === "Search")!;
    if (search.action.type !== "prompt-nosql-command") throw new Error("expected prompt");
    expect(search.action.fields[0]).toMatchObject({
      kind: "select",
      options: [{ id: "logs-1", label: "logs-1" }],
    });
  });

  it("marks plugin endpoints the cluster refuses as not available", async () => {
    const { services } = host((_m, url) =>
      url.pathname.startsWith("/_plugins") || url.pathname.startsWith("/_insights")
        ? { status: 400, body: { error: "no handler found" } }
        : { status: 200, body: url.pathname === "/_cat/indices" ? [] : {} },
    );
    const c = client(services);
    const text = JSON.stringify(allSections(c.renderDetail(await c.enrichDetail(CLUSTER))));
    expect(text).toContain("Snapshot Management is not available");
    expect(text).toContain("Index State Management is not available");
    expect(text).toContain("Query Insights is not available");
  });
});

describe("admin actions", () => {
  function recorder() {
    const calls: Array<{ method: string; path: string; query: string; body: unknown }> = [];
    const { services } = host((method, url, body) => {
      calls.push({ method, path: url.pathname, query: url.search, body });
      return { status: 200, body: { acknowledged: true, task: "node:1" } };
    });
    return { c: client(services), calls };
  }

  it("restores a snapshot beside the existing indices", async () => {
    const { c, calls } = recorder();
    await c.invokeAction("opensearch-cluster", "x", "restore-snapshot:s3repo/nightly-1", "acct");
    expect(calls[0]).toMatchObject({
      method: "POST",
      path: "/_snapshot/s3repo/nightly-1/_restore",
      body: {
        indices: "*,-.*",
        include_global_state: false,
        rename_pattern: "(.+)",
        rename_replacement: "restored-$1",
      },
    });
  });

  it.each([
    ["remove-alias:logs-1/logs", "POST", "/_aliases"],
    ["rollover:metrics", "POST", "/metrics/_rollover"],
    ["delete-data-stream:metrics", "DELETE", "/_data_stream/metrics"],
    ["delete-ism-policy:retain-30d", "DELETE", "/_plugins/_ism/policies/retain-30d"],
    ["start-sm-policy:daily", "POST", "/_plugins/_sm/policies/daily/_start"],
    ["stop-sm-policy:daily", "POST", "/_plugins/_sm/policies/daily/_stop"],
    ["delete-sm-policy:daily", "DELETE", "/_plugins/_sm/policies/daily"],
    ["retry-allocation", "POST", "/_cluster/reroute"],
  ])("%s", async (actionId, method, path) => {
    const { c, calls } = recorder();
    await c.invokeAction("opensearch-cluster", "x", actionId, "acct");
    expect(calls[0]).toMatchObject({ method, path });
  });

  it("runs reindex as a background task", async () => {
    const { c, calls } = recorder();
    const result = await c.executeNoSqlCommand("opensearch-cluster", "x", "acct", "reindex", [
      JSON.stringify({ source: "logs-1", dest: "logs-2" }),
    ]);
    expect(calls[0]!.query).toContain("wait_for_completion=false");
    expect(result).toEqual({ ok: true, task: "node:1" });
  });

  it("adds an alias with the write flag", async () => {
    const { c, calls } = recorder();
    await c.executeNoSqlCommand("opensearch-cluster", "x", "acct", "add-alias", [
      JSON.stringify({ index: "logs-1", alias: "logs", writeIndex: "true" }),
    ]);
    expect(calls[0]!.body).toEqual({
      actions: [{ add: { index: "logs-1", alias: "logs", is_write_index: true } }],
    });
  });

  it("creates a retention ISM policy and refuses a bare wildcard", async () => {
    const { c, calls } = recorder();
    await c.executeNoSqlCommand("opensearch-cluster", "x", "acct", "create-ism-policy", [
      JSON.stringify({ policyId: "retain", pattern: "logs-*", deleteAfter: "30d" }),
    ]);
    expect(calls[0]).toMatchObject({ method: "PUT", path: "/_plugins/_ism/policies/retain" });
    const policy = (calls[0]!.body as { policy: Record<string, unknown> }).policy;
    expect(policy["ism_template"]).toEqual([{ index_patterns: ["logs-*"], priority: 100 }]);
    await expect(
      c.executeNoSqlCommand("opensearch-cluster", "x", "acct", "create-ism-policy", [
        JSON.stringify({ policyId: "bad", pattern: "*", deleteAfter: "1d" }),
      ]),
    ).rejects.toThrow(/narrower pattern/);
  });

  it("surfaces per-index failures when applying an ISM policy", async () => {
    const { services } = host(() => ({
      status: 200,
      body: {
        updated_indices: 0,
        failures: true,
        failed_indices: [{ reason: "This index already has a policy" }],
      },
    }));
    await expect(
      client(services).executeNoSqlCommand("opensearch-cluster", "x", "acct", "attach-ism-policy", [
        JSON.stringify({ index: "logs-1", policyId: "retain" }),
      ]),
    ).rejects.toThrow(/already has a policy/);
  });

  it("creates a snapshot policy with retention", async () => {
    const { c, calls } = recorder();
    await c.executeNoSqlCommand("opensearch-cluster", "x", "acct", "create-sm-policy", [
      JSON.stringify({
        name: "daily",
        repository: "s3repo",
        schedule: "0 2 * * *",
        maxAge: "30d",
        minCount: "7",
        indices: "logs-*",
      }),
    ]);
    expect(calls[0]).toMatchObject({
      method: "POST",
      path: "/_plugins/_sm/policies/daily",
      body: {
        creation: { schedule: { cron: { expression: "0 2 * * *", timezone: "UTC" } } },
        deletion: { condition: { max_age: "30d", min_count: 7 } },
        snapshot_config: { repository: "s3repo", indices: "logs-*" },
      },
    });
  });
});

describe("metrics", () => {
  it("adds CPU, pending tasks and cumulative search / indexing totals", async () => {
    const { services } = host((_m, url) => {
      if (url.pathname === "/_cluster/health") {
        return { status: 200, body: { status: "green", number_of_pending_tasks: 2 } };
      }
      if (url.pathname.startsWith("/_nodes/stats")) {
        return {
          status: 200,
          body: {
            nodes: {
              a: {
                name: "a",
                os: { cpu: { percent: 40 } },
                indices: { search: { query_total: 10 }, indexing: { index_total: 5 } },
              },
              b: {
                name: "b",
                os: { cpu: { percent: 60 } },
                indices: { search: { query_total: 30 }, indexing: { index_total: 7 } },
              },
            },
          },
        };
      }
      return { status: 200, body: {} };
    });
    const series = await client(services).fetchMetricSeries();
    const byLabel = Object.fromEntries(series.map((s) => [s.label, s.points[0]!.value]));
    expect(byLabel["Avg CPU %"]).toBe(50);
    expect(byLabel["Pending tasks"]).toBe(2);
    expect(byLabel["Search queries (cumulative)"]).toBe(40);
    expect(byLabel["Indexing operations (cumulative)"]).toBe(12);
  });
});

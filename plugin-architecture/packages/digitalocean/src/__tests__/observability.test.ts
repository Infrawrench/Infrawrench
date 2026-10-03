import { describe, it, expect, vi, afterEach } from "vitest";
import type { ResourceInstance } from "@infrawrench/plugin-base";
import { DigitalOceanClient } from "../client.js";
import { fetchDoMetricSeries, type DoMetricContext } from "../metric-series.js";
import { buildDropletLogSearch } from "../insights-logs.js";

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
    headers: { get: () => null },
  } as unknown as Response;
}

type Call = { path: string; method: string; body: unknown };

function installFetch(route: (path: string, method: string) => unknown) {
  const calls: Call[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation((async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    const path = String(input).replace("https://api.digitalocean.com/v2", "");
    const method = init?.method ?? "GET";
    const raw = init?.body as string | undefined;
    calls.push({ path, method, body: raw ? JSON.parse(raw) : undefined });
    const result = route(path, method);
    if (result === undefined) return jsonResponse({ message: "not found" }, 404);
    if (typeof result === "number") return jsonResponse({ message: "nope" }, result);
    return jsonResponse(result);
  }) as typeof fetch);
  return calls;
}

const ACC = "acc1";
const client = () => new DigitalOceanClient({ apiToken: "tok" });
const prom = (v: string) => ({ data: { result: [{ metric: {}, values: [[1_700_000_000, v]] }] } });

afterEach(() => vi.restoreAllMocks());

describe("managed-database metrics", () => {
  function ctx(engine: string, seen: string[]): DoMetricContext {
    return {
      async fetch<T>(path: string): Promise<T> {
        seen.push(path);
        return prom("1") as T;
      },
      async getResource(): Promise<ResourceInstance> {
        return {
          id: `${ACC}:managed-database:db-1`,
          externalId: "db-1",
          pluginId: "digitalocean",
          resourceTypeId: "managed-database",
          accountId: ACC,
          displayName: "db",
          fields: { engine },
          resolvedOutputs: {},
          secretStates: [],
          createdAt: "",
          updatedAt: "",
        };
      },
    };
  }

  it("charts the MySQL-only series and passes the load window", async () => {
    const seen: string[] = [];
    const series = await fetchDoMetricSeries(
      ctx("mysql", seen),
      "managed-database",
      `${ACC}:managed-database:db-1`,
      ACC,
      { startMs: 1_700_000_000_000, endMs: 1_700_003_600_000 },
    );
    expect(series.map((s) => s.label)).toEqual([
      "CPU Utilization",
      "Memory Used",
      "Disk Used",
      "Load (1m)",
      "Load (5m)",
      "Load (15m)",
      "Reads Using an Index",
      "Selects/s",
      "Inserts/s",
      "Updates/s",
      "Deletes/s",
      "Threads Connected",
      "Threads Active",
      "Threads Created",
    ]);
    expect(seen).toContain(
      "/monitoring/metrics/database/mysql/load?db_id=db-1&aggregate=avg&start=1700000000&end=1700003600&metric=load15",
    );
    expect(seen).toContain(
      "/monitoring/metrics/database/mysql/op_rates?db_id=db-1&metric=delete&start=1700000000&end=1700003600",
    );
  });

  it("asks other engines only for the shared series", async () => {
    const seen: string[] = [];
    await fetchDoMetricSeries(
      ctx("pg", seen),
      "managed-database",
      `${ACC}:managed-database:db-1`,
      ACC,
    );
    expect(seen).toHaveLength(6);
    expect(seen.every((p) => p.startsWith("/monitoring/metrics/database/postgresql/"))).toBe(true);
  });
});

describe("app daily bandwidth", () => {
  it("asks one UTC day at a time and charts bytes per day", async () => {
    const calls = installFetch((p) => {
      if (p === "/apps/app-1")
        return { app: { id: "app-1", spec: { name: "shop", services: [{ name: "api" }] } } };
      if (p.startsWith("/apps/app-1/metrics/bandwidth_daily?date=2023-11-14"))
        return { app_bandwidth_usage: [{ app_id: "app-1", bandwidth_bytes: "513668" }] };
      if (p.startsWith("/apps/app-1/metrics/bandwidth_daily?date=2023-11-15"))
        return { app_bandwidth_usage: [{ app_id: "app-1", bandwidth_bytes: "1000" }] };
      return undefined;
    });
    const series = await client().fetchMetricSeries("app", `${ACC}:app:app-1`, ACC, {
      // 2023-11-14T22:13:20Z .. 2023-11-15T23:13:20Z
      startMs: 1_700_000_000_000,
      endMs: 1_700_090_000_000,
    });
    const bw = series.find((s) => s.label === "Bandwidth (daily)");
    expect(bw?.unit).toBe("bytes");
    expect(bw?.points).toEqual([
      { timestamp: Date.UTC(2023, 10, 14), value: 513668 },
      { timestamp: Date.UTC(2023, 10, 15), value: 1000 },
    ]);
    expect(calls.filter((c) => c.path.includes("bandwidth_daily"))).toHaveLength(2);
  });
});

describe("droplet Insights logs", () => {
  const droplet = {
    droplet: { id: 42, name: "web", region: { slug: "nyc3" }, size: { slug: "s-1vcpu-1gb" } },
  };

  it("searches the Droplet's region newest first and prints oldest first", async () => {
    const calls = installFetch((p, m) => {
      if (p === "/droplets/42") return droplet;
      if (p === "/insights/query/nyc3/logs/search" && m === "POST")
        return {
          data: [
            {
              timestamp: "2026-10-03T10:00:02Z",
              severity_text: "Error",
              service_name: "nginx",
              body: "upstream timed out",
            },
            { timestamp: "2026-10-03T10:00:01Z", severity_text: "Info", body: "started" },
          ],
        };
      return undefined;
    });
    const logs = await client().getLogs("droplet", `${ACC}:droplet:42`, ACC, { tailLines: 50 });
    expect(logs.containers).toEqual(["all", "errors"]);
    expect(logs.activeContainer).toBe("all");
    expect(logs.text).toBe(
      "2026-10-03T10:00:01Z  Info  -  started\n2026-10-03T10:00:02Z  Error  nginx  upstream timed out\n",
    );
    const search = calls.find((c) => c.path.endsWith("/logs/search"));
    expect(search?.body).toMatchObject({
      time_range: { from: { relative: "24h" }, to: { relative: "now" } },
      order_by: [{ field: { name: "timestamp" }, direction: "SORT_DIRECTION_DESC" }],
      pagination: { limit: 50 },
    });
  });

  it("narrows the errors view to severity ERROR and up", () => {
    const body = buildDropletLogSearch("42", "errors", 5000) as {
      filter: { and: { expressions: unknown[] } };
      pagination: { limit: number };
    };
    expect(body.pagination.limit).toBe(1000);
    expect(body.filter.and.expressions[1]).toEqual({
      condition: {
        field: { name: "severity_number" },
        operator: "FILTER_OPERATOR_GTE",
        value: { number_value: 17 },
      },
    });
    expect(JSON.stringify(body.filter)).toContain('"do:droplet:42"');
  });

  it("points at the token scope on a 403", async () => {
    installFetch((p) => (p === "/droplets/42" ? droplet : 403));
    const logs = await client().getLogs("droplet", `${ACC}:droplet:42`, ACC, {
      container: "errors",
    });
    expect(logs.activeContainer).toBe("errors");
    expect(logs.text).toMatch(/insights:read/);
  });
});

describe("DOKS status messages", () => {
  it("lists the cluster's status messages oldest first", async () => {
    installFetch((p) =>
      p === "/kubernetes/clusters/k1/status_messages"
        ? {
            messages: [
              { timestamp: "2026-10-02T00:00:00Z", message: "second" },
              { timestamp: "2026-10-01T00:00:00Z", message: "first" },
            ],
          }
        : undefined,
    );
    const logs = await client().getLogs("doks-cluster", `${ACC}:doks-cluster:k1`, ACC, {});
    expect(logs).toEqual({
      text: "2026-10-01T00:00:00Z  first\n2026-10-02T00:00:00Z  second\n",
      containers: ["status"],
      activeContainer: "status",
    });
  });

  it("declares a Logs tab on DOKS clusters and Droplets", () => {
    const c = client();
    const base = {
      pluginId: "digitalocean",
      accountId: ACC,
      displayName: "x",
      fields: {},
      resolvedOutputs: {},
      secretStates: [],
      createdAt: "",
      updatedAt: "",
    };
    expect(
      c.renderDetail({ ...base, id: `${ACC}:doks-cluster:k1`, resourceTypeId: "doks-cluster" })
        .logs,
    ).toEqual({ defaultTailLines: 200 });
    expect(
      c.renderDetail({ ...base, id: `${ACC}:droplet:42`, resourceTypeId: "droplet" }).logs,
    ).toEqual({ defaultTailLines: 200 });
  });
});

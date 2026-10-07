import { describe, expect, it } from "vitest";
import { labelsKey, normaliseUrl, PromApiError } from "../api.js";
import {
  parsePromMetricParams,
  promMetricQuery,
  runPromMetricSource,
} from "../business-metric-source.js";
import { parseEndsAt, PromClient } from "../client.js";
import { matcherText, parseMatchers } from "../mappers.js";
import type { Call } from "./helpers.js";
import { makeHttp } from "./helpers.js";

const ACCOUNT = "acct";

function client(route: (call: Call) => unknown, creds: Record<string, string> = {}) {
  const { http, calls } = makeHttp(route);
  return {
    c: new PromClient(
      {
        url: "prom.internal:9090/graph",
        alertmanagerUrl: "am.internal:9093",
        tenantId: "team-a",
        ...creds,
      },
      { http } as never,
    ),
    calls,
  };
}
const ok = (data: unknown) => ({ status: "success", data });
const form = (call: Call) => new URLSearchParams(String(call.body));

describe("helpers", () => {
  it("normalises URLs and keeps path prefixes", () => {
    expect(normaliseUrl("prom.internal:9090/graph")).toBe("http://prom.internal:9090");
    expect(normaliseUrl("https://mimir.example.com/prometheus/api/v1")).toBe(
      "https://mimir.example.com/prometheus",
    );
    expect(normaliseUrl("am.internal:9093/api/v2", "alertmanager")).toBe("http://am.internal:9093");
  });

  it("parses and prints matchers", () => {
    const m = parseMatchers('alertname="Disk Full", instance=~"db-.*", env!=prod, msg!~"a\\"b"');
    expect(m).toEqual([
      { name: "alertname", value: "Disk Full", isRegex: false, isEqual: true },
      { name: "instance", value: "db-.*", isRegex: true, isEqual: true },
      { name: "env", value: "prod", isRegex: false, isEqual: false },
      { name: "msg", value: 'a"b', isRegex: true, isEqual: false },
    ]);
    expect(m.map(matcherText).join(", ")).toBe(
      'alertname="Disk Full", instance=~"db-.*", env!="prod", msg!~"a\\"b"',
    );
    expect(() => parseMatchers("not a matcher")).toThrow();
  });

  it("hashes label sets independent of order", () => {
    expect(labelsKey({ a: "1", b: "2" })).toBe(labelsKey({ b: "2", a: "1" }));
  });

  it("reads silence end times", () => {
    expect(parseEndsAt("2h", 0)).toBe("1970-01-01T02:00:00.000Z");
    expect(() => parseEndsAt("soon")).toThrow(PromApiError);
  });

  it("builds a day query and refuses PromQL injection in the filter", () => {
    const p = parsePromMetricParams({
      metric: "http_requests_total",
      matchers: 'job="api"',
      groupBy: "status",
      mode: "increase",
    });
    expect(promMetricQuery(p, 86400)).toBe(
      'sum by (status) (increase(http_requests_total{job="api"}[86400s]))',
    );
    expect(() =>
      parsePromMetricParams({ metric: "x", matchers: '} or vector(1) or {a="' }),
    ).toThrow();
  });
});

describe("requests", () => {
  it("sends the tenant header and POSTs PromQL as a form", async () => {
    const { c, calls } = client(() =>
      ok({ resultType: "vector", result: [{ metric: { job: "api" }, value: [1700000000, "3"] }] }),
    );
    const res = await c.executeQuery("x", ACCOUNT, "sum by (job) (up)");
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.url.toString()).toBe("http://prom.internal:9090/api/v1/query");
    expect(calls[0]!.headers["X-Scope-OrgID"]).toBe("team-a");
    expect(form(calls[0]!).get("query")).toBe("sum by (job) (up)");
    expect(res.rows).toEqual([{ job: "api", value: 3, timestamp: "2023-11-14T22:13:20.000Z" }]);
  });

  it("turns a PromQL error into a status-bearing error", async () => {
    const { c } = client(() => ({
      status: 400,
      body: { status: "error", errorType: "bad_data", error: "parse error" },
    }));
    const err = await c.executeQuery("x", ACCOUNT, "up{").catch((e: unknown) => e);
    expect((err as PromApiError).status).toBe(400);
    expect((err as Error).message).toContain("bad_data: parse error");
  });

  it("groups targets into scrape pools", async () => {
    const { c } = client((call) =>
      call.url.pathname === "/api/v1/scrape_pools"
        ? ok({ scrapePools: ["node", "empty"] })
        : ok({
            activeTargets: [
              {
                scrapePool: "node",
                scrapeUrl: "http://a:9100/metrics",
                health: "up",
                labels: { instance: "a" },
              },
              {
                scrapePool: "node",
                scrapeUrl: "http://b:9100/metrics",
                health: "down",
                labels: { instance: "b" },
              },
            ],
            droppedTargets: [{ scrapePool: "node" }],
          }),
    );
    const pools = await c.listResources("prometheus-scrape-pool", ACCOUNT);
    expect(
      pools.map((p) => [p.displayName, p.fields["up"], p.fields["down"], p.fields["dropped"]]),
    ).toEqual([
      ["empty", 0, 0, 0],
      ["node", 1, 1, 1],
    ]);
  });

  it("gives repeated rule names distinct ids", async () => {
    const { c } = client(() =>
      ok({
        groups: [
          {
            name: "g",
            file: "/r.yml",
            rules: [
              { name: "A", type: "alerting" },
              { name: "A", type: "alerting" },
            ],
          },
        ],
      }),
    );
    const rules = await c.listResources("prometheus-rule", ACCOUNT);
    expect(rules.map((r) => r.externalId)).toEqual(["%2Fr.yml/g/A", "%2Fr.yml/g/A%232"]);
    expect(rules[0]!.parentResourceId).toBe("acct:prometheus-rule-group:%2Fr.yml/g");
  });

  it("creates a silence on the Alertmanager", async () => {
    const { c, calls } = client((call) =>
      call.method === "POST"
        ? { silenceID: "abc" }
        : {
            id: "abc",
            matchers: [{ name: "alertname", value: "X", isRegex: false }],
            status: { state: "active" },
          },
    );
    const s = await c.createResource("prometheus-silence", ACCOUNT, {
      matchers: 'alertname="X"',
      duration: "1h",
      createdBy: "me",
      comment: "maint",
    });
    expect(calls[0]!.url.toString()).toBe("http://am.internal:9093/api/v2/silences");
    expect(calls[0]!.body).toMatchObject({
      matchers: [{ name: "alertname", value: "X", isRegex: false, isEqual: true }],
      createdBy: "me",
      comment: "maint",
    });
    expect(s.externalId).toBe("abc");
  });

  it("lists nothing from Alertmanager when none is configured", async () => {
    const { c, calls } = client(() => ok({}), { alertmanagerUrl: "" });
    expect(await c.listResources("prometheus-silence", ACCOUNT)).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it("explains a disabled lifecycle API", async () => {
    const { c } = client(() => ({ status: 404, text: "404 page not found" }));
    const err = await c
      .invokeAction("prometheus-server", "acct:prometheus-server:server", "reload")
      .catch((e: unknown) => e);
    expect((err as Error).message).toContain("--web.enable-lifecycle");
  });
});

describe("business metric source", () => {
  it("reads whole UTC days with one range query", async () => {
    const { c, calls } = client(() =>
      ok({
        resultType: "matrix",
        result: [
          {
            metric: {},
            values: [
              [1767312000, "10"],
              [1767398400, "20"],
            ],
          },
        ],
      }),
    );
    const res = await runPromMetricSource(
      (c as unknown as { ctx: never }).ctx,
      { metric: "orders_total", mode: "increase" },
      { from: "2026-01-01", to: "2026-01-02", timezone: "UTC", maxRows: 1000, timeoutMs: 5000 },
      Date.parse("2026-02-01T00:00:00Z"),
    );
    expect(calls).toHaveLength(1);
    expect(form(calls[0]!).get("step")).toBe("86400");
    expect(res.points).toEqual([
      { date: "2026-01-01", value: 10 },
      { date: "2026-01-02", value: 20 },
    ]);
  });

  it("queries each day on its own across a DST change", async () => {
    const { c, calls } = client(() =>
      ok({ resultType: "vector", result: [{ metric: {}, value: [0, "5"] }] }),
    );
    const res = await runPromMetricSource(
      (c as unknown as { ctx: never }).ctx,
      { metric: "orders_total", mode: "increase" },
      {
        from: "2026-03-07",
        to: "2026-03-09",
        timezone: "America/New_York",
        maxRows: 1000,
        timeoutMs: 5000,
      },
      Date.parse("2026-04-01T00:00:00Z"),
    );
    expect(calls).toHaveLength(3);
    expect(form(calls[1]!).get("query")).toContain("[82800s]");
    expect(res.points.map((p) => p.date)).toEqual(["2026-03-07", "2026-03-08", "2026-03-09"]);
  });
});

import { hostClient } from "@infrawrench/plugin-base/effect";
import { describe, expect, it } from "vitest";
import { DatadogClient } from "../client.js";
import { latestAttributionMonth, parseTagConfigSource } from "../attribution.js";
import { chartableMonitorQuery } from "../metrics.js";
import { resolveSite } from "../sites.js";
import { productLabel } from "../products.js";
import { datadogPolicyTemplate } from "../preflight.js";
import { makeHttp, type Reply } from "./helpers.js";

const ACCOUNT = "acc";

function client(route: Parameters<typeof makeHttp>[0], site = "eu1") {
  const { http, calls } = makeHttp(route);
  const c = hostClient(
    new DatadogClient({ apiKey: "api-key", appKey: "app-key", site }, {
      http,
    } as unknown as ConstructorParameters<typeof DatadogClient>[1]),
  );
  return { c, calls };
}

describe("sites", () => {
  it("resolves picker ids, labels and DD_SITE values", () => {
    expect(resolveSite("eu1").apiUrl).toBe("https://api.datadoghq.eu");
    expect(resolveSite("EU").apiUrl).toBe("https://api.datadoghq.eu");
    expect(resolveSite("us5.datadoghq.com").apiUrl).toBe("https://api.us5.datadoghq.com");
    expect(resolveSite("US1-FED").apiUrl).toBe("https://api.ddog-gov.com");
    expect(resolveSite("").apiUrl).toBe("https://api.datadoghq.com");
    expect(() => resolveSite("mars1")).toThrow(/unknown site/);
  });
});

describe("productLabel", () => {
  it("uses known names and title-cases the rest with acronyms", () => {
    expect(productLabel("infra_host")).toBe("Infrastructure Hosts");
    expect(productLabel("ci_visibility_itr")).toBe("CI Visibility Itr");
    expect(productLabel("logs_indexed_15day")).toBe("Logs Indexed 15-Day");
  });
});

describe("chartableMonitorQuery", () => {
  it("strips the evaluation window and comparator", () => {
    expect(
      chartableMonitorQuery("metric alert", "avg(last_5m):avg:system.cpu.user{env:prod} > 90"),
    ).toBe("avg:system.cpu.user{env:prod}");
    expect(chartableMonitorQuery("log alert", 'logs("status:error").index("*") > 5')).toBe(
      undefined,
    );
  });
});

describe("attribution helpers", () => {
  it("parses the documented tag_config_source format", () => {
    expect(parseTagConfigSource("Acme:::team///service")).toEqual(["team", "service"]);
    expect(parseTagConfigSource(undefined)).toEqual([]);
  });

  it("picks the latest finalised month", () => {
    expect(latestAttributionMonth(Date.parse("2026-10-04T00:00:00Z"))).toBe("2026-08");
    expect(latestAttributionMonth(Date.parse("2026-10-19T00:00:00Z"))).toBe("2026-09");
  });
});

describe("DatadogClient", () => {
  it("requires both keys", () => {
    expect(() => hostClient(new DatadogClient({ apiKey: "a" }))).toThrow(/appKey/);
    expect(() => hostClient(new DatadogClient({ appKey: "a" }))).toThrow(/apiKey/);
  });

  it("lists monitors against the account's site with muted state", async () => {
    const { c, calls } = client(() => ({
      body: [
        {
          id: 42,
          name: "CPU high",
          type: "metric alert",
          query: "avg(last_5m):avg:system.cpu.user{*} > 90",
          overall_state: "Alert",
          priority: 2,
          tags: ["team:core", "env:prod"],
          options: { thresholds: { critical: 90, warning: 80 }, silenced: {} },
          matching_downtimes: [{ id: 1 }],
        },
      ],
    }));
    const [m] = await c.listResources("monitor", ACCOUNT);
    expect(calls[0]!.url.origin).toBe("https://api.datadoghq.eu");
    expect(calls[0]!.url.pathname).toBe("/api/v1/monitor");
    expect(m!.id).toBe("acc:monitor:42");
    expect(m!.fields).toMatchObject({
      priority: "2",
      tags: "team:core, env:prod",
      muted: true,
      thresholds: "critical 90 · warning 80",
    });
    expect(m!.resolvedOutputs["url"]).toBe("https://app.datadoghq.eu/monitors/42");
    const detail = c.renderDetail(m!);
    expect(detail.metricsCapability).toBeDefined();
    expect(detail.headerActions?.some((a) => a.label === "Unmute")).toBe(true);
  });

  it("lists an empty type when the key lacks that scope", async () => {
    const { c } = client(() => ({ status: 403, body: { errors: ["Forbidden"] } }));
    await expect(c.listResources("host", ACCOUNT)).resolves.toEqual([]);
  });

  it("still throws on wrong keys", async () => {
    const { c } = client(() => ({ status: 401, body: { errors: ["Unauthorized"] } }));
    await expect(c.listResources("host", ACCOUNT)).rejects.toThrow(/401/);
  });

  it("pages users and resolves role names from included", async () => {
    const { c, calls } = client(() => ({
      body: {
        data: [
          {
            id: "u1",
            attributes: { name: "Ada", email: "ada@example.com", mfa_enabled: false },
            relationships: { roles: { data: [{ id: "r1", type: "roles" }] } },
          },
        ],
        included: [{ id: "r1", type: "roles", attributes: { name: "Datadog Admin Role" } }],
      },
    }));
    const [u] = await c.listResources("user", ACCOUNT);
    expect(calls[0]!.url.searchParams.get("include")).toBe("roles");
    expect(calls[0]!.url.searchParams.get("page[size]")).toBe("100");
    expect(u!.fields["roles"]).toBe("Datadog Admin Role");
  });

  it("maps application key scopes and owners", async () => {
    const { c } = client(() => ({
      body: {
        data: [
          {
            id: "k1",
            attributes: { name: "ci", last4: "abcd", scopes: null },
            relationships: { owned_by: { data: { id: "u1" } } },
          },
        ],
        included: [{ id: "u1", type: "users", attributes: { email: "ada@example.com" } }],
      },
    }));
    const [k] = await c.listResources("application-key", ACCOUNT);
    expect(k!.fields).toMatchObject({ owner: "ada@example.com", scopes: "All (unscoped)" });
  });

  it("creates a downtime for a picked monitor", async () => {
    const { c, calls } = client((url, method) => {
      if (method === "POST") {
        return {
          body: {
            data: {
              id: "dt-1",
              attributes: {
                scope: "env:prod",
                status: "scheduled",
                monitor_identifier: { monitor_id: 42 },
                schedule: { start: "2026-10-05T00:00:00Z", end: "2026-10-05T02:00:00Z" },
              },
            },
          },
        };
      }
      return { body: { id: 42, name: "CPU high" } };
    });
    const created = await c.createResource!("downtime", ACCOUNT, {
      monitorId: "42",
      scope: "env:prod",
      start: "2026-10-05T00:00:00Z",
      end: "2026-10-05T02:00:00Z",
      message: "",
    });
    expect(calls[0]!.body).toEqual({
      data: {
        type: "downtime",
        attributes: {
          scope: "env:prod",
          monitor_identifier: { monitor_id: 42 },
          schedule: { start: "2026-10-05T00:00:00Z", end: "2026-10-05T02:00:00Z" },
        },
      },
    });
    expect(created.displayName).toBe("CPU high · env:prod");
  });

  it("silences every monitor in scope when no monitor is picked", async () => {
    const { c, calls } = client(() => ({
      body: { data: { id: "dt-2", attributes: { scope: "*" } } },
    }));
    await c.createResource!("downtime", ACCOUNT, { monitorId: "", scope: "" });
    expect(
      (calls[0]!.body as { data: { attributes: Record<string, unknown> } }).data.attributes,
    ).toEqual({ scope: "*", monitor_identifier: { monitor_tags: ["*"] } });
  });

  it("edits only the changed monitor fields", async () => {
    const { c, calls } = client(() => ({ body: { id: 42, name: "Renamed" } }));
    await c.updateResource!("monitor", "acc:monitor:42", ACCOUNT, {
      priority: "",
      tags: "a:b, c:d",
    });
    expect(calls[0]!.method).toBe("PUT");
    expect(calls[0]!.body).toEqual({ priority: null, tags: ["a:b", "c:d"] });
  });

  it("mutes a monitor for an hour through a downtime and unmutes by canceling it", async () => {
    const { c, calls } = client((url, method) => {
      if (method === "GET") {
        return {
          body: {
            data: [
              { id: "dt-9", attributes: { monitor_identifier: { monitor_id: 42 } } },
              { id: "dt-8", attributes: { monitor_identifier: { monitor_id: 7 } } },
            ],
          },
        };
      }
      return { body: {} };
    });
    await c.invokeAction!("monitor", "acc:monitor:42", "mute-1h", ACCOUNT);
    const mute = calls[0]!.body as {
      data: { attributes: { monitor_identifier: unknown; schedule: { end: string } } };
    };
    expect(mute.data.attributes.monitor_identifier).toEqual({ monitor_id: 42 });
    expect(Date.parse(mute.data.attributes.schedule.end)).toBeGreaterThan(Date.now());

    await c.invokeAction!("monitor", "acc:monitor:42", "unmute", ACCOUNT);
    const deletes = calls.filter((x) => x.method === "DELETE").map((x) => x.url.pathname);
    expect(deletes).toEqual(["/api/v2/downtime/dt-9"]);
  });

  it("pauses, resumes and runs synthetic tests", async () => {
    const { c, calls } = client(() => ({ body: {} }));
    await c.invokeAction!("synthetics-test", "acc:synthetics-test:abc-def", "pause", ACCOUNT);
    await c.invokeAction!("synthetics-test", "acc:synthetics-test:abc-def", "run", ACCOUNT);
    expect(calls[0]!.url.pathname).toBe("/api/v1/synthetics/tests/abc-def/status");
    expect(calls[0]!.body).toEqual({ new_status: "paused" });
    expect(calls[1]!.body).toEqual({ tests: [{ public_id: "abc-def" }] });
  });

  it("deletes synthetic tests through the bulk delete route", async () => {
    const { c, calls } = client(() => ({ body: {} }));
    await c.deleteResource!("synthetics-test", "acc:synthetics-test:abc-def", ACCOUNT);
    expect(calls[0]!.url.pathname).toBe("/api/v1/synthetics/tests/delete");
    expect(calls[0]!.body).toEqual({ public_ids: ["abc-def"] });
  });

  it("lists organizations from cost and org endpoints", async () => {
    const { c } = client((url) => {
      if (url.pathname === "/api/v1/org") {
        return {
          body: { orgs: [{ public_id: "p1", name: "Acme", subscription: { type: "pro" } }] },
        };
      }
      if (url.pathname.endsWith("/projected_cost")) {
        return {
          body: {
            data: [
              {
                attributes: {
                  public_id: "p1",
                  org_name: "Acme",
                  region: "eu",
                  projected_total_cost: 500,
                  charges: [],
                },
              },
            ],
          },
        };
      }
      return {
        body: {
          data: [
            {
              attributes: {
                public_id: "p1",
                org_name: "Acme",
                region: "eu",
                date: "2026-10-01T00:00:00Z",
                total_cost: 120,
                charges: [],
              },
            },
          ],
        },
      };
    });
    const [org] = await c.listResources("organization", ACCOUNT);
    expect(org!.fields).toMatchObject({
      name: "Acme",
      publicId: "p1",
      region: "eu",
      plan: "pro",
      monthToDate: 120,
      projectedCost: 500,
    });
  });
});

describe("list limits", () => {
  const LISTS: Array<[string, string, string | null, number, number]> = [
    ["monitor", "page_size", null, 1000, 50],
    ["host", "count", "host_list", 1000, 50],
    ["slo", "limit", "data", 1000, 50],
    ["dashboard", "count", "dashboards", 100, 500],
    ["synthetics-test", "page_size", "tests", 100, 500],
    ["user", "page[size]", "data", 100, 500],
    ["api-key", "page[size]", "data", 100, 500],
    ["application-key", "page[size]", "data", 100, 500],
  ];

  const page = (key: string | null, rows: object[]) => (key === null ? rows : { [key]: rows });
  const fullPage = (size: number) => Array.from({ length: size }, (_, i) => ({ id: `r${i}` }));

  it.each(LISTS)(
    "%s: a list that never ends throws after its cap",
    async (typeId, sizeParam, key, size, maxPages) => {
      const { c, calls } = client(() => ({ body: page(key, fullPage(size)) }));
      await expect(c.listResources(typeId, ACCOUNT)).rejects.toThrow(
        "has more than Infrawrench reads",
      );
      expect(calls).toHaveLength(maxPages);
      expect(calls[0]!.url.searchParams.get(sizeParam)).toBe(String(size));
    },
  );

  it.each(LISTS)("%s: a first page that is not a list throws", async (typeId, _sizeParam, key) => {
    const { c } = client(() => ({ body: { renamed: [], ...(key ? {} : { errors: ["bad"] }) } }));
    await expect(c.listResources(typeId, ACCOUNT)).rejects.toThrow("is not a list");
  });

  it.each(LISTS)(
    "%s: a later page that is not a list throws",
    async (typeId, _sizeParam, key, size) => {
      let reads = 0;
      const { c } = client(() =>
        ++reads === 1 ? { body: page(key, fullPage(size)) } : { body: { renamed: [] } },
      );
      await expect(c.listResources(typeId, ACCOUNT)).rejects.toThrow("is not a list");
      expect(reads).toBe(2);
    },
  );

  it("offers the first pages of monitors in the downtime picker rather than none", async () => {
    let reads = 0;
    const { c } = client(() => {
      reads += 1;
      return {
        body: Array.from({ length: 1000 }, (_, i) => ({ id: reads * 1000 + i, name: `m${i}` })),
      };
    });
    const config = await c.getCreateConfig!("downtime");
    const picker = config.fields.find((f) => f.key === "monitorId");
    expect(reads).toBe(50);
    expect(picker?.options).toHaveLength(50_001);
  });
});

describe("organizations when a read fails", () => {
  const estimated = {
    body: { data: [{ attributes: { public_id: "p1", org_name: "Acme", charges: [] } }] },
  };
  const orgs = { body: { orgs: [{ public_id: "p1", name: "Acme" }] } };
  const answer = (over: { org?: Reply; estimated?: Reply; projected?: Reply }) => (url: URL) => {
    if (url.pathname === "/api/v1/org") return over.org ?? orgs;
    if (url.pathname.endsWith("/projected_cost")) return over.projected ?? { body: { data: [] } };
    return over.estimated ?? estimated;
  };

  it.each([500, 503, 429])("does not read a %i on the org list as no orgs", async (status) => {
    const { c } = client(answer({ org: { status, body: { errors: ["busy"] } } }));
    await expect(c.listResources("organization", ACCOUNT)).rejects.toThrow(String(status));
  });

  it.each([500, 503, 429])("does not read a %i on estimated cost as no orgs", async (status) => {
    const { c } = client(answer({ estimated: { status, body: { errors: ["busy"] } } }));
    await expect(c.listResources("organization", ACCOUNT)).rejects.toThrow(String(status));
  });

  it("does not read wrong keys as no orgs", async () => {
    const { c } = client(() => ({ status: 401, body: { errors: ["Unauthorized"] } }));
    await expect(c.listResources("organization", ACCOUNT)).rejects.toThrow("401");
  });

  it("fails on an answer with no list rather than dropping child organizations", async () => {
    const { c: noOrgs } = client(answer({ org: { body: { renamed: [] } } }));
    await expect(noOrgs.listResources("organization", ACCOUNT)).rejects.toThrow("is not a list");
    const { c: noCost } = client(answer({ estimated: { body: { renamed: [] } } }));
    await expect(noCost.listResources("organization", ACCOUNT)).rejects.toThrow("is not a list");
  });

  it("falls back to the org list when the key cannot read cost", async () => {
    const denied = { status: 403, body: { errors: ["Forbidden"] } };
    const { c } = client(answer({ estimated: denied, projected: denied }));
    const rows = await c.listResources("organization", ACCOUNT);
    expect(rows.map((r) => r.fields["name"])).toEqual(["Acme"]);
  });

  it("uses cost alone when a child organization's key cannot read the org list", async () => {
    const { c } = client(answer({ org: { status: 403, body: { errors: ["Forbidden"] } } }));
    const rows = await c.listResources("organization", ACCOUNT);
    expect(rows.map((r) => r.fields["name"])).toEqual(["Acme"]);
  });

  it("keeps one row for the key's own organization when it can read neither", async () => {
    const { c } = client(() => ({ status: 403, body: { errors: ["Forbidden"] } }));
    const rows = await c.listResources("organization", ACCOUNT);
    expect(rows).toHaveLength(1);
  });

  it("does not let a projection that is not out yet fail the list", async () => {
    for (const projected of [{ status: 500 }, { status: 400 }, { body: {} }]) {
      const { c } = client(answer({ projected }));
      const rows = await c.listResources("organization", ACCOUNT);
      expect(rows.map((r) => r.fields["name"])).toEqual(["Acme"]);
    }
  });
});

describe("current downtimes", () => {
  const downtime = (id: string, monitorId: number) => ({
    id,
    attributes: { scope: "*", monitor_identifier: { monitor_id: monitorId } },
  });

  /** A full first page of other monitors' downtimes, with `last` on the second page. */
  function twoPages(last: object, included: object[] = []) {
    return client((url, method) => {
      if (method !== "GET") return { body: {} };
      if (url.searchParams.get("page[offset]") === "30") {
        return { body: { data: [last], included } };
      }
      return {
        body: { data: Array.from({ length: 30 }, (_, i) => downtime(`dt-${i}`, 1000 + i)) },
      };
    });
  }

  it("lists past the first page, naming monitors from any page", async () => {
    const { c, calls } = twoPages(downtime("dt-last", 42), [
      { id: 42, type: "monitors", attributes: { name: "CPU high" } },
    ]);
    const rows = await c.listResources("downtime", ACCOUNT);
    expect(rows).toHaveLength(31);
    expect(rows[30]!.fields["monitorName"]).toBe("CPU high");
    expect(calls.map((x) => x.url.searchParams.get("page[offset]"))).toEqual(["0", "30"]);
    expect(calls[0]!.url.searchParams.get("page[limit]")).toBe("30");
    expect(calls[1]!.url.searchParams.get("current_only")).toBe("true");
    expect(calls[1]!.url.searchParams.get("include")).toBe("monitor");
  });

  it("unmutes a monitor whose downtime is past the first page", async () => {
    const { c, calls } = twoPages(downtime("dt-last", 42));
    await c.invokeAction!("monitor", "acc:monitor:42", "unmute", ACCOUNT);
    const deletes = calls.filter((x) => x.method === "DELETE").map((x) => x.url.pathname);
    expect(deletes).toEqual(["/api/v2/downtime/dt-last"]);
  });

  it("cancels nothing when the list cannot be read to its end", async () => {
    const { c, calls } = client((url) =>
      url.searchParams.get("page[offset]") === "0"
        ? { body: { data: Array.from({ length: 30 }, (_, i) => downtime(`dt-${i}`, 42)) } }
        : { body: { errors: ["bad"] } },
    );
    await expect(c.invokeAction!("monitor", "acc:monitor:42", "unmute", ACCOUNT)).rejects.toThrow(
      "is not a list",
    );
    expect(calls.filter((x) => x.method === "DELETE")).toEqual([]);
  });

  it("reads a list that never ends as an error after the cap", async () => {
    const { c, calls } = client(() => ({
      body: { data: Array.from({ length: 30 }, (_, i) => downtime(`dt-${i}`, 1)) },
    }));
    await expect(c.listResources("downtime", ACCOUNT)).rejects.toThrow(
      "has more than Infrawrench reads",
    );
    expect(calls).toHaveLength(334);
  });
});

describe("synthetic test charts", () => {
  const range = { startMs: 1_000, endMs: 2_000 };

  function synthetics(type: string, results: unknown[]) {
    return client((url) => {
      if (url.pathname.endsWith("/results")) return { body: { results } };
      return { body: { public_id: "abc-def", type, name: "Check" } };
    });
  }

  it("charts a browser test's duration, errors and failed runs", async () => {
    const { c, calls } = synthetics("browser", [
      {
        check_time: 300,
        probe_dc: "aws:eu-west-1",
        result: { duration: 900, errorCount: 2, stepCountCompleted: 3, stepCountTotal: 5 },
      },
      {
        check_time: 100,
        probe_dc: "aws:eu-west-1",
        result: { duration: 800, errorCount: 0, stepCountCompleted: 5, stepCountTotal: 5 },
      },
      {
        check_time: 200,
        probe_dc: "aws:us-east-1",
        result: { duration: 700, errorCount: 0, stepCountCompleted: 5, stepCountTotal: 5 },
      },
    ]);
    const series = await c.fetchMetricSeries!(
      "synthetics-test",
      "acc:synthetics-test:abc-def",
      ACCOUNT,
      range,
    );
    const results = calls.find((x) => x.url.pathname.endsWith("/results"))!;
    expect(results.url.pathname).toBe("/api/v1/synthetics/tests/browser/abc-def/results");
    expect(series).toEqual([
      {
        label: "Duration (aws:eu-west-1)",
        unit: "ms",
        points: [
          { timestamp: 100, value: 800 },
          { timestamp: 300, value: 900 },
        ],
      },
      { label: "Duration (aws:us-east-1)", unit: "ms", points: [{ timestamp: 200, value: 700 }] },
      {
        label: "Errors",
        points: [
          { timestamp: 100, value: 0 },
          { timestamp: 200, value: 0 },
          { timestamp: 300, value: 2 },
        ],
      },
      {
        label: "Failed runs",
        points: [
          { timestamp: 100, value: 0 },
          { timestamp: 200, value: 0 },
          { timestamp: 300, value: 1 },
        ],
      },
    ]);
  });

  it("leaves out a browser test's errors and failures when it has none", async () => {
    const { c } = synthetics("browser", [
      {
        check_time: 100,
        result: { duration: 800, errorCount: 0, stepCountCompleted: 5, stepCountTotal: 5 },
      },
    ]);
    const series = await c.fetchMetricSeries!(
      "synthetics-test",
      "acc:synthetics-test:abc-def",
      ACCOUNT,
      range,
    );
    expect(series.map((s) => s.label)).toEqual(["Duration (all)"]);
  });

  it("still charts an API test's response time and failed runs", async () => {
    const { c, calls } = synthetics("api", [
      {
        check_time: 200,
        probe_dc: "aws:eu-west-1",
        result: { passed: false, timings: { total: 90 } },
      },
      {
        check_time: 100,
        probe_dc: "aws:eu-west-1",
        result: { passed: true, timings: { total: 40 } },
      },
    ]);
    const series = await c.fetchMetricSeries!(
      "synthetics-test",
      "acc:synthetics-test:abc-def",
      ACCOUNT,
      range,
    );
    expect(calls.at(-1)!.url.pathname).toBe("/api/v1/synthetics/tests/abc-def/results");
    expect(series).toEqual([
      {
        label: "Response time (aws:eu-west-1)",
        unit: "ms",
        points: [
          { timestamp: 100, value: 40 },
          { timestamp: 200, value: 90 },
        ],
      },
      {
        label: "Failed runs",
        points: [
          { timestamp: 100, value: 0 },
          { timestamp: 200, value: 1 },
        ],
      },
    ]);
  });
});

describe("policy template", () => {
  it("lists the scopes for the chosen capabilities", () => {
    const t = datadogPolicyTemplate(["costs", "hosts"]);
    expect(t.document.split("\n")).toEqual(["billing_read", "hosts_read", "usage_read"]);
  });
});

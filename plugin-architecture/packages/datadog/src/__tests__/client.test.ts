import { describe, expect, it } from "vitest";
import { DatadogClient } from "../client.js";
import { latestAttributionMonth, parseTagConfigSource } from "../attribution.js";
import { chartableMonitorQuery } from "../metrics.js";
import { resolveSite } from "../sites.js";
import { productLabel } from "../products.js";
import { datadogPolicyTemplate } from "../preflight.js";
import { makeHttp } from "./helpers.js";

const ACCOUNT = "acc";

function client(route: Parameters<typeof makeHttp>[0], site = "eu1") {
  const { http, calls } = makeHttp(route);
  const c = new DatadogClient({ apiKey: "api-key", appKey: "app-key", site }, {
    http,
  } as unknown as ConstructorParameters<typeof DatadogClient>[1]);
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
    expect(() => new DatadogClient({ apiKey: "a" })).toThrow(/appKey/);
    expect(() => new DatadogClient({ appKey: "a" })).toThrow(/apiKey/);
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

describe("policy template", () => {
  it("lists the scopes for the chosen capabilities", () => {
    const t = datadogPolicyTemplate(["costs", "hosts"]);
    expect(t.document.split("\n")).toEqual(["billing_read", "hosts_read", "usage_read"]);
  });
});

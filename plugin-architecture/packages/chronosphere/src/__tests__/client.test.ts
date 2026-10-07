import { describe, expect, it } from "vitest";
import { exportResourcesToTerraform } from "@infrawrench/plugin-base";
import { normalizeOrg, statusOf } from "../api.js";
import { ChronosphereClient, seriesConditions } from "../client.js";
import { describeConditions, mapConfig, notifierType, parseMatchers } from "../mappers.js";
import { verifyChronoCredentials } from "../preflight.js";
import { stepFor } from "../prom.js";
import { chronosphereTerraformExport } from "../terraform.js";
import { CREDS, makeHttp } from "./helpers.js";

describe("org", () => {
  it("accepts a name or a URL", () => {
    expect(normalizeOrg("https://Acme.chronosphere.io/monitors")).toBe("acme");
    expect(normalizeOrg("acme")).toBe("acme");
  });
});

describe("ChronosphereClient", () => {
  it("pages with page.token and sends API-Token", async () => {
    const { http, calls } = makeHttp((url) => {
      if (url.pathname === "/api/v1/config/monitors") {
        return url.searchParams.get("page.token") === "t2"
          ? { body: { monitors: [{ slug: "b", name: "B" }], page: {} } }
          : {
              body: {
                monitors: [{ slug: "a", name: "A", prometheus_query: "up" }],
                page: { next_token: "t2" },
              },
            };
      }
      return undefined;
    });
    const list = await new ChronosphereClient(CREDS, { http }).listResources("monitor", "acct");
    expect(list.map((m) => m.externalId)).toEqual(["a", "b"]);
    expect(calls[0]?.url.origin).toBe("https://acme.chronosphere.io");
    expect(calls[0]?.headers["API-Token"]).toBe("chrono-token");
    expect(calls[1]?.url.searchParams.get("page.token")).toBe("t2");
  });

  it("maps errors and lists a 403'd type empty", async () => {
    const { http } = makeHttp((url) =>
      url.pathname.includes("service-accounts")
        ? { status: 403, body: { code: 7, message: "denied" } }
        : { status: 500, body: { code: 13, message: "boom" } },
    );
    const client = new ChronosphereClient(CREDS, { http });
    expect(await client.listResources("service-account", "acct")).toEqual([]);
    const err = await client.listResources("team", "acct").catch((e: unknown) => e);
    expect(statusOf(err)).toBe(500);
    expect(String(err)).toContain("boom");
  });

  it("creates a monitor with conditions in a collection", async () => {
    const { http, calls } = makeHttp((_url, method, body) =>
      method === "POST"
        ? { body: { monitor: { ...(body as { monitor: object }).monitor, slug: "m1" } } }
        : undefined,
    );
    const r = await new ChronosphereClient(CREDS, { http }).createResource("monitor", "acct", {
      name: "Errors",
      collectionSlug: "payments",
      query: "sum(rate(errors[5m]))",
      op: "GT",
      warnValue: "5",
      criticalValue: "",
      sustainSecs: "300",
      intervalSecs: "60",
      notificationPolicySlug: "",
    });
    expect(r.externalId).toBe("m1");
    expect(calls[0]?.body).toEqual({
      monitor: {
        name: "Errors",
        collection_slug: "payments",
        prometheus_query: "sum(rate(errors[5m]))",
        series_conditions: {
          defaults: { warn: { conditions: [{ op: "GT", value: 5, sustain_secs: 300 }] } },
        },
        interval_secs: 60,
      },
    });
  });

  it("switches a drop rule's mode by writing the whole rule back", async () => {
    const { http, calls } = makeHttp((url, method) => {
      if (url.pathname === "/api/v1/config/drop-rules/d1" && method === "GET") {
        return {
          body: {
            drop_rule: { slug: "d1", name: "D", mode: "ENABLED", filters: [], created_at: "x" },
          },
        };
      }
      if (method === "PUT") return { body: { drop_rule: { slug: "d1" } } };
      return undefined;
    });
    await new ChronosphereClient(CREDS, { http }).invokeAction(
      "drop-rule",
      "acct:drop-rule:d1",
      "mode-disabled",
    );
    expect(calls[1]?.body).toEqual({
      drop_rule: { slug: "d1", name: "D", mode: "DISABLED", filters: [] },
    });
  });

  it("runs PromQL range and instant queries", async () => {
    const { http, calls } = makeHttp((url) => {
      if (url.pathname.endsWith("/query_range")) {
        return {
          body: {
            status: "success",
            data: {
              resultType: "matrix",
              result: [
                {
                  metric: { __name__: "up", job: "api" },
                  values: [
                    [100, "1"],
                    [160, "0"],
                  ],
                },
              ],
            },
          },
        };
      }
      if (url.pathname.endsWith("/query")) {
        return {
          body: {
            status: "success",
            data: { resultType: "vector", result: [{ metric: { job: "api" }, value: [100, "3"] }] },
          },
        };
      }
      if (url.pathname === "/api/v1/config/monitors/m")
        return { body: { monitor: { slug: "m", prometheus_query: "up" } } };
      return undefined;
    });
    const client = new ChronosphereClient(CREDS, { http });
    const series = await client.fetchMetricSeries("monitor", "acct:monitor:m", "acct", {
      startMs: 0,
      endMs: 3600_000,
    });
    expect(series[0]).toEqual({
      label: 'up{job="api"}',
      points: [
        { timestamp: 100_000, value: 1 },
        { timestamp: 160_000, value: 0 },
      ],
    });
    expect(calls[1]?.url.searchParams.get("step")).toBe("30");
    const q = await client.executeQuery("r", "acct", "sum(up)");
    expect(q.rows).toEqual([{ job: "api", value: 3, timestamp: new Date(100_000).toISOString() }]);
  });
});

describe("helpers", () => {
  it("describes conditions and parses matchers", () => {
    expect(
      describeConditions({
        defaults: { critical: { conditions: [{ op: "GEQ", value: 9, sustain_secs: 60 }] } },
      }),
    ).toBe("critical: >= 9 for 60s");
    expect(parseMatchers("env=prod, svc!=api\npod=~web-.*")).toEqual([
      { name: "env", value: "prod", type: "EXACT" },
      { name: "svc", value: "api", type: "NOT_EXACT" },
      { name: "pod", value: "web-.*", type: "REGEX" },
    ]);
    expect(() => parseMatchers("nonsense")).toThrow();
    expect(() => seriesConditions({ op: "GT" })).toThrow(/threshold/);
    expect(stepFor(6 * 3600_000)).toBe(180);
  });

  it("never stores webhook secrets", () => {
    expect(
      notifierType({ webhook: { url: "https://hooks.example.com/T0/secret?token=x" } }),
    ).toEqual({
      type: "Webhook",
      target: "hooks.example.com",
    });
  });
});

describe("preflight", () => {
  it("probes each area", async () => {
    const { http } = makeHttp((url) =>
      url.pathname.includes("service-accounts") ? { status: 403, body: {} } : { body: {} },
    );
    const res = await verifyChronoCredentials(new ChronosphereClient(CREDS, { http }).context);
    expect(res.checks.find((c) => c.capabilityId === "monitors")?.status).toBe("ok");
    expect(res.checks.find((c) => c.capabilityId === "service-accounts")?.status).toBe("missing");
  });
});

describe("terraform", () => {
  it("exports teams with members", () => {
    const r = mapConfig(
      "a",
      "team",
      { slug: "sre", name: "SRE", user_emails: ["a@x.io"] },
      "https://acme.chronosphere.io",
    );
    const out = JSON.stringify(exportResourcesToTerraform([r], () => chronosphereTerraformExport));
    expect(out).toContain("chronosphere_team");
    expect(out).toContain("a@x.io");
  });
});

import { describe, expect, it } from "vitest";
import { CoralogixClient } from "../client.js";
import { resolveRegion } from "../regions.js";
import { parseStatusFeed } from "../status-feed.js";
import { coralogixPolicyTemplate } from "../preflight.js";
import { makeHttp } from "./helpers.js";
import type { Reply } from "./helpers.js";

const ACCOUNT = "acct";

function client(route: (url: URL, method: string, body: unknown) => Reply, region = "eu2") {
  const { http, calls } = makeHttp(route);
  const c = new CoralogixClient({ apiKey: "test-key", region, unitPrice: "2" }, {
    http,
  } as unknown as ConstructorParameters<typeof CoralogixClient>[1]);
  return { c, calls };
}

describe("resolveRegion", () => {
  it("accepts ids, labels, domains, legacy domains and team hostnames", () => {
    expect(resolveRegion("eu2").apiUrl).toBe("https://api.eu2.coralogix.com");
    expect(resolveRegion("US1").id).toBe("us1");
    expect(resolveRegion("ap3.coralogix.com").id).toBe("ap3");
    expect(resolveRegion("cx498.coralogix.com").id).toBe("us2");
    expect(resolveRegion("coralogix.in").id).toBe("ap1");
    expect(resolveRegion("https://acme.app.coralogix.us/#/dashboards").id).toBe("us1");
    expect(resolveRegion("acme.coralogix.com").id).toBe("eu1");
    expect(resolveRegion("acme.app.eu2.coralogix.com").id).toBe("eu2");
    expect(resolveRegion("").id).toBe("eu1");
  });

  it("rejects a value that names no region", () => {
    expect(() => resolveRegion("example.com")).toThrow(/unknown region/);
  });
});

describe("listing", () => {
  it("pages alert definitions with the token cursor", async () => {
    const { c, calls } = client((url) => {
      if (url.pathname.endsWith("/alerts/alerts/v3")) {
        const token = url.searchParams.get("pagination.pageToken");
        return token
          ? {
              body: {
                alertDefs: [
                  {
                    id: "a2",
                    alertVersionId: "v2",
                    alertDefProperties: { name: "Second", enabled: false },
                  },
                ],
              },
            }
          : {
              body: {
                alertDefs: [
                  {
                    id: "a1",
                    alertVersionId: "v1",
                    status: "ALERT_DEF_STATUS_ALERTING",
                    alertDefProperties: {
                      name: "Errors spike",
                      priority: "ALERT_DEF_PRIORITY_P2",
                      type: "ALERT_DEF_TYPE_LOGS_THRESHOLD",
                    },
                  },
                ],
                pagination: { nextPageToken: "next" },
              },
            };
      }
      return { status: 404 };
    });
    const alerts = await c.listResources("alert", ACCOUNT);
    expect(alerts.map((a) => a.displayName)).toEqual(["Errors spike", "Second"]);
    expect(alerts[0]!.fields).toMatchObject({
      priority: "P2",
      type: "Logs threshold",
      status: "Alerting",
      enabled: true,
    });
    expect(alerts[1]!.fields["enabled"]).toBe(false);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.url.searchParams.get("pagination.pageSize")).toBe("100");
  });

  it("lists an empty type on 403 and throws on 401", async () => {
    const forbidden = client(() => ({ status: 403, body: {} }));
    await expect(forbidden.c.listResources("dashboard", ACCOUNT)).resolves.toEqual([]);
    const unauthorized = client(() => ({ status: 401, body: {} }));
    await expect(unauthorized.c.listResources("dashboard", ACCOUNT)).rejects.toThrow(/401/);
  });

  it("maps TCO policies with the TCO Optimizer's priority names", async () => {
    const { c } = client(() => ({
      body: {
        policies: [
          {
            id: "p1",
            name: "Debug to archive",
            priority: "PRIORITY_TYPE_LOW",
            enabled: true,
            applicationRule: { name: "prod,staging", ruleTypeId: "RULE_TYPE_ID_IS" },
            logRules: { severities: ["SEVERITY_DEBUG"] },
          },
          { id: "gone", name: "Deleted", deleted: true },
        ],
      },
    }));
    const policies = await c.listResources("tco-policy", ACCOUNT);
    expect(policies).toHaveLength(1);
    expect(policies[0]!.fields).toMatchObject({
      priority: "Low",
      priorityLabel: "Low (Compliance)",
      applications: "is prod, staging",
      subsystems: "All",
      severities: "Debug",
      source: "Logs",
    });
  });
});

describe("updates and actions", () => {
  it("replaces a policy with only the documented fields and the new priority", async () => {
    const { c, calls } = client((url, method) => {
      if (method === "GET" && url.pathname.endsWith("/dataplans/policies/v1/p1")) {
        return {
          body: {
            policy: {
              id: "p1",
              companyId: 42,
              name: "Debug",
              priority: "PRIORITY_TYPE_HIGH",
              enabled: true,
              order: 3,
              createdAt: "2026-01-01T00:00:00Z",
              logRules: { severities: ["SEVERITY_DEBUG"] },
            },
          },
        };
      }
      if (method === "PUT") {
        return { body: { policy: { id: "p1", name: "Debug", priority: "PRIORITY_TYPE_MEDIUM" } } };
      }
      return { status: 404 };
    });
    const updated = await c.updateResource("tco-policy", `${ACCOUNT}:tco-policy:p1`, ACCOUNT, {
      priority: "Medium",
    });
    expect(updated.fields["priority"]).toBe("Medium");
    const put = calls.find((x) => x.method === "PUT")!;
    expect(put.body).toEqual({
      id: "p1",
      name: "Debug",
      priority: "PRIORITY_TYPE_MEDIUM",
      enabled: true,
      logRules: { severities: ["SEVERITY_DEBUG"] },
    });
  });

  it("toggles a parsing rule group without sending rule ids", async () => {
    const { c, calls } = client((_url, method) => {
      if (method === "GET") {
        return {
          body: {
            ruleGroup: {
              id: "g1",
              name: "nginx",
              enabled: true,
              ruleMatchers: [{ applicationName: { value: "web" } }],
              ruleSubgroups: [
                {
                  id: "s1",
                  enabled: true,
                  order: 1,
                  rules: [{ id: "r1", name: "parse", parameters: { parseParameters: {} } }],
                },
              ],
            },
          },
        };
      }
      return { body: {} };
    });
    await c.invokeAction(
      "parsing-rule-group",
      `${ACCOUNT}:parsing-rule-group:g1`,
      "disable",
      ACCOUNT,
    );
    const put = calls.find((x) => x.method === "PUT")!;
    expect(put.url.pathname).toBe("/mgmt/openapi/5/parsing-rules/rule-groups/v1/g1");
    expect(put.body).toEqual({
      name: "nginx",
      enabled: false,
      ruleMatchers: [{ applicationName: { value: "web" } }],
      ruleSubgroups: [
        {
          enabled: true,
          order: 1,
          rules: [{ name: "parse", parameters: { parseParameters: {} } }],
        },
      ],
    });
  });

  it("edits one quota rule and writes the whole rule set back", async () => {
    const { c, calls } = client((_url, method, body) => {
      if (method === "GET") {
        return {
          body: {
            ruleSet: {
              id: "rs",
              rules: [
                {
                  entityType: "logs",
                  allocation: 60,
                  allocationType: "QUOTA_ALLOCATION_TYPE_PERCENTAGE",
                },
                {
                  entityType: "spans",
                  allocation: 40,
                  allocationType: "QUOTA_ALLOCATION_TYPE_PERCENTAGE",
                },
              ],
            },
          },
        };
      }
      return { body };
    });
    const rule = await c.updateResource("quota-rule", `${ACCOUNT}:quota-rule:spans`, ACCOUNT, {
      allocation: "30",
      canOverflow: "true",
    });
    expect(rule.fields).toMatchObject({ allocation: 30, canOverflow: true, allocationText: "30%" });
    const put = calls.find((x) => x.method === "PUT")!;
    expect((put.body as { ruleSet: { rules: unknown[] } }).ruleSet.rules).toHaveLength(2);
    await expect(
      c.updateResource("quota-rule", `${ACCOUNT}:quota-rule:spans`, ACCOUNT, { allocation: "130" }),
    ).rejects.toThrow(/100/);
  });

  it("reports a failed webhook test with the provider's message", async () => {
    const { c } = client(() => ({
      body: { failure: { statusCode: 404, displayMessage: "Endpoint not found" } },
    }));
    await expect(
      c.invokeAction("outgoing-webhook", `${ACCOUNT}:outgoing-webhook:w1`, "test", ACCOUNT),
    ).rejects.toThrow(/HTTP 404.*Endpoint not found/);
  });

  it("creates a Geo IP enrichment against the picked field", async () => {
    const { c, calls } = client((url, method) => {
      if (method === "POST" && url.pathname.endsWith("/enrichment-rules/v1")) {
        return {
          body: {
            enrichments: [
              { id: 7, fieldName: "client_ip", enrichmentType: { geoIp: { withAsn: true } } },
            ],
          },
        };
      }
      return { body: { customEnrichments: [] } };
    });
    const created = await c.createResource("enrichment", ACCOUNT, {
      kind: "geo-ip-asn",
      fieldName: "client_ip",
    });
    expect(created.externalId).toBe("7");
    expect(created.fields["kind"]).toBe("Geo IP with ASN");
    expect(calls[0]!.body).toEqual({
      requestEnrichments: [
        { fieldName: "client_ip", enrichmentType: { geoIp: { withAsn: true } } },
      ],
    });
  });
});

describe("quotas", () => {
  it("reports the daily quota against today's units and the configuration limits", async () => {
    const { c } = client((url) => {
      if (url.pathname.endsWith("/events2metrics/limits/v2")) {
        return {
          body: {
            companyId: "42",
            metricsLimit: { limit: 30, used: 12 },
            permutationsLimit: { limit: 30000, used: 100 },
          },
        };
      }
      if (url.pathname.endsWith("/aaa/teams/v2")) {
        return {
          body: {
            teams: [
              { teamId: { id: 41 }, teamName: "other", dailyQuota: 5 },
              { teamId: { id: 42 }, teamName: "acme", dailyQuota: 20 },
            ],
          },
        };
      }
      if (url.pathname.endsWith("/parsing-rules/limits/v1")) return { status: 403, body: {} };
      if (url.pathname.endsWith("/enrichment-rules/v1/limit"))
        return { body: { limit: 50, used: 3 } };
      if (url.pathname.endsWith("/daily/units")) {
        const today = new Date().toISOString().slice(0, 10);
        return {
          body: { units: [{ statsDate: `${today}T00:00:00Z`, totalUnits: { value: 15 } }] },
        };
      }
      if (url.pathname.endsWith("/daily/processed-gbs")) return { body: { gbs: [] } };
      return { status: 404, body: {} };
    });
    const quotas = await c.fetchQuotas(ACCOUNT);
    expect(quotas.find((q) => q.id === "team/daily-units")).toMatchObject({ used: 15, limit: 20 });
    expect(quotas.find((q) => q.id === "e2m/metrics")).toMatchObject({ used: 12, limit: 30 });
    expect(quotas.find((q) => q.id === "enrichments/rules")).toMatchObject({ used: 3, limit: 50 });
    expect(quotas.some((q) => q.id.startsWith("parsing/"))).toBe(false);
  });
});

describe("status feed", () => {
  it("normalises component names and reads regions from the incident title", () => {
    const incidents = parseStatusFeed(
      JSON.stringify({
        incidents: [
          {
            id: "i1",
            name: "EU2 - Delays in log ingestion",
            status: "investigating",
            impact: "major",
            created_at: "2026-10-04T10:00:00Z",
            components: [{ name: "Ingestion – Logs (Frequent Search)" }],
            incident_updates: [],
          },
          {
            id: "i2",
            name: "API errors",
            status: "identified",
            impact: "minor",
            created_at: "2026-10-04T10:00:00Z",
            components: [{ name: "API - External" }],
            incident_updates: [],
          },
        ],
      }),
    );
    expect(incidents[0]).toMatchObject({
      regions: ["eu2"],
      services: ["Ingestion - Logs (Frequent Search)"],
    });
    expect(incidents[1]).toMatchObject({ providerWide: true });
  });
});

describe("policy template", () => {
  it("lists presets and permissions for the selected capabilities", () => {
    const t = coralogixPolicyTemplate(["costs", "quota"]);
    expect(t.document).toContain("DataUsage");
    expect(t.document).toContain("data-usage:Read");
    expect(t.document).toContain("team-quota-rules:Read");
    expect(t.document).not.toContain("alerts:ReadConfig");
  });
});

import { describe, expect, it } from "vitest";
import { NewRelicClient } from "../client.js";
import { plugin } from "../plugin.js";
import { mapComponent } from "../status-feed.js";
import { newRelicTerraformExport } from "../terraform.js";
import { makeHttp } from "./helpers.js";

const creds = { region: "us", apiKey: "NRAK-TEST", accountId: "42" };
const ACCOUNTS = {
  actor: {
    accounts: [
      { id: 42, name: "Parent" },
      { id: 7, name: "Child" },
    ],
  },
};

function client(route: Parameters<typeof makeHttp>[0]) {
  const { http, calls } = makeHttp(route);
  return { c: new NewRelicClient(creds, { http } as never), calls };
}

describe("credential options", () => {
  it("lists the key's accounts for the usage account picker, in the chosen region", async () => {
    const { http, calls } = makeHttp(() => ACCOUNTS);
    const options = await plugin.listCredentialOptions!(
      "accountId",
      { region: "jp", apiKey: "NRAK-X" },
      { http } as never,
    );
    expect(options).toEqual([
      { id: "7", label: "Child", description: "7" },
      { id: "42", label: "Parent", description: "42" },
    ]);
    expect(calls[0]!.url).toBe("https://api.jp.newrelic.com/graphql");
    expect(calls[0]!.headers["API-Key"]).toBe("NRAK-X");
  });

  it("explains a rejected key", async () => {
    const { http } = makeHttp(() => ({
      errors: [{ message: "Invalid API key", extensions: { errorClass: "UNAUTHORIZED" } }],
    }));
    await expect(
      plugin.listCredentialOptions!("accountId", { apiKey: "NRAK-X" }, { http } as never),
    ).rejects.toThrow(/user key/);
  });

  it("declares the picker on the account field", () => {
    const field = plugin.manifest.credentialFields.find((f) => f.key === "accountId");
    expect(field?.providerOptions?.dependsOn).toEqual(["apiKey", "region"]);
  });
});

describe("NewRelicClient listing", () => {
  it("maps APM applications from entity search, paging by cursor", async () => {
    const { c, calls } = client((call) => {
      const cursor = call.variables["cursor"];
      return {
        actor: {
          entitySearch: {
            results: {
              nextCursor: cursor ? null : "next",
              entities: [
                {
                  guid: cursor ? "G2" : "G1",
                  name: cursor ? "billing" : "checkout",
                  accountId: 42,
                  account: { id: 42, name: "Parent" },
                  reporting: true,
                  alertSeverity: "WARNING",
                  language: "nodejs",
                  apmSummary: {
                    apdexScore: 0.94,
                    errorRate: 1.25,
                    responseTimeAverage: 0.123,
                    throughput: 300,
                  },
                  tags: [
                    { key: "env", values: ["prod"] },
                    { key: "accountId", values: ["42"] },
                  ],
                },
              ],
            },
          },
        },
      };
    });
    const rows = await c.listResources("apm-application", "acct");
    expect(rows.map((r) => r.externalId)).toEqual(["G1", "G2"]);
    expect(calls[0]!.variables["query"]).toBe("domain = 'APM' AND type = 'APPLICATION'");
    expect(rows[0]!.fields).toMatchObject({
      name: "checkout",
      language: "nodejs",
      apdex: 0.94,
      responseTimeMs: 123,
      errorRate: 1.25,
      nrAccountId: "42",
      tags: "env:prod",
      alertSeverity: "WARNING",
    });
  });

  it("lists alert policies in every account and skips one it may not read", async () => {
    const { c } = client((call) => {
      if (call.query.includes("accounts")) return ACCOUNTS;
      if (call.variables["accountId"] === 7) {
        return { errors: [{ message: "denied", extensions: { errorClass: "FORBIDDEN" } }] };
      }
      return {
        actor: {
          account: {
            alerts: {
              policiesSearch: {
                nextCursor: null,
                policies: [{ id: "99", name: "Prod", incidentPreference: "PER_CONDITION" }],
              },
            },
          },
        },
      };
    });
    const rows = await c.listResources("alert-policy", "acct");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.externalId).toBe("42:99");
    expect(rows[0]!.fields["accountName"]).toBe("Parent");
  });
});

describe("NewRelicClient mutations", () => {
  it("creates a policy in the picked account", async () => {
    const { c, calls } = client((call) => {
      if (call.query.includes("accounts")) return ACCOUNTS;
      return { alertsPolicyCreate: { id: "5", name: "New", incidentPreference: "PER_POLICY" } };
    });
    const r = await c.createResource("alert-policy", "acct", {
      nrAccountId: "7",
      name: " New ",
      incidentPreference: "PER_POLICY",
    });
    const create = calls.find((x) => x.query.includes("alertsPolicyCreate"))!;
    expect(create.variables).toEqual({
      accountId: 7,
      policy: { name: "New", incidentPreference: "PER_POLICY" },
    });
    expect(r.externalId).toBe("7:5");
  });

  it("disables a condition with the mutation for its type", async () => {
    const { c, calls } = client((call) => {
      if (call.query.includes("nrqlCondition(id")) {
        return {
          actor: { account: { alerts: { nrqlCondition: { id: "11", type: "BASELINE" } } } },
        };
      }
      return { alertsNrqlConditionBaselineUpdate: { id: "11" } };
    });
    await c.invokeAction("alert-condition", "acct:alert-condition:42:11", "disable", "acct");
    const update = calls.find((x) => x.query.includes("alertsNrqlConditionBaselineUpdate"))!;
    expect(update.variables).toEqual({ accountId: 42, id: "11", condition: { enabled: false } });
  });

  it("pauses a synthetic monitor through its type's update mutation", async () => {
    const { c, calls } = client((call) => {
      if (call.query.includes("entitySearch")) {
        return {
          actor: {
            entitySearch: {
              results: {
                nextCursor: null,
                entities: [{ guid: "M1", name: "ping", monitorType: "SIMPLE" }],
              },
            },
          },
        };
      }
      return { syntheticsUpdateSimpleMonitor: { errors: [] } };
    });
    await c.invokeAction("synthetic-monitor", "acct:synthetic-monitor:M1", "disable", "acct");
    const update = calls.find((x) => x.query.includes("syntheticsUpdateSimpleMonitor"))!;
    expect(update.variables).toEqual({ guid: "M1", monitor: { status: "DISABLED" } });
  });

  it("asks for a usage account before collecting cost", async () => {
    const c = new NewRelicClient({ apiKey: "NRAK-TEST" });
    await expect(
      c.fetchCostData("acct", { fromDate: "2026-09-01", toDate: "2026-09-02" }),
    ).rejects.toThrow(/usage account/);
  });
});

describe("status feed and Terraform", () => {
  it("maps regional components to one product", () => {
    expect(mapComponent("APM : Europe")).toEqual({ services: ["APM"] });
    expect(mapComponent("NRQL : US")).toEqual({ services: ["NRQL"], providerWide: true });
  });

  it("exports an alert policy with its composite import id", () => {
    const out = newRelicTerraformExport.mapResource({
      id: "acct:alert-policy:42:99",
      pluginId: "newrelic",
      resourceTypeId: "alert-policy",
      accountId: "acct",
      displayName: "Prod",
      fields: {
        name: "Prod",
        policyId: "99",
        nrAccountId: "42",
        incidentPreference: "PER_CONDITION",
      },
      resolvedOutputs: {},
      secretStates: [],
      externalId: "42:99",
      createdAt: "",
      updatedAt: "",
    });
    expect(out?.resource?.type).toBe("newrelic_alert_policy");
    expect(out?.resource?.importId).toBe("99:42");
  });
});

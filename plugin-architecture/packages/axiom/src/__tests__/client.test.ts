import { describe, expect, it } from "vitest";
import type { HostServices } from "@infrawrench/plugin-base";
import { AxiomApiError } from "../api.js";
import { firstRows, queryBase, rowsToSeries, tableRows } from "../apl.js";
import { AxiomClient, logLine, monitorBody, notifierProperties } from "../client.js";
import { mapDataset, mapNotifier, redactUrl } from "../mappers.js";
import { binFor } from "../metrics.js";
import { plugin } from "../plugin.js";
import { parseStatusFeed } from "../status-feed.js";
import { axiomTerraformExport } from "../terraform.js";
import { makeHttp, memorySecrets } from "./helpers.js";

const ACCOUNT = "acc";
const ORG = {
  id: "acme-x1",
  name: "Acme",
  plan: "axiomCloud",
  defaultEdgeDeployment: "cloud.eu-central-1.aws",
  license: {
    maxDatasets: 100,
    maxMonitors: 50,
    billingPeriodStart: "2026-10-01T00:00:00Z",
    monthlyIngestGb: 500,
  },
};

function client(
  route: Parameters<typeof makeHttp>[0],
  creds: Record<string, string> = { token: "xaat-abc" },
) {
  const { http, calls } = makeHttp(route);
  const secrets = memorySecrets();
  const c = new AxiomClient(creds, { http, secrets } as unknown as HostServices);
  return { c, calls, secrets };
}

const TABULAR = (fields: string[], columns: unknown[][]) => ({
  format: "tabular",
  tables: [{ name: "0", fields: fields.map((name) => ({ name })), columns }],
});

describe("construction", () => {
  it("needs a token, and an org for personal access tokens", () => {
    expect(() => new AxiomClient({})).toThrow(/token/);
    expect(() => new AxiomClient({ token: "xapt-1" })).toThrow(/organization/);
    expect(() => new AxiomClient({ token: "xapt-1", orgId: "o" })).not.toThrow();
  });
});

describe("listing", () => {
  it("sends the bearer token and org header, and lists datasets with their edge", async () => {
    const { c, calls } = client(
      (url) => {
        if (url.pathname === "/v2/orgs/acme-x1") return { body: ORG };
        if (url.pathname === "/v2/datasets") {
          return {
            body: [
              {
                id: "logs",
                name: "logs",
                kind: "axiom:events:v1",
                created: "2026-01-01T00:00:00Z",
              },
            ],
          };
        }
        return { status: 404 };
      },
      { token: "xapt-1", orgId: "acme-x1" },
    );
    const [d] = await c.listResources("dataset", ACCOUNT);
    expect(d?.fields["edgeDeployment"]).toBe("EU Central 1 (AWS)");
    expect(d?.resolvedOutputs["edgeUrl"]).toBe("https://eu-central-1.aws.edge.axiom.co");
    expect(calls[0]?.headers["Authorization"]).toBe("Bearer xapt-1");
    expect(calls[0]?.headers["x-axiom-org-id"]).toBe("acme-x1");
  });

  it("lists a 403 type empty when the token itself works", async () => {
    const { c } = client((url) => {
      if (url.pathname === "/v2/orgs") return { body: [ORG] };
      if (url.pathname === "/v2/users") return { status: 403, body: { message: "forbidden" } };
      return { status: 404 };
    });
    expect(await c.listResources("user", ACCOUNT)).toEqual([]);
  });

  it("throws on a 403 when the token itself is refused", async () => {
    const { c } = client(() => ({ status: 403, body: { message: "invalid token" } }));
    const err = await c.listResources("user", ACCOUNT).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AxiomApiError);
    expect((err as AxiomApiError).status).toBe(403);
    expect((err as Error).message).toContain("invalid token");
  });
});

describe("queries", () => {
  it("queries API tokens on the dataset's edge and personal tokens on api.axiom.co", async () => {
    const route = (url: URL) => {
      if (url.pathname === "/v2/orgs" || url.pathname === "/v2/orgs/o")
        return { body: url.pathname === "/v2/orgs" ? [ORG] : ORG };
      if (url.pathname === "/v2/datasets") return { body: [{ id: "logs", name: "logs" }] };
      return { body: TABULAR(["_time", "message"], [["2026-10-01T00:00:00Z"], ["hello"]]) };
    };
    const api = client(route);
    const res = await api.c.executeQuery("acc:dataset:logs", ACCOUNT, "['logs'] | take 1");
    expect(res.rows).toEqual([{ _time: "2026-10-01T00:00:00Z", message: "hello" }]);
    const q = api.calls.find((x) => x.method === "POST");
    expect(q?.url.toString()).toBe(
      "https://eu-central-1.aws.edge.axiom.co/v1/query/_apl?format=tabular",
    );

    const pat = client(route, { token: "xapt-1", orgId: "o" });
    await pat.c.executeQuery("acc:dataset:logs", ACCOUNT, "['logs'] | take 1");
    expect(pat.calls.find((x) => x.method === "POST")?.url.toString()).toBe(
      "https://api.axiom.co/v1/datasets/_apl?format=tabular",
    );
  });

  it("never sends a query to a non-Axiom host", () => {
    expect(queryBase("https://evil.example.com")).toBeUndefined();
    expect(queryBase("us-east-1.aws.edge.axiom.co")).toBe("https://us-east-1.aws.edge.axiom.co");
  });

  it("turns tabular results into rows and series", () => {
    const rows = tableRows({
      fields: [{ name: "_time" }, { name: "status" }, { name: "count_" }],
      columns: [
        ["2026-10-01T00:00:00Z", "2026-10-01T00:00:00Z", "2026-10-01T00:05:00Z"],
        ["200", "500", "200"],
        [10, 2, 12],
      ],
    });
    expect(rows).toHaveLength(3);
    const series = rowsToSeries(rows);
    expect(series.map((s) => [s.label, s.points.length])).toEqual([
      ["count_ (200)", 2],
      ["count_ (500)", 1],
    ]);
    expect(firstRows({ tables: [{ fields: [], columns: [] }] })).toEqual([]);
    expect(binFor({ startMs: 0, endMs: 86400_000 })).toBe("14m");
    expect(binFor({ startMs: 0, endMs: 7 * 86400_000 })).toBe("2h");
  });

  it("renders log lines from message fields or the whole event", () => {
    expect(logLine({ _time: "t", level: "warn", message: "disk full" })).toBe("t  WARN  disk full");
    expect(logLine({ _time: "t", _sysTime: "s", status: 500, path: "/" })).toBe(
      't  {"status":500,"path":"/"}',
    );
  });
});

describe("writes", () => {
  it("stores a created token's value as its output", async () => {
    const { c, calls, secrets } = client((url, method) => {
      if (url.pathname === "/v2/tokens" && method === "POST") {
        return {
          body: {
            id: "tok1",
            name: "ci",
            token: "xaat-new",
            orgCapabilities: {},
            datasetCapabilities: {},
          },
        };
      }
      return { status: 404 };
    });
    await c.createResource("api-token", ACCOUNT, {
      name: "ci",
      datasets: '["logs"]',
      datasetAccess: "ingest+query",
      orgRead: '["monitors"]',
    });
    expect(calls[0]?.body).toMatchObject({
      name: "ci",
      datasetCapabilities: { logs: { ingest: ["create"], query: ["read"] } },
      orgCapabilities: { monitors: ["read"] },
    });
    expect(secrets.store.get("acc:api-token:tok1#token")).toBe("xaat-new");
    expect(await c.resolveOutput("api-token", "acc:api-token:tok1", "token", ACCOUNT)).toBe(
      "xaat-new",
    );
  });

  it("disables a monitor by PUTting it back without read-only fields", async () => {
    const { c, calls } = client((url, method) => {
      if (url.pathname === "/v2/monitors/m1") {
        return method === "GET"
          ? {
              body: {
                id: "m1",
                name: "Errors",
                type: "Threshold",
                createdAt: "x",
                createdBy: "u",
                threshold: 5,
              },
            }
          : { body: { id: "m1", name: "Errors", disabled: true } };
      }
      if (url.pathname === "/v2/notifiers") return { body: [] };
      return { status: 404 };
    });
    await c.invokeAction("monitor", "acc:monitor:m1", "disable", ACCOUNT);
    const put = calls.find((x) => x.method === "PUT");
    expect(put?.body).toEqual({ name: "Errors", type: "Threshold", threshold: 5, disabled: true });
    expect(monitorBody({ id: "x", name: "n", updatedAt: "u" })).toEqual({ name: "n" });
  });

  it("builds notifier properties and keeps stored secrets on edit", () => {
    expect(notifierProperties("email", { target: "a@b.c, d@e.f" })).toEqual({
      email: { emails: ["a@b.c", "d@e.f"] },
    });
    expect(notifierProperties("pagerduty", {}, { pagerduty: { routingKey: "old" } })).toEqual({
      pagerduty: { routingKey: "old" },
    });
    expect(() => notifierProperties("pagerduty", {})).toThrow(/routing key/);
  });
});

describe("mappers", () => {
  it("redacts webhook URLs, which embed secrets", () => {
    expect(redactUrl("https://hooks.slack.com/services/T/B/secret")).toBe(
      "https://hooks.slack.com/…",
    );
    const n = mapNotifier(ACCOUNT, {
      id: "n1",
      name: "Slack",
      properties: { slack: { slackUrl: "https://hooks.slack.com/x" } },
    });
    expect(n.fields["target"]).toBe("https://hooks.slack.com/…");
    expect(n.fields["channel"]).toBe("slack");
    const d = mapDataset(ACCOUNT, { id: "a", name: "a", edgeDeployment: "cloud.us-east-1.aws" });
    expect(d.resolvedOutputs["edgeUrl"]).toBe("https://us-east-1.aws.edge.axiom.co");
  });
});

describe("quotas", () => {
  it("reports license limits against counts and audit-log usage", async () => {
    const { c } = client((url) => {
      if (url.pathname === "/v2/orgs") return { body: [ORG] };
      if (url.pathname === "/v2/datasets") return { body: [{ id: "a" }, { id: "b" }] };
      if (url.pathname === "/v2/monitors") return { body: [{ id: "m" }] };
      if (url.pathname === "/v2/users") return { body: [] };
      if (url.pathname.endsWith("/_apl")) return { body: TABULAR(["total"], [[123.5]]) };
      return { status: 404 };
    });
    const q = await c.fetchQuotas();
    expect(q.map((x) => [x.id, x.used, x.limit])).toEqual([
      ["datasets", 2, 100],
      ["monitors", 1, 50],
      ["monthly-ingest", 123.5, 500],
    ]);
  });
});

describe("credential options", () => {
  it("lists the organizations a personal token can see", async () => {
    const { http } = makeHttp(() => ({ body: [{ id: "o1", name: "One" }] }));
    const opts = await plugin.listCredentialOptions!("orgId", { token: "xapt-1" }, {
      http,
    } as unknown as HostServices);
    expect(opts).toEqual([{ id: "o1", label: "One", description: "o1" }]);
  });
});

describe("status feed", () => {
  it("keeps unresolved incidents only", () => {
    const body = JSON.stringify({
      incidents: [
        {
          id: "a",
          name: "Ingest delayed",
          status: "investigating",
          impact: "minor",
          components: [{ name: "Ingest" }],
        },
        {
          id: "b",
          name: "Old",
          status: "resolved",
          resolved_at: "2026-01-01T00:00:00Z",
          components: [],
        },
      ],
    });
    const out = parseStatusFeed(body);
    expect(out.map((i) => i.externalId)).toEqual(["a"]);
    expect(out[0]?.services).toEqual(["Ingest"]);
  });
});

describe("terraform", () => {
  it("maps monitors and turns notifier secrets into variables", () => {
    const base = {
      pluginId: "axiom",
      accountId: ACCOUNT,
      resolvedOutputs: {},
      secretStates: [],
      createdAt: "",
      updatedAt: "",
    };
    const m = axiomTerraformExport.mapResource({
      ...base,
      id: "acc:monitor:m1",
      resourceTypeId: "monitor",
      displayName: "Errors",
      externalId: "m1",
      fields: {
        name: "Errors",
        type: "Threshold",
        aplQuery: "['a'] | count",
        threshold: 5,
        intervalMinutes: 5,
      },
    });
    expect(m?.resource.type).toBe("axiom_monitor");
    expect(m?.resource.importId).toBe("m1");
    const n = axiomTerraformExport.mapResource({
      ...base,
      id: "acc:notifier:n1",
      resourceTypeId: "notifier",
      displayName: "PD",
      externalId: "n1",
      fields: { name: "PD", channel: "pagerduty" },
    });
    expect(n?.variables?.[0]?.sensitive).toBe(true);
  });
});

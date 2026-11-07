import { hostClient, hostPlugin } from "@infrawrench/plugin-base/effect";
import { describe, expect, it } from "vitest";
import {
  QuotaAccessError,
  type HostServices,
  type PreflightCapabilityCheck,
} from "@infrawrench/plugin-base";
import { AxiomApiError, statusOf } from "../api.js";
import { firstRows, queryBase, rowsToSeries, tableRows } from "../apl.js";
import { AxiomClient, logLine, monitorBody, notifierProperties } from "../client.js";
import { mapDataset, mapNotifier, notifierChannel, redactUrl } from "../mappers.js";
import { binFor } from "../metrics.js";
import { plugin } from "../plugin.js";
import { parseStatusFeed } from "../status-feed.js";
import { axiomTerraformExport } from "../terraform.js";
import type { AxNotifierProperties } from "../types.js";
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
  const c = hostClient(new AxiomClient(creds, { http, secrets } as unknown as HostServices));
  return { c, calls, secrets };
}

const TABULAR = (fields: string[], columns: unknown[][]) => ({
  format: "tabular",
  tables: [{ name: "0", fields: fields.map((name) => ({ name })), columns }],
});

describe("construction", () => {
  it("needs a token, and an org for personal access tokens", () => {
    expect(() => hostClient(new AxiomClient({}))).toThrow(/token/);
    expect(() => hostClient(new AxiomClient({ token: "xapt-1" }))).toThrow(/organization/);
    expect(() => hostClient(new AxiomClient({ token: "xapt-1", orgId: "o" }))).not.toThrow();
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
    const opts = await hostPlugin(plugin).listCredentialOptions!("orgId", { token: "xapt-1" }, {
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

describe("field listings", () => {
  const DATASETS = [
    { id: "a", name: "a", kind: "axiom:events:v1" },
    { id: "b", name: "b", kind: "axiom:events:v1" },
    { id: "m", name: "m", kind: "otel:metrics:v1" },
  ];

  /** Lists of both field types, with one dataset answering `reply`. */
  function fieldsWith(dataset: string, reply: { status: number } | "drop") {
    return client((url) => {
      if (url.pathname === "/v2/datasets") return { body: DATASETS };
      const name = url.searchParams.get("dataset") ?? url.pathname.split("/")[3];
      if (name === dataset) {
        if (reply === "drop") throw new Error("connection reset");
        return { status: reply.status, body: { message: "no" } };
      }
      if (url.pathname.endsWith("/fields"))
        return { body: [{ name: `${name}-f`, type: "string" }] };
      if (url.pathname === "/v2/vfields") return { body: [{ id: `${name}-v`, name: "v" }] };
      return { status: 404 };
    }).c;
  }

  for (const type of ["field", "virtual-field"]) {
    it(`fails a ${type} list when one dataset answers 500, rather than reading it as empty`, async () => {
      const err = await fieldsWith("b", { status: 500 })
        .listResources(type, ACCOUNT)
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AxiomApiError);
      expect(statusOf(err)).toBe(500);
    });

    it(`fails a ${type} list when one dataset's connection drops`, async () => {
      await expect(fieldsWith("b", "drop").listResources(type, ACCOUNT)).rejects.toThrow(
        "connection reset",
      );
    });

    it(`fails a ${type} list on a 400 from a dataset that is not a metrics dataset`, async () => {
      await expect(fieldsWith("b", { status: 400 }).listResources(type, ACCOUNT)).rejects.toThrow(
        /400/,
      );
    });

    for (const status of [403, 404]) {
      it(`keeps the other datasets of a ${type} list when one you cannot read answers ${status}`, async () => {
        const rows = await fieldsWith("b", { status }).listResources(type, ACCOUNT);
        expect(rows).toHaveLength(2);
      });
    }

    it(`reads the documented 400 of a metrics dataset as no ${type}s`, async () => {
      const rows = await fieldsWith("m", { status: 400 }).listResources(type, ACCOUNT);
      expect(rows).toHaveLength(2);
    });
  }
});

describe("annotations", () => {
  it("lists every annotation, with neither of the time filters the document refuses alone", async () => {
    const { c, calls } = client((url) => {
      if (url.pathname !== "/v2/annotations") return { status: 404 };
      const start = url.searchParams.has("start");
      if (start !== url.searchParams.has("end")) return { status: 400, body: { message: "range" } };
      return { body: [{ id: "ann_1", type: "deploy", datasets: ["a"] }] };
    });
    const rows = await c.listResources("annotation", ACCOUNT);
    expect(rows.map((r) => r.externalId)).toEqual(["ann_1"]);
    expect(calls[0]?.url.search).toBe("");
  });
});

describe("offset lists", () => {
  const LISTS = [
    ["dashboard", "/v2/dashboards"],
    ["starred-query", "/v2/apl-starred-queries"],
  ] as const;

  const rowsFor = (url: URL, count: number) =>
    Array.from({ length: count }, (_, i) => ({
      id: `${url.searchParams.get("offset")}-${i}`,
      uid: `${url.searchParams.get("offset")}-${i}`,
      name: "n",
    }));

  for (const [type, path] of LISTS) {
    it(`reads ${type}s past the old 5,000 row stop, at the largest page size`, async () => {
      const { c, calls } = client((url) => {
        if (url.pathname !== path) return { status: 404 };
        const offset = Number(url.searchParams.get("offset"));
        return { body: rowsFor(url, offset < 6000 ? 1000 : 3) };
      });
      expect(await c.listResources(type, ACCOUNT)).toHaveLength(6003);
      expect(calls.map((x) => x.url.searchParams.get("offset"))).toEqual([
        "0",
        "1000",
        "2000",
        "3000",
        "4000",
        "5000",
        "6000",
      ]);
      expect(calls.every((x) => x.url.searchParams.get("limit") === "1000")).toBe(true);
    });

    it(`refuses a ${type} list that never ends, after 50 pages`, async () => {
      const { c, calls } = client((url) =>
        url.pathname === path ? { body: rowsFor(url, 1000) } : { status: 404 },
      );
      await expect(c.listResources(type, ACCOUNT)).rejects.toThrow(
        "has more than Infrawrench reads",
      );
      expect(calls.filter((x) => x.url.pathname === path)).toHaveLength(50);
    });

    it(`refuses a ${type} page that is not a list, first and later`, async () => {
      const first = client((url) =>
        url.pathname === path ? { body: { message: "no" } } : { status: 404 },
      );
      await expect(first.c.listResources(type, ACCOUNT)).rejects.toThrow("is not a list");
      const later = client((url) => {
        if (url.pathname !== path) return { status: 404 };
        return url.searchParams.get("offset") === "0"
          ? { body: rowsFor(url, 1000) }
          : { body: { message: "no" } };
      });
      await expect(later.c.listResources(type, ACCOUNT)).rejects.toThrow("is not a list");
    });
  }

  it("still asks for everyone's saved queries", async () => {
    const { c, calls } = client((url) =>
      url.pathname === "/v2/apl-starred-queries" ? { body: [] } : { status: 404 },
    );
    await c.listResources("starred-query", ACCOUNT);
    expect(calls[0]?.url.searchParams.get("who")).toBe("all");
  });

  it("lists a 403 offset list empty when the token itself works", async () => {
    const { c } = client((url) => {
      if (url.pathname === "/v2/orgs") return { body: [ORG] };
      return { status: 403, body: { message: "forbidden" } };
    });
    expect(await c.listResources("dashboard", ACCOUNT)).toEqual([]);
  });
});

describe("editing a notifier", () => {
  const TEMPLATE = { title: "{{.Name}}", body: "{{.Value}}" };

  it("keeps the message template of every channel that has one", () => {
    const messageTemplate = TEMPLATE;
    expect(
      notifierProperties(
        "slack",
        { target: "https://new" },
        {
          slack: { slackUrl: "https://old", messageTemplate },
        },
      ),
    ).toEqual({ slack: { slackUrl: "https://new", messageTemplate } });
    expect(
      notifierProperties(
        "email",
        { target: "a@b.c" },
        { email: { emails: ["x@y.z"], messageTemplate } },
      ),
    ).toEqual({ email: { emails: ["a@b.c"], messageTemplate } });
    expect(
      notifierProperties(
        "microsoftTeams",
        { target: "https://new" },
        { microsoftTeams: { microsoftTeamsUrl: "https://old", messageTemplate } },
      ),
    ).toEqual({ microsoftTeams: { microsoftTeamsUrl: "https://new", messageTemplate } });
    expect(
      notifierProperties(
        "discordWebhook",
        { target: "https://new" },
        { discordWebhook: { discordWebhookUrl: "https://old", messageTemplate } },
      ),
    ).toEqual({ discordWebhook: { discordWebhookUrl: "https://new", messageTemplate } });
    expect(
      notifierProperties(
        "discord",
        { target: "2" },
        { discord: { discordChannel: "1", discordToken: "t", messageTemplate } },
      ),
    ).toEqual({ discord: { discordChannel: "2", discordToken: "t", messageTemplate } });
  });

  it("keeps a PagerDuty API token when the routing key changes", () => {
    expect(
      notifierProperties(
        "pagerduty",
        { secret: "new" },
        { pagerduty: { routingKey: "old", token: "api-token" } },
      ),
    ).toEqual({ pagerduty: { routingKey: "new", token: "api-token" } });
  });

  it("keeps an email notifier's addresses when the target is blanked", () => {
    expect(notifierProperties("email", { target: " " }, { email: { emails: ["x@y.z"] } })).toEqual({
      email: { emails: ["x@y.z"] },
    });
  });

  it("edits the channels the form does not offer, keeping what was not edited", () => {
    expect(
      notifierProperties(
        "jiraServiceManagement",
        { secret: "new" },
        { jiraServiceManagement: { apiKey: "old" } },
      ),
    ).toEqual({ jiraServiceManagement: { apiKey: "new" } });
    expect(
      notifierProperties("amp", { target: "https://new" }, { amp: { webhookUrl: "o" } }),
    ).toEqual({ amp: { webhookUrl: "https://new" } });
    expect(
      notifierProperties(
        "cursor",
        { secret: "new" },
        { cursor: { webhookUrl: "https://old", token: "old" } },
      ),
    ).toEqual({ cursor: { webhookUrl: "https://old", token: "new" } });
    expect(
      notifierProperties(
        "claudeCode",
        { target: "trig_2" },
        { claudeCode: { routineId: "trig_1", token: "old" } },
      ),
    ).toEqual({ claudeCode: { routineId: "trig_2", token: "old" } });
    expect(
      notifierProperties(
        "chatgptWorkspaceAgent",
        { secret: "new" },
        { chatgptWorkspaceAgent: { triggerId: "agtch_1", token: "old" } },
      ),
    ).toEqual({ chatgptWorkspaceAgent: { triggerId: "agtch_1", token: "new" } });
  });

  it("names every documented channel", () => {
    const channel = (properties: AxNotifierProperties) => notifierChannel(properties).channel;
    expect(channel({ jiraServiceManagement: { apiKey: "k" } })).toBe("jiraServiceManagement");
    expect(channel({ amp: { webhookUrl: "u" } })).toBe("amp");
    expect(channel({ cursor: { webhookUrl: "u", token: "t" } })).toBe("cursor");
    expect(channel({ claudeCode: { routineId: "r", token: "t" } })).toBe("claudeCode");
    expect(channel({ chatgptWorkspaceAgent: { triggerId: "a", token: "t" } })).toBe(
      "chatgptWorkspaceAgent",
    );
  });

  it("refuses to rewrite a channel it does not know, and renaming one keeps its properties", async () => {
    const stored = { somethingNew: { key: "value" } };
    const { c, calls } = client((url, method, body) => {
      if (url.pathname !== "/v2/notifiers/n1") return { status: 404 };
      return method === "GET"
        ? { body: { id: "n1", name: "Old", properties: stored } }
        : { body: { id: "n1", ...(body as object) } };
    });
    await expect(
      c.updateResource("notifier", "acc:notifier:n1", ACCOUNT, { target: "x" }),
    ).rejects.toThrow(/edit it in Axiom/);
    expect(calls.some((x) => x.method === "PUT")).toBe(false);

    await c.updateResource("notifier", "acc:notifier:n1", ACCOUNT, { name: "New" });
    expect(calls.find((x) => x.method === "PUT")?.body).toEqual({
      name: "New",
      properties: stored,
    });
  });

  it("sends the template back on a real edit of the target", async () => {
    const { c, calls } = client((url, method, body) => {
      if (url.pathname !== "/v2/notifiers/n1") return { status: 404 };
      return method === "GET"
        ? {
            body: {
              id: "n1",
              name: "Slack",
              disabledUntil: "2030-01-01T00:00:00Z",
              properties: { slack: { slackUrl: "https://old", messageTemplate: TEMPLATE } },
            },
          }
        : { body: { id: "n1", ...(body as object) } };
    });
    await c.updateResource("notifier", "acc:notifier:n1", ACCOUNT, { target: "https://new" });
    expect(calls.find((x) => x.method === "PUT")?.body).toEqual({
      name: "Slack",
      disabledUntil: "2030-01-01T00:00:00Z",
      properties: { slack: { slackUrl: "https://new", messageTemplate: TEMPLATE } },
    });
  });
});

describe("an API token that GET /v2/orgs refuses", () => {
  const OK_LISTS: Record<string, unknown[]> = {
    "/v2/datasets": [{ id: "logs", name: "logs", edgeDeployment: "cloud.us-east-1.aws" }],
  };

  const messageOf = (check: PreflightCapabilityCheck | undefined) =>
    check && "message" in check ? check.message : undefined;

  /** `/v2/orgs` answers `orgStatus`; anything not in `lists` answers 403. */
  function refusing(
    orgStatus = 403,
    lists = OK_LISTS,
    creds: Record<string, string> = { token: "xaat-abc" },
  ) {
    return client((url) => {
      if (url.pathname.startsWith("/v2/orgs")) {
        return { status: orgStatus, body: { message: "needs a personal access token" } };
      }
      const list = lists[url.pathname];
      if (list) return { body: list };
      if (url.pathname.endsWith("/_apl")) return { body: TABULAR(["x"], [[1]]) };
      return { status: 403, body: { message: "forbidden" } };
    }, creds);
  }

  for (const status of [400, 401, 403, 404]) {
    it(`checks each capability on its own after a ${status}`, async () => {
      const report = await refusing(status).c.verifyCredentials();
      const of = (id: string) => report.checks.find((x) => x.capabilityId === id);
      expect(of("resources")?.status).toBe("ok");
      expect(of("monitors")?.status).toBe("missing");
      expect(messageOf(of("monitors"))).toBeUndefined();
      expect(of("metrics")?.status).toBe("unknown");
      expect(report.identity).toBeUndefined();
    });
  }

  it("still says the token was rejected when nothing at all answers", async () => {
    const report = await refusing(403, {}).c.verifyCredentials();
    expect(report.checks.every((x) => x.status === "missing")).toBe(true);
    expect(messageOf(report.checks[0])).toMatch(/rejected the token/);
  });

  it("does not call a token rejected when only a route without a probe of its own answers", async () => {
    const report = await refusing(403, { "/v2/views": [] }).c.verifyCredentials();
    expect(report.checks.find((x) => x.capabilityId === "resources")?.status).toBe("missing");
    expect(report.checks.find((x) => x.capabilityId === "metrics")?.status).toBe("unknown");
    expect(messageOf(report.checks[0])).toBeUndefined();
  });

  it("rejects a personal access token on the organization alone", async () => {
    const { c, calls } = refusing(403, OK_LISTS, { token: "xapt-1", orgId: "o" });
    const report = await c.verifyCredentials();
    expect(messageOf(report.checks[0])).toMatch(/rejected the token/);
    expect(calls).toHaveLength(1);
  });

  it("lists a 403 type empty once another list proves the token good", async () => {
    expect(await refusing().c.listResources("user", ACCOUNT)).toEqual([]);
  });

  it("does not read a personal access token's refusal as a missing capability", async () => {
    const { c } = refusing(403, OK_LISTS, { token: "xapt-1", orgId: "o" });
    await expect(c.listResources("user", ACCOUNT)).rejects.toThrow(/403/);
  });

  it("remembers a refused token for a minute, rather than probing per type", async () => {
    const { c, calls } = refusing(403, {});
    await expect(c.listResources("user", ACCOUNT)).rejects.toThrow(/403/);
    const after = calls.length;
    await expect(c.listResources("monitor", ACCOUNT)).rejects.toThrow(/403/);
    expect(calls.length).toBeLessThan(after + 3);
  });

  it("checks the token live, so a token revoked after a read does not list everything empty", async () => {
    let revoked = false;
    const { c } = client((url) => {
      if (!revoked && url.pathname === "/v2/orgs") return { body: [ORG] };
      return { status: 403, body: { message: "invalid token" } };
    });
    expect(await c.listResources("organization", ACCOUNT)).toHaveLength(1);
    revoked = true;
    await expect(c.listResources("user", ACCOUNT)).rejects.toThrow(/403/);
  });

  it("has no organization to list when the token is good", async () => {
    expect(await refusing().c.listResources("organization", ACCOUNT)).toEqual([]);
    expect(await refusing(401).c.listResources("organization", ACCOUNT)).toEqual([]);
  });

  it("fails the organization list when the token is refused everywhere", async () => {
    await expect(refusing(403, {}).c.listResources("organization", ACCOUNT)).rejects.toThrow(/403/);
  });

  it("fails the organization list on a server error", async () => {
    await expect(refusing(500).c.listResources("organization", ACCOUNT)).rejects.toThrow(/500/);
  });

  it("reads an organization list with nothing in it as no organization", async () => {
    const { c } = client((url) => {
      if (url.pathname === "/v2/orgs") return { body: [] };
      if (url.pathname === "/v2/datasets") return { body: [] };
      return { status: 403 };
    });
    expect(await c.listResources("organization", ACCOUNT)).toEqual([]);
  });

  it("explains plan limits instead of failing them", async () => {
    for (const status of [400, 401, 403]) {
      const err = await refusing(status)
        .c.fetchQuotas()
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(QuotaAccessError);
      expect((err as Error).message).toMatch(/personal access token/);
    }
  });

  it("still queries a dataset on its own edge", async () => {
    const { c, calls } = refusing();
    await c.executeQuery("acc:dataset:logs", ACCOUNT, "['logs'] | take 1");
    expect(calls.find((x) => x.method === "POST")?.url.host).toBe("us-east-1.aws.edge.axiom.co");
  });

  it("offers no organizations to pick, and fails a personal token's picker", async () => {
    const pick = (token: string) =>
      hostPlugin(plugin).listCredentialOptions!("orgId", { token }, {
        http: makeHttp(() => ({ status: 403, body: { message: "no" } })).http,
      } as unknown as HostServices);
    expect(await pick("xaat-1")).toEqual([]);
    await expect(pick("xapt-1")).rejects.toThrow(/403/);
  });
});

describe("lists answered whole", () => {
  const LISTS = [
    ["dataset", "/v2/datasets"],
    ["monitor", "/v2/monitors"],
    ["notifier", "/v2/notifiers"],
    ["view", "/v2/views"],
    ["annotation", "/v2/annotations"],
    ["api-token", "/v2/tokens"],
    ["user", "/v2/users"],
    ["field", "/v2/datasets/a/fields"],
    ["virtual-field", "/v2/vfields"],
    ["organization", "/v2/orgs"],
  ] as const;

  /** `path` answers `reply`, and the rest as much as the list needs to reach it. */
  const listing = (path: string, reply: { body?: unknown }) =>
    client((url) => {
      if (url.pathname === path) return reply;
      if (url.pathname === "/v2/datasets") return { body: [{ id: "a", name: "a" }] };
      if (url.pathname === "/v2/notifiers") return { body: [] };
      if (url.pathname === "/v2/orgs") return { body: [ORG] };
      return { status: 404 };
    }).c;

  for (const [type, path] of LISTS) {
    it(`refuses a ${type} list answered with no body`, async () => {
      await expect(listing(path, {}).listResources(type, ACCOUNT)).rejects.toThrow("is not a list");
    });

    it(`refuses a ${type} list answered with an object`, async () => {
      await expect(
        listing(path, { body: { message: "no" } }).listResources(type, ACCOUNT),
      ).rejects.toThrow("is not a list");
    });
  }

  it("reads an explicit JSON null as none, as it always has", async () => {
    expect(await listing("/v2/views", { body: null }).listResources("view", ACCOUNT)).toEqual([]);
  });
});

describe("blank ids", () => {
  const cases: Array<[string, (c: ReturnType<typeof client>["c"]) => Promise<unknown>]> = [
    ["delete a dataset", (c) => c.deleteResource("dataset", "")],
    ["delete a monitor", (c) => c.deleteResource("monitor", "acc:monitor:")],
    ["delete a field with no name", (c) => c.deleteResource("field", "acc:field:logs/")],
    ["delete a field with no dataset", (c) => c.deleteResource("field", "acc:field:/f")],
    ["edit a notifier", (c) => c.updateResource("notifier", "", ACCOUNT, { name: "n" })],
    ["edit a field", (c) => c.updateResource("field", "acc:field:logs/", ACCOUNT, { unit: "s" })],
    ["run an action", (c) => c.invokeAction("dataset", "", "trim-7d", ACCOUNT)],
  ];
  for (const [name, run] of cases) {
    it(`refuses to ${name}`, async () => {
      const { c, calls } = client(() => ({ body: {} }));
      await expect(run(c)).rejects.toThrow(/without an id/);
      expect(calls).toEqual([]);
    });
  }

  it("still reaches a field whose name holds a slash", async () => {
    const { c, calls } = client(() => ({ body: {} }));
    await c.deleteResource("field", "acc:field:logs/a/b");
    expect(calls[0]?.url.pathname).toBe("/v2/datasets/logs/fields/a%2Fb");
  });
});

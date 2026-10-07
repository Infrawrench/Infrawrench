import { describe, expect, it } from "vitest";
import type { HostServices } from "@infrawrench/plugin-base";
import { ChecklyApiError } from "../api.js";
import { ChecklyClient, channelConfig, writable, CHECK_WRITABLE } from "../client.js";
import { checkTarget, mapCheck, mapChannel, mapDashboard } from "../mappers.js";
import { resultsToSeries } from "../metrics.js";
import { plugin } from "../plugin.js";
import { parseStatusFeed } from "../status-feed.js";
import { checklyTerraformExport } from "../terraform.js";
import { makeHttp, memorySecrets } from "./helpers.js";

const ACCOUNT = "acc";
const creds = { apiKey: "cu_key", accountId: "acct-1" };

function client(route: Parameters<typeof makeHttp>[0]) {
  const { http, calls } = makeHttp(route);
  const secrets = memorySecrets();
  return {
    c: new ChecklyClient(creds, { http, secrets } as unknown as HostServices),
    calls,
    secrets,
  };
}

describe("construction and auth", () => {
  it("needs a key and an account, and sends both", async () => {
    expect(() => new ChecklyClient({ apiKey: "k" })).toThrow(/accountId/);
    const { c, calls } = client(() => ({ body: [] }));
    await c.listResources("alert-channel", ACCOUNT);
    expect(calls[0]?.headers["Authorization"]).toBe("Bearer cu_key");
    expect(calls[0]?.headers["X-Checkly-Account"]).toBe("acct-1");
  });

  it("lists accounts for the picker without an account header", async () => {
    const { http, calls } = makeHttp(() => ({
      body: [{ id: "a1", name: "Acme", planDisplayName: "Team" }],
    }));
    const opts = await plugin.listCredentialOptions!("accountId", { apiKey: "cu_x" }, {
      http,
    } as unknown as HostServices);
    expect(opts).toEqual([{ id: "a1", label: "Acme", description: "Team, a1" }]);
    expect(calls[0]?.headers["X-Checkly-Account"]).toBeUndefined();
  });
});

describe("listing", () => {
  it("pages checks and joins their status", async () => {
    const page = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        id: `c${i}`,
        name: `C${i}`,
        checkType: "URL",
        activated: true,
        request: { url: "https://x" },
      }));
    const { c, calls } = client((url) => {
      if (url.pathname === "/v1/checks")
        return { body: url.searchParams.get("page") === "1" ? page(100) : page(3) };
      if (url.pathname === "/v1/check-statuses")
        return { body: [{ checkId: "c0", hasFailures: true, sslDaysRemaining: 10 }] };
      return { status: 404 };
    });
    const checks = await c.listResources("check", ACCOUNT);
    expect(checks).toHaveLength(103);
    expect(checks[0]?.fields["status"]).toBe("Failing");
    expect(checks[1]?.fields["status"]).toBeUndefined();
    expect(checks[0]?.fields["sslDaysRemaining"]).toBe(10);
    expect(
      calls
        .filter((x) => x.url.pathname === "/v1/checks")
        .map((x) => x.url.searchParams.get("page")),
    ).toEqual(["1", "2"]);
  });

  it("lists a type the role cannot see as empty, and keeps the status on errors", async () => {
    const { c } = client((url) =>
      url.pathname === "/v1/private-locations"
        ? { status: 403, body: { message: "Forbidden" } }
        : { status: 401, body: { message: "Unauthorized" } },
    );
    expect(await c.listResources("private-location", ACCOUNT)).toEqual([]);
    const err = await c.listResources("dashboard", ACCOUNT).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ChecklyApiError);
    expect((err as ChecklyApiError).status).toBe(401);
  });
});

describe("actions", () => {
  it("deactivates a check by PUTting its writable fields to its type's route", async () => {
    const { c, calls } = client((url, method) => {
      if (url.pathname === "/v1/checks/c1" && method === "GET") {
        return {
          body: {
            id: "c1",
            name: "Home",
            checkType: "URL",
            activated: true,
            created_at: "x",
            projectBindings: {},
            request: { url: "https://x" },
          },
        };
      }
      return { body: {} };
    });
    await c.invokeAction("check", "acc:check:c1", "deactivate", ACCOUNT);
    const put = calls.find((x) => x.method === "PUT");
    expect(put?.url.pathname).toBe("/v1/checks/url/c1");
    expect(put?.body).toEqual({
      name: "Home",
      checkType: "URL",
      activated: false,
      request: { url: "https://x" },
    });
  });

  it("runs a check through check sessions", async () => {
    const { c, calls } = client(() => ({ status: 201, body: { sessions: [] } }));
    await c.invokeAction("check", "acc:check:c1", "run", ACCOUNT);
    expect(calls[0]?.url.pathname).toBe("/v2/check-sessions/trigger");
    expect(calls[0]?.body).toEqual({ target: { checkId: ["c1"] } });
  });

  it("stores a generated private location key as an output", async () => {
    const { c, secrets } = client(() => ({
      status: 201,
      body: { id: "k1", rawKey: "pl_secret", maskedKey: "pl_…" },
    }));
    await c.invokeAction("private-location", "acc:private-location:p1", "generate-key", ACCOUNT);
    expect(secrets.store.get("acc:private-location:p1#agentKey")).toBe("pl_secret");
    expect(
      await c.resolveOutput("private-location", "acc:private-location:p1", "agentKey", ACCOUNT),
    ).toBe("pl_secret");
  });
});

describe("creating", () => {
  it("creates an API check with a status assertion", async () => {
    const { c, calls } = client(() => ({
      status: 201,
      body: { id: "n1", name: "API", checkType: "API" },
    }));
    await c.createResource("check", ACCOUNT, {
      checkType: "API",
      name: "API",
      url: "https://api.example.com/health",
      method: "GET",
      expectedStatus: "204",
      frequency: "5",
      locations: '["eu-west-1"]',
      tags: "prod, api",
    });
    expect(calls[0]?.url.pathname).toBe("/v1/checks/api");
    expect(calls[0]?.url.searchParams.get("autoAssignAlerts")).toBe("true");
    expect(calls[0]?.body).toMatchObject({
      frequency: 5,
      locations: ["eu-west-1"],
      tags: ["prod", "api"],
      request: {
        url: "https://api.example.com/health",
        assertions: [{ source: "STATUS_CODE", target: "204" }],
      },
    });
  });

  it("builds alert channel configs", () => {
    expect(channelConfig("EMAIL", { target: "ops@x.io" })).toEqual({ address: "ops@x.io" });
    expect(channelConfig("PAGERDUTY", { secret: "k", name: "Ops" })).toEqual({
      serviceKey: "k",
      serviceName: "Ops",
    });
  });
});

describe("mappers", () => {
  it("describes targets and redacts webhook URLs", () => {
    expect(checkTarget({ checkType: "TCP", request: { hostname: "db", port: 5432 } })).toBe(
      "db:5432",
    );
    expect(checkTarget({ checkType: "API", request: { url: "https://a", method: "POST" } })).toBe(
      "POST https://a",
    );
    expect(checkTarget({ checkType: "DNS", request: { query: "a.com", recordType: "MX" } })).toBe(
      "a.com (MX)",
    );
    const ch = mapChannel(ACCOUNT, {
      id: 1,
      type: "WEBHOOK",
      config: { name: "Hook", url: "https://hooks.example.com/secret/token" },
    });
    expect(ch.fields["target"]).toBe("Hook (hooks.example.com)");
    expect(
      mapDashboard(ACCOUNT, { dashboardId: 7, customUrl: "acme", header: "Acme" }).fields["url"],
    ).toBe("https://acme.checklyhq.com");
    const hb = mapCheck(ACCOUNT, {
      id: "h",
      checkType: "HEARTBEAT",
      heartbeat: { period: 1, periodUnit: "hours", pingToken: "tok" },
    });
    expect(hb.resolvedOutputs["pingUrl"]).toBe("https://ping.checklyhq.com/tok");
    expect(writable({ id: "x", name: "n", created_at: "t" }, CHECK_WRITABLE)).toEqual({
      name: "n",
    });
  });

  it("buckets check results into per-location series and failures", () => {
    const series = resultsToSeries(
      [
        { startedAt: "2026-10-01T00:00:10Z", responseTime: 100, runLocation: "eu-west-1" },
        {
          startedAt: "2026-10-01T00:00:20Z",
          responseTime: 300,
          runLocation: "eu-west-1",
          hasFailures: true,
        },
        { startedAt: "2026-10-01T00:00:30Z", responseTime: 50, runLocation: "us-east-1" },
      ],
      { startMs: Date.parse("2026-10-01T00:00:00Z"), endMs: Date.parse("2026-10-01T01:00:00Z") },
    );
    expect(series.map((s) => [s.label, s.points[0]?.value])).toEqual([
      ["Response time (eu-west-1)", 200],
      ["Response time (us-east-1)", 50],
      ["Failed runs", 1],
    ]);
  });
});

describe("status feed", () => {
  it("keeps the newest unresolved update per incident and skips scheduled maintenance", () => {
    const item = (title: string, guid: string, desc: string, date: string) =>
      `<item><title><![CDATA[${title}]]></title><link>${guid}</link><guid>${guid}</guid><pubDate>${date}</pubDate><description><![CDATA[${desc}]]></description></item>`;
    const body = `<?xml version="1.0"?><rss version="2.0"><channel>${[
      item(
        "Maintenance scheduled: DB",
        "https://is.checkly.online/maintenance/m1",
        "<p>Later</p>",
        "Mon, 05 Oct 2026 13:34:44 GMT",
      ),
      item(
        "Delays in us-east-1",
        "https://is.checkly.online/incident/i1",
        "Status: Monitoring<br/>Fix deployed.<br/><br/>Affected components<ul><li>Check runs</li></ul>",
        "Tue, 06 Oct 2026 10:00:00 GMT",
      ),
      item(
        "Delays in us-east-1",
        "https://is.checkly.online/incident/i1",
        "Status: Investigating<br/>Looking.",
        "Tue, 06 Oct 2026 09:00:00 GMT",
      ),
      item(
        "Old",
        "https://is.checkly.online/incident/i0",
        "Status: Resolved<br/>Done.",
        "Wed, 23 Sep 2026 14:12:43 GMT",
      ),
    ].join("")}</channel></rss>`;
    const out = parseStatusFeed(body);
    expect(out.map((i) => [i.externalId, i.state])).toEqual([
      ["https://is.checkly.online/incident/i1", "monitoring"],
    ]);
    expect(out[0]?.services).toEqual(["Check runs"]);
  });
});

describe("terraform", () => {
  it("maps URL monitors and secret variables", () => {
    const base = {
      pluginId: "checkly",
      accountId: ACCOUNT,
      resolvedOutputs: {},
      secretStates: [],
      createdAt: "",
      updatedAt: "",
    };
    const m = checklyTerraformExport.mapResource({
      ...base,
      id: "acc:check:c1",
      resourceTypeId: "check",
      displayName: "Home",
      externalId: "c1",
      fields: {
        name: "Home",
        checkType: "URL",
        target: "https://x.io",
        frequency: "10",
        activated: true,
        locations: "eu-west-1",
      },
    });
    expect(m?.resource.type).toBe("checkly_url_monitor");
    const v = checklyTerraformExport.mapResource({
      ...base,
      id: "acc:variable:TOKEN",
      resourceTypeId: "variable",
      displayName: "TOKEN",
      externalId: "TOKEN",
      fields: { key: "TOKEN", secret: true },
    });
    expect(v?.variables?.[0]?.name).toBe("checkly_env_token");
  });
});

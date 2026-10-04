import { describe, expect, it } from "vitest";
import { nextPageUrl } from "../api.js";
import { SentryClient, parseSchedule } from "../client.js";
import { plugin } from "../plugin.js";
import { resolveInstance } from "../regions.js";
import { TOP_ISSUES_KEY } from "../render.js";
import { mapComponent } from "../status-feed.js";
import { sentryTerraformExport } from "../terraform.js";
import type { Call } from "./helpers.js";
import { makeHttp, stats } from "./helpers.js";

const creds = { region: "us", authToken: "sntryi_TEST", organization: "acme" };
const ACCOUNT = "acct";

function client(route: (call: Call) => unknown, extra: Record<string, string> = {}) {
  const { http, calls } = makeHttp(route);
  return { c: new SentryClient({ ...creds, ...extra }, { http } as never), calls };
}

describe("regions", () => {
  it("resolves sentry.io regions and self-hosted URLs", () => {
    expect(resolveInstance("de").apiUrl).toBe("https://de.sentry.io");
    expect(resolveInstance("").apiUrl).toBe("https://us.sentry.io");
    const self = resolveInstance("self-hosted", "sentry.example.com/api/0/");
    expect(self).toMatchObject({ apiUrl: "https://sentry.example.com", selfHosted: true });
    expect(resolveInstance("", "https://de.sentry.io").id).toBe("de");
    expect(() => resolveInstance("self-hosted", "")).toThrow(/base URL/);
  });
});

describe("credential options", () => {
  it("lists organizations in the chosen region", async () => {
    const { http, calls } = makeHttp(() => [
      { slug: "zeta", name: "Zeta" },
      { slug: "acme", name: "Acme" },
    ]);
    const options = await plugin.listCredentialOptions!(
      "organization",
      { region: "de", authToken: "sntryu_X" },
      { http } as never,
    );
    expect(options).toEqual([
      { id: "acme", label: "Acme", description: "acme" },
      { id: "zeta", label: "Zeta", description: "zeta" },
    ]);
    expect(calls[0]!.url.origin).toBe("https://de.sentry.io");
    expect(calls[0]!.url.pathname).toBe("/api/0/organizations/");
    expect(calls[0]!.headers["Authorization"]).toBe("Bearer sntryu_X");
  });

  it("refuses organization tokens and explains a rejected token", async () => {
    await expect(
      plugin.listCredentialOptions!("organization", { authToken: "sntrys_abc" }),
    ).rejects.toThrow(/organization token/);
    const { http } = makeHttp(() => ({ status: 401, body: { detail: "Invalid token" } }));
    await expect(
      plugin.listCredentialOptions!("organization", { authToken: "sntryu_X" }, { http } as never),
    ).rejects.toThrow(/org:read/);
  });

  it("declares the picker on the organization field", () => {
    const field = plugin.manifest.credentialFields.find((f) => f.key === "organization");
    expect(field?.providerOptions?.dependsOn).toEqual(["authToken", "region"]);
  });
});

describe("pagination", () => {
  it("follows rel=next only while results=true", () => {
    const link =
      '<https://us.sentry.io/api/0/x/?cursor=0:0:1>; rel="previous"; results="false"; cursor="0:0:1", <https://us.sentry.io/api/0/x/?cursor=0:100:0>; rel="next"; results="true"; cursor="0:100:0"';
    expect(nextPageUrl(link)).toBe("https://us.sentry.io/api/0/x/?cursor=0:100:0");
    expect(nextPageUrl(link.replace('results="true"', 'results="false"'))).toBeUndefined();
  });

  it("lists every page of cron monitors", async () => {
    const { c, calls } = client((call) => {
      const cursor = call.url.searchParams.get("cursor");
      return {
        body: [
          {
            id: cursor ? "2" : "1",
            slug: cursor ? "nightly" : "hourly",
            status: "active",
            config: cursor
              ? { schedule_type: "interval", schedule: [1, "day"] }
              : { schedule_type: "crontab", schedule: "0 * * * *", checkin_margin: 5 },
            environments: [{ name: "production", status: cursor ? "error" : "ok" }],
          },
        ],
        headers: {
          Link: cursor
            ? '<https://us.sentry.io/api/0/organizations/acme/monitors/?cursor=b>; rel="next"; results="false"; cursor="b"'
            : '<https://us.sentry.io/api/0/organizations/acme/monitors/?cursor=a>; rel="next"; results="true"; cursor="a"',
        },
      };
    });
    const list = await c.listResources("cron-monitor", ACCOUNT);
    expect(calls).toHaveLength(2);
    expect(list.map((r) => [r.externalId, r.fields["schedule"], r.fields["health"]])).toEqual([
      ["hourly", "0 * * * *", "ok"],
      ["nightly", "1 day", "error"],
    ]);
    expect(c.renderSidebarItem(list[1]!).status).toMatchObject({ status: "error" });
  });
});

describe("listing", () => {
  it("maps projects with their last 24 hours of accepted and dropped events", async () => {
    const { c } = client((call) => {
      if (call.url.pathname.endsWith("/stats_v2/")) {
        expect(call.url.searchParams.getAll("groupBy")).toEqual(["project", "outcome"]);
        return stats("2026-10-03", 1, [
          { by: { project: 11, outcome: "accepted" }, total: 900 },
          { by: { project: 11, outcome: "filtered" }, total: 40 },
          { by: { project: 11, outcome: "rate_limited" }, total: 2 },
        ]);
      }
      return [
        {
          id: "11",
          slug: "web",
          name: "Web",
          platform: "javascript",
          teams: [{ slug: "frontend" }],
        },
      ];
    });
    const [p] = await c.listResources("project", ACCOUNT);
    expect(p).toMatchObject({
      id: `${ACCOUNT}:project:web`,
      fields: { teams: "frontend", events24h: 900, dropped24h: 42, organization: "acme" },
      resolvedOutputs: { url: "https://acme.sentry.io/projects/web/" },
    });
  });

  it("lists issues as children of their project", async () => {
    const { c, calls } = client(() => [
      {
        id: "77",
        shortId: "WEB-1",
        title: "TypeError",
        level: "error",
        status: "unresolved",
        count: "12",
        project: { id: "11", slug: "web" },
        permalink: "https://acme.sentry.io/issues/77/",
      },
    ]);
    const [i] = await c.listResources("issue", ACCOUNT);
    expect(calls[0]!.url.searchParams.get("query")).toBe("is:unresolved");
    expect(calls[0]!.url.searchParams.get("sort")).toBe("freq");
    expect(i).toMatchObject({
      parentResourceId: `${ACCOUNT}:project:web`,
      fields: { count: 12, shortId: "WEB-1" },
    });
  });

  it("leaves cron and uptime detectors out of the generic monitor list", async () => {
    const { c } = client((call) =>
      call.url.pathname.endsWith("/projects/")
        ? [{ id: "1", slug: "web" }]
        : [
            {
              id: "5",
              name: "Slow spans",
              type: "metric_issue",
              projectId: "1",
              enabled: true,
              workflowIds: ["9"],
              dataSources: [
                {
                  queryObj: {
                    snubaQuery: { aggregate: "avg(span.duration)", query: "", timeWindow: 3600 },
                  },
                },
              ],
              conditionGroup: {
                conditions: [
                  { type: "gt", comparison: 1600, conditionResult: 75 },
                  { type: "lte", comparison: 1600, conditionResult: 0 },
                ],
              },
            },
            { id: "6", name: "uptime", type: "uptime_domain_failure" },
          ],
    );
    const list = await c.listResources("monitor", ACCOUNT);
    expect(list).toHaveLength(1);
    expect(list[0]!.fields).toMatchObject({
      monitorType: "Metric",
      timeWindow: 60,
      thresholds: "gt 1600",
      alertCount: 1,
      projectSlug: "web",
    });
  });
});

describe("project detail", () => {
  it("reads the unresolved count from X-Hits and renders resolve buttons", async () => {
    const { c } = client((call) => {
      if (call.url.pathname.endsWith("/stats_v2/")) return stats("2026-10-03", 1, []);
      if (call.url.pathname.endsWith("/issues/")) {
        return {
          body: [{ id: "77", shortId: "WEB-1", title: "TypeError", level: "error", count: "3" }],
          headers: { "X-Hits": "42" },
        };
      }
      return { id: "11", slug: "web", name: "Web" };
    });
    const r = await c.getResource("project", `${ACCOUNT}:project:web`, ACCOUNT);
    expect(r.fields["unresolvedIssues"]).toBe(42);
    expect(JSON.parse(r.resolvedOutputs[TOP_ISSUES_KEY]!)[0]).toMatchObject({ id: "77", count: 3 });
    const schema = JSON.stringify(c.renderDetail(r));
    expect(schema).toContain("resolve-issue:77");
  });
});

describe("actions", () => {
  it("resolves and archives issues through the bulk endpoint", async () => {
    const { c, calls } = client(() => ({ status: 204 }));
    await c.invokeAction("issue", `${ACCOUNT}:issue:77`, "archive", ACCOUNT);
    await c.invokeAction("project", `${ACCOUNT}:project:web`, "resolve-issue:78", ACCOUNT);
    expect(calls[0]).toMatchObject({
      method: "PUT",
      body: { status: "ignored", substatus: "archived_until_escalating" },
    });
    expect(calls[0]!.url.pathname).toBe("/api/0/organizations/acme/issues/");
    expect(calls[0]!.url.searchParams.getAll("id")).toEqual(["77"]);
    expect(calls[1]!.url.searchParams.getAll("id")).toEqual(["78"]);
    expect(calls[1]!.body).toEqual({ status: "resolved" });
  });

  it("pauses and mutes cron monitors, pauses uptime monitors, toggles alerts", async () => {
    const { c, calls } = client(() => ({ status: 204 }));
    await c.invokeAction("cron-monitor", `${ACCOUNT}:cron-monitor:hourly`, "pause", ACCOUNT);
    await c.invokeAction("cron-monitor", `${ACCOUNT}:cron-monitor:hourly`, "mute", ACCOUNT);
    await c.invokeAction("uptime-monitor", `${ACCOUNT}:uptime-monitor:web/9`, "pause", ACCOUNT);
    await c.invokeAction("alert", `${ACCOUNT}:alert:3`, "disable", ACCOUNT);
    await c.invokeAction("client-key", `${ACCOUNT}:client-key:web/abc`, "disable", ACCOUNT);
    expect(calls.map((x) => [x.url.pathname, x.body])).toEqual([
      ["/api/0/organizations/acme/monitors/hourly/", { status: "disabled" }],
      ["/api/0/organizations/acme/monitors/hourly/", { isMuted: true }],
      ["/api/0/projects/acme/web/uptime/9/", { status: "disabled" }],
      ["/api/0/organizations/acme/workflows/", { enabled: false }],
      ["/api/0/projects/acme/web/keys/abc/", { isActive: false }],
    ]);
    expect(calls[3]!.url.searchParams.getAll("id")).toEqual(["3"]);
  });
});

describe("updates", () => {
  it("renames an alert by sending the whole alert back", async () => {
    const current = {
      id: "3",
      name: "Old",
      enabled: true,
      config: { frequency: 30 },
      triggers: { logicType: "any-short", conditions: [] },
      actionFilters: [{ logicType: "all", conditions: [], actions: [{ type: "email" }] }],
      detectorIds: ["5"],
      owner: "team:1",
    };
    const { c, calls } = client((call) => (call.method === "PUT" ? current : current));
    await c.updateResource("alert", `${ACCOUNT}:alert:3`, ACCOUNT, {
      name: "New",
      frequency: "60",
    });
    const put = calls.find((x) => x.method === "PUT")!;
    expect(put.body).toMatchObject({
      name: "New",
      config: { frequency: 60 },
      detectorIds: ["5"],
      actionFilters: current.actionFilters,
    });
  });

  it("parses cron schedules and validates uptime edits", async () => {
    expect(parseSchedule("*/5 * * * *")).toEqual({
      schedule_type: "crontab",
      schedule: "*/5 * * * *",
    });
    expect(parseSchedule("10 minutes")).toEqual({
      schedule_type: "interval",
      schedule: [10, "minute"],
    });
    expect(() => parseSchedule("often")).toThrow(/crontab/);
    const { c } = client(() => ({}));
    await expect(
      c.updateResource("uptime-monitor", `${ACCOUNT}:uptime-monitor:web/9`, ACCOUNT, {
        intervalSeconds: "45",
      }),
    ).rejects.toThrow(/60, 300/);
  });

  it("creates a project for the picked team", async () => {
    const { c, calls } = client(() => ({ id: "12", slug: "api", name: "api" }));
    const r = await c.createResource("project", ACCOUNT, {
      name: "api",
      team: "backend",
      platform: "go",
    });
    expect(calls[0]!.url.pathname).toBe("/api/0/teams/acme/backend/projects/");
    expect(calls[0]!.body).toEqual({ name: "api", platform: "go" });
    expect(r.externalId).toBe("api");
  });
});

describe("costs", () => {
  it("explains that self-hosted Sentry has no bill", async () => {
    const { c } = client(() => [], {
      region: "self-hosted",
      baseUrl: "https://sentry.example.com",
    });
    await expect(
      c.fetchCostData(ACCOUNT, { fromDate: "2026-10-01", toDate: "2026-10-02" }),
    ).rejects.toThrow(/self-hosted/);
  });
});

describe("preflight", () => {
  it("names missing scopes on a 403 and identifies the token", async () => {
    const { c } = client((call) => {
      if (call.url.pathname === "/api/0/organizations/acme/") return { slug: "acme", name: "Acme" };
      if (call.url.pathname.endsWith("/workflows/")) return { status: 403, body: { detail: "no" } };
      return [];
    });
    const res = await c.verifyCredentials();
    expect(res.identity).toBe("Internal integration token for Acme");
    const alerts = res.checks.find((x) => x.capabilityId === "alerts")!;
    expect(alerts.status).toBe("missing");
    expect(res.checks.find((x) => x.capabilityId === "costs")!.status).toBe("ok");
    expect(plugin.policyTemplate!(["alerts"]).document).toBe("alerts:read\nalerts:write");
  });
});

describe("status feed", () => {
  it("maps regional components and ignores third parties", () => {
    expect(mapComponent("EU Cron Monitoring")).toEqual({
      services: ["Cron Monitoring"],
      regions: ["de"],
      resourceTypes: ["cron-monitor"],
    });
    expect(mapComponent("API")).toEqual({ services: ["API"], providerWide: true });
    expect(mapComponent("Slack")).toBeNull();
  });
});

describe("terraform", () => {
  it("maps projects, teams and keys with org-scoped import ids", () => {
    const base = {
      pluginId: "sentry",
      accountId: ACCOUNT,
      resolvedOutputs: {},
      secretStates: [],
      createdAt: "",
      updatedAt: "",
    };
    const project = sentryTerraformExport.mapResource({
      ...base,
      id: "x",
      resourceTypeId: "project",
      displayName: "Web",
      externalId: "web",
      fields: {
        name: "Web",
        slug: "web",
        teams: "frontend, core",
        platform: "javascript",
        organization: "acme",
      },
    });
    expect(project?.resource).toMatchObject({ type: "sentry_project", importId: "acme/web" });
    const key = sentryTerraformExport.mapResource({
      ...base,
      id: "y",
      resourceTypeId: "client-key",
      displayName: "Default",
      externalId: "web/abc",
      fields: { name: "Default", projectSlug: "web", keyId: "abc", organization: "acme" },
    });
    expect(key?.resource.importId).toBe("acme/web/abc");
  });
});

import { describe, expect, it } from "vitest";
import type { HostServices } from "@infrawrench/plugin-base";
import { CostSetupError } from "@infrawrench/plugin-base";
import { BetterStackApiError } from "../api.js";
import { BetterStackClient } from "../client.js";
import { chunks, fetchBetterStackCost } from "../cost.js";
import { describeSteps, mapMonitor, mapStatusPage } from "../mappers.js";
import { eventsSql, logLine, logsSql, sqlHost } from "../sql.js";
import { parseStatusFeed } from "../status-feed.js";
import { betterStackTerraformExport } from "../terraform.js";
import { makeHttp, memorySecrets } from "./helpers.js";

const ACCOUNT = "acc";

function client(
  route: Parameters<typeof makeHttp>[0],
  creds: Record<string, string> = { apiToken: "tok" },
) {
  const { http, calls } = makeHttp(route);
  const secrets = memorySecrets();
  const c = new BetterStackClient(creds, { http, secrets } as unknown as HostServices);
  return { c, calls, secrets, http };
}

describe("listing", () => {
  it("follows pagination on the chosen host and maps monitors", async () => {
    const { c, calls } = client((url) => {
      if (url.pathname === "/api/v2/monitors" && url.searchParams.get("page") !== "2") {
        return {
          body: {
            data: [
              {
                id: "1",
                attributes: {
                  pronounceable_name: "Site",
                  url: "https://a",
                  status: "up",
                  regions: ["us", "eu"],
                },
              },
            ],
            pagination: { next: "https://incidents.betterstack.com/api/v2/monitors?page=2" },
          },
        };
      }
      if (url.pathname === "/api/v2/monitors") {
        return {
          body: {
            data: [{ id: "2", attributes: { url: "https://b", status: "paused" } }],
            pagination: { next: null },
          },
        };
      }
      return { status: 404 };
    });
    const list = await c.listResources("monitor", ACCOUNT);
    expect(list.map((m) => [m.externalId, m.fields["paused"]])).toEqual([
      ["1", false],
      ["2", true],
    ]);
    expect(list[0]?.fields["regions"]).toBe("us, eu");
    expect(calls.every((x) => x.url.host === "uptime.betterstack.com")).toBe(true);
    expect(calls[0]?.headers["Authorization"]).toBe("Bearer tok");
  });

  it("uses the Telemetry token on the Telemetry host", async () => {
    const { c, calls } = client(() => ({ body: { data: [], pagination: { next: null } } }), {
      apiToken: "uptime-tok",
      telemetryToken: "tele-tok",
    });
    await c.listResources("source", ACCOUNT);
    expect(calls[0]?.url.host).toBe("telemetry.betterstack.com");
    expect(calls[0]?.headers["Authorization"]).toBe("Bearer tele-tok");
  });

  it("lists a product the token cannot reach as empty, and maps errors with status", async () => {
    const { c } = client(() => ({ status: 401, body: { errors: "Invalid Team API token." } }));
    expect(await c.listResources("dashboard", ACCOUNT)).toEqual([]);
    const err = await c.getResource("monitor", "acc:monitor:1", ACCOUNT).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BetterStackApiError);
    expect((err as BetterStackApiError).status).toBe(401);
    expect((err as Error).message).toContain("Invalid Team API token.");
  });

  it("lists status page children with composite ids", async () => {
    const { c } = client((url) => {
      if (url.pathname === "/api/v2/status-pages")
        return { body: { data: [{ id: "9", attributes: { company_name: "Acme" } }] } };
      if (url.pathname === "/api/v2/status-pages/9/sections")
        return { body: { data: [{ id: "5", attributes: { name: "API", position: 0 } }] } };
      return { status: 404 };
    });
    const [s] = await c.listResources("status-page-section", ACCOUNT);
    expect(s?.externalId).toBe("9/5");
    expect(s?.parentResourceId).toBe("acc:status-page:9");
  });
});

describe("actions", () => {
  it("pauses monitors and sources with the right attribute", async () => {
    const { c, calls } = client(() => ({ body: {} }));
    await c.invokeAction("monitor", "acc:monitor:1", "pause", ACCOUNT);
    await c.invokeAction("source", "acc:source:7", "resume", ACCOUNT);
    expect(calls.map((x) => [x.method, x.url.host, x.url.pathname, x.body])).toEqual([
      ["PATCH", "uptime.betterstack.com", "/api/v2/monitors/1", { paused: true }],
      ["PATCH", "telemetry.betterstack.com", "/api/v2/sources/7", { ingesting_paused: false }],
    ]);
  });

  it("acknowledges incidents through the v3 endpoint", async () => {
    const { c, calls } = client(() => ({ body: {} }));
    await c.invokeAction("incident", "acc:incident:25", "acknowledge", ACCOUNT);
    expect(calls[0]?.url.pathname).toBe("/api/v3/incidents/25/acknowledge");
  });

  it("connects SQL access and then tails logs through the SQL API", async () => {
    const source = {
      id: "7",
      attributes: { name: "app", team_id: 123, table_name: "app_x", data_region: "eu-nbg-2" },
    };
    const { http, calls } = makeHttp((url) => {
      if (url.pathname === "/api/v2/sources/7") return { body: source };
      if (url.pathname === "/api/v1/connections") {
        return { status: 201, body: { data: { attributes: { username: "u", password: "p" } } } };
      }
      return { status: 404 };
    });
    const secrets = memorySecrets();
    // Answer the ClickHouse request with NDJSON, which the JSON helper cannot.
    const wrapped = {
      async request(req: {
        url: string;
        method: string;
        headers: Record<string, string>;
        body?: string | Uint8Array;
      }) {
        if (req.url.includes("betterstackdata.com")) {
          calls.push({
            url: new URL(req.url),
            method: req.method,
            headers: req.headers,
            body: req.body,
          });
          return {
            status: 200,
            headers: {},
            body: '{"dt":"2026-10-01 00:00:01","raw":"{\\"message\\":\\"second\\"}"}\n{"dt":"2026-10-01 00:00:00","raw":"{\\"message\\":\\"first\\",\\"level\\":\\"info\\"}"}\n',
          };
        }
        return http.request(req);
      },
    };
    const c = new BetterStackClient({ apiToken: "tok" }, {
      http: wrapped,
      secrets,
    } as unknown as HostServices);
    const before = await c.getLogs("source", "acc:source:7", ACCOUNT, { tailLines: 10 });
    expect(before.text).toContain("Connect SQL access");
    await c.invokeAction("source", "acc:source:7", "connect-sql", ACCOUNT);
    expect(calls.find((x) => x.url.pathname === "/api/v1/connections")?.body).toMatchObject({
      client_type: "clickhouse",
      team_ids: [123],
    });
    const logs = await c.getLogs("source", "acc:source:7", ACCOUNT, { tailLines: 10 });
    expect(logs.text).toBe("2026-10-01 00:00:00  INFO  first\n2026-10-01 00:00:01  second\n");
    const sql = calls.find((x) => x.url.host === "eu-nbg-2-connect.betterstackdata.com");
    expect(sql?.headers["Authorization"]).toBe(`Basic ${btoa("u:p")}`);
    expect(String(sql?.body)).toContain("remote(t123_app_x_logs)");
    expect(String(sql?.body)).toContain("FORMAT JSONEachRow");
  });
});

describe("sql helpers", () => {
  it("builds hosts and queries", () => {
    expect(sqlHost("us-east-9")).toBe("https://us-east-9-connect.betterstackdata.com");
    expect(() => sqlHost(undefined)).toThrow(/no SQL endpoint/);
    expect(logsSql("t1_a", 5)).toContain("LIMIT 5");
    expect(eventsSql("t1_a", "2026-10-01T00:00:00.000Z", "2026-10-02T00:00:00Z", 600)).toContain(
      "dt >= toDateTime('2026-10-01 00:00:00')",
    );
    expect(logLine({ dt: "t", raw: "not json" })).toBe("t  not json");
  });
});

describe("cost", () => {
  it("turns daily product costs into rows and skips zeros", async () => {
    const { http } = makeHttp((url) => {
      if (url.pathname === "/api/v2/usage")
        return { body: { data: [{ id: "logs", attributes: { name: "Logs" } }] } };
      if (url.pathname === "/api/v2/usage/logs") {
        expect(url.searchParams.get("dimension")).toBe("cost");
        expect(url.searchParams.get("resolution")).toBe("day");
        return {
          body: {
            data: [
              {
                id: "142",
                attributes: {
                  name: "production-app",
                  values: [
                    { date: "2026-07-26", value: 1.5 },
                    { date: "2026-07-27", value: 0 },
                  ],
                },
              },
            ],
          },
        };
      }
      return { status: 404 };
    });
    const rows = await fetchBetterStackCost(
      { token: "t", http },
      { fromDate: "2026-07-26", toDate: "2026-07-27" },
    );
    expect(rows).toEqual([
      {
        date: "2026-07-26",
        service: "Logs",
        resourceId: "logs/142",
        tags: { item: "production-app" },
        currency: "USD",
        amount: 1.5,
      },
    ]);
  });

  it("asks for a global token on 401", async () => {
    const { http } = makeHttp(() => ({
      status: 401,
      body: { errors: "Please provide a valid Global API token." },
    }));
    await expect(
      fetchBetterStackCost({ token: "t", http }, { fromDate: "2026-07-01", toDate: "2026-07-02" }),
    ).rejects.toBeInstanceOf(CostSetupError);
  });

  it("splits long ranges into 400-day chunks", () => {
    expect(chunks({ fromDate: "2025-01-01", toDate: "2026-03-01" })).toEqual([
      { from: "2025-01-01", to: "2026-02-04" },
      { from: "2026-02-05", to: "2026-03-01" },
    ]);
  });
});

describe("mappers", () => {
  it("derives status page URLs and describes policy steps", () => {
    const p = mapStatusPage(ACCOUNT, { id: "1", attributes: { subdomain: "acme" } });
    expect(p.resolvedOutputs["url"]).toBe("https://acme.betteruptime.com");
    expect(
      mapStatusPage(ACCOUNT, { id: "1", attributes: { custom_domain: "status.acme.com" } }).fields[
        "url"
      ],
    ).toBe("https://status.acme.com");
    expect(describeSteps([{ wait_before: 300, step_members: [{ type: "current_on_call" }] }])).toBe(
      "1. after 5m: current_on_call",
    );
    expect(mapMonitor(ACCOUNT, { id: "1", attributes: { url: "https://a" } }).displayName).toBe(
      "https://a",
    );
  });
});

describe("status feed", () => {
  it("keeps unresolved reports and maps components to resource types", () => {
    const body = JSON.stringify({
      included: [
        { id: "r1", type: "status_page_resource", attributes: { public_name: "Telemetry" } },
        {
          id: "u1",
          type: "status_update",
          attributes: { message: "<p>Looking</p>", published_at: "2026-10-01T00:00:00Z" },
        },
        {
          id: "s1",
          type: "status_report",
          attributes: {
            title: "Delayed processing",
            report_type: "manual",
            starts_at: "2026-10-01T00:00:00Z",
            aggregate_state: "degraded",
            affected_resources: [{ status_page_resource_id: "r1", status: "degraded" }],
          },
          relationships: { status_updates: { data: [{ id: "u1" }] } },
        },
        {
          id: "s2",
          type: "status_report",
          attributes: { title: "Old", aggregate_state: "resolved" },
        },
      ],
    });
    const [i, ...rest] = parseStatusFeed(body);
    expect(rest).toEqual([]);
    expect(i?.resourceTypes).toContain("source");
    expect(i?.providerWide).toBe(false);
    expect(i?.lastUpdateText).toBe("Looking");
  });
});

describe("terraform", () => {
  it("maps monitors and sections with their import ids", () => {
    const base = {
      pluginId: "better-stack",
      accountId: ACCOUNT,
      resolvedOutputs: {},
      secretStates: [],
      createdAt: "",
      updatedAt: "",
    };
    const m = betterStackTerraformExport.mapResource({
      ...base,
      id: "acc:monitor:1",
      resourceTypeId: "monitor",
      displayName: "Site",
      externalId: "1",
      fields: {
        name: "Site",
        url: "https://a",
        monitorType: "status",
        checkFrequency: 180,
        regions: "us, eu",
      },
    });
    expect(m?.resource.type).toBe("betteruptime_monitor");
    const s = betterStackTerraformExport.mapResource({
      ...base,
      id: "acc:status-page-section:9/5",
      resourceTypeId: "status-page-section",
      displayName: "API",
      externalId: "9/5",
      fields: { name: "API", statusPageId: "9", position: 0 },
    });
    expect(s?.resource.importId).toBe("9/5");
  });
});

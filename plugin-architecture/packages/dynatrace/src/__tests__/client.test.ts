import { beforeEach, describe, expect, it } from "vitest";
import { exportResourcesToTerraform } from "@infrawrench/plugin-base";
import { resolveUrls, statusOf } from "../api.js";
import {
  applyAlertingEdits,
  DynatraceClient,
  maintenanceValue,
  toLocalDateTime,
} from "../client.js";
import { chunkRange, resetDpsTokenCacheForTests } from "../cost-data.js";
import { mapAlertingProfile, mapEntity } from "../mappers.js";
import { resolutionFor } from "../metrics.js";
import { verifyDynatraceCredentials } from "../preflight.js";
import { parseContainer, parseStatusFeed } from "../status-feed.js";
import { dynatraceTerraformExport } from "../terraform.js";
import { CREDS, makeHttp } from "./helpers.js";

beforeEach(() => resetDpsTokenCacheForTests());

describe("resolveUrls", () => {
  it("turns the apps address into the environment API and back", () => {
    expect(resolveUrls("https://abc12345.apps.dynatrace.com/ui/apps")).toEqual({
      envUrl: "https://abc12345.live.dynatrace.com",
      platformUrl: "https://abc12345.apps.dynatrace.com",
      environmentId: "abc12345",
    });
    expect(resolveUrls("abc12345.live.dynatrace.com/").envUrl).toBe(
      "https://abc12345.live.dynatrace.com",
    );
  });
  it("handles Managed and sprint hosts", () => {
    expect(resolveUrls("https://dt.example.com/e/1111-2222/#dashboard")).toEqual({
      envUrl: "https://dt.example.com/e/1111-2222",
      platformUrl: "",
      environmentId: "1111-2222",
    });
    expect(resolveUrls("https://xyz.sprint.apps.dynatracelabs.com").platformUrl).toBe(
      "https://xyz.sprint.apps.dynatracelabs.com",
    );
  });
});

describe("DynatraceClient", () => {
  it("sends Api-Token auth and follows nextPageKey with nothing else", async () => {
    const { http, calls } = makeHttp((url) => {
      if (url.pathname === "/api/v2/entities") {
        if (url.searchParams.get("nextPageKey") === "p2") {
          return { body: { entities: [{ entityId: "HOST-2", displayName: "two" }] } };
        }
        return {
          body: {
            entities: [
              {
                entityId: "HOST-1",
                displayName: "one",
                properties: {
                  osType: "LINUX",
                  cpuCores: 4,
                  physicalMemory: 8589934592,
                  ipAddress: ["10.0.0.1"],
                },
                tags: [{ key: "env", value: "prod", stringRepresentation: "env:prod" }],
                firstSeenTms: 1700000000000,
              },
            ],
            nextPageKey: "p2",
          },
        };
      }
      return undefined;
    });
    const client = new DynatraceClient(CREDS, { http });
    const hosts = await client.listResources("host", "acct");
    expect(hosts.map((h) => h.externalId)).toEqual(["HOST-1", "HOST-2"]);
    expect(hosts[0]?.fields["osType"]).toBe("LINUX");
    expect(hosts[0]?.fields["ipAddresses"]).toBe("10.0.0.1");
    expect(hosts[0]?.fields["tags"]).toBe("env:prod");
    expect(calls[0]?.url.origin).toBe("https://abc12345.live.dynatrace.com");
    expect(calls[0]?.headers["Authorization"]).toBe("Api-Token dt0c01.PUBLIC.SECRET");
    expect(calls[0]?.url.searchParams.get("entitySelector")).toBe('type("HOST")');
    expect([...(calls[1]?.url.searchParams.keys() ?? [])]).toEqual(["nextPageKey"]);
  });

  it("maps errors to a status and lists a 403'd type empty", async () => {
    const { http } = makeHttp((url) =>
      url.pathname === "/api/v2/slo"
        ? {
            status: 403,
            body: { error: { code: 403, message: "Token is missing required scope" } },
          }
        : { status: 500, body: { error: { code: 500, message: "boom" } } },
    );
    const client = new DynatraceClient(CREDS, { http });
    expect(await client.listResources("slo", "acct")).toEqual([]);
    const err = await client.listResources("problem", "acct").catch((e: unknown) => e);
    expect(statusOf(err)).toBe(500);
    expect(String(err)).toContain("boom");
  });

  it("creates an alerting profile through Settings 2.0", async () => {
    const { http, calls } = makeHttp((url, method) => {
      if (url.pathname === "/api/v2/settings/objects" && method === "POST") {
        return { body: [{ code: 200, objectId: "obj-1" }] };
      }
      if (url.pathname === "/api/v2/settings/objects/obj-1") {
        return {
          body: {
            objectId: "obj-1",
            value: {
              name: "On-call",
              severityRules: [{ severityLevel: "AVAILABILITY", delayInMinutes: 0 }],
            },
          },
        };
      }
      return undefined;
    });
    const client = new DynatraceClient(CREDS, { http });
    const created = await client.createResource("alerting-profile", "acct", {
      name: "On-call",
      delayAvailability: "0",
      delayErrors: "",
      tagFilter: "env:prod",
    });
    expect(created.fields["delayAvailability"]).toBe(0);
    const post = calls.find((c) => c.method === "POST");
    expect(post?.body).toEqual([
      {
        schemaId: "builtin:alerting.profile",
        scope: "environment",
        value: {
          name: "On-call",
          managementZone: null,
          severityRules: [
            {
              severityLevel: "AVAILABILITY",
              delayInMinutes: 0,
              tagFilterIncludeMode: "INCLUDE_ANY",
              tagFilter: ["env:prod"],
            },
          ],
          eventFilters: [],
        },
      },
    ]);
  });

  it("toggles a synthetic monitor by writing the whole monitor back", async () => {
    const monitor = {
      entityId: "SYNTHETIC_TEST-1",
      name: "Home",
      type: "HTTP",
      enabled: true,
      frequencyMin: 5,
      locations: [],
    };
    const { http, calls } = makeHttp((url, method) =>
      url.pathname === "/api/v1/synthetic/monitors/SYNTHETIC_TEST-1"
        ? method === "PUT"
          ? { status: 204 }
          : { body: monitor }
        : undefined,
    );
    const client = new DynatraceClient(CREDS, { http });
    await client.invokeAction(
      "synthetic-monitor",
      "acct:synthetic-monitor:SYNTHETIC_TEST-1",
      "disable",
      "acct",
    );
    const put = calls.find((c) => c.method === "PUT");
    expect(put?.body).toEqual({
      name: "Home",
      type: "HTTP",
      enabled: false,
      frequencyMin: 5,
      locations: [],
    });
  });

  it("comments on and closes problems from the prompt form", async () => {
    const { http, calls } = makeHttp((_url, method) =>
      method === "POST" ? { body: {} } : undefined,
    );
    const client = new DynatraceClient(CREDS, { http });
    await client.executeNoSqlCommand("problem", "acct:problem:-123_456V2", "acct", "close", [
      JSON.stringify({ message: "fixed" }),
    ]);
    expect(calls[0]?.url.pathname).toBe("/api/v2/problems/-123_456V2/close");
    expect(calls[0]?.body).toEqual({ message: "fixed" });
  });

  it("runs DQL and polls until it succeeds", async () => {
    let polls = 0;
    const { http, calls } = makeHttp((url) => {
      if (url.pathname.endsWith("query:execute"))
        return { body: { state: "RUNNING", requestToken: "tok" } };
      if (url.pathname.endsWith("query:poll")) {
        polls++;
        return polls < 2
          ? { body: { state: "RUNNING", requestToken: "tok" } }
          : { body: { state: "SUCCEEDED", result: { records: [{ a: 1, b: { c: 2 } }, null] } } };
      }
      return undefined;
    });
    const client = new DynatraceClient({ ...CREDS, platformToken: "dt0s16.X.Y" }, { http });
    const res = await client.executeQuery("r", "acct", "fetch logs");
    expect(res.rows).toEqual([{ a: 1, b: '{"c":2}' }]);
    expect(calls[0]?.url.origin).toBe("https://abc12345.apps.dynatrace.com");
    expect(calls[0]?.headers["Authorization"]).toBe("Bearer dt0s16.X.Y");
    expect(calls[1]?.url.searchParams.get("request-token")).toBe("tok");
  });

  it("refuses DQL without a platform token", async () => {
    const client = new DynatraceClient(CREDS);
    await expect(client.executeQuery("r", "acct", "fetch logs")).rejects.toThrow(/platform token/);
  });

  it("reads platform subscription cost for this environment only", async () => {
    const { http, calls } = makeHttp((url) => {
      if (url.hostname === "sso.dynatrace.com")
        return { body: { access_token: "at", expires_in: 300 } };
      if (url.pathname.endsWith("/subscriptions")) {
        return {
          body: {
            data: [{ uuid: "sub-1", name: "DPS", startTime: "2026-01-01", endTime: "2027-01-01" }],
          },
        };
      }
      if (url.pathname.endsWith("/environments/cost")) {
        return {
          body: {
            data: [
              {
                environmentId: "abc12345",
                cost: [
                  {
                    startTime: "2026-10-01T00:00:00Z",
                    value: 12.5,
                    currencyCode: "EUR",
                    capabilityName: "Host Monitoring",
                  },
                  {
                    startTime: "2026-10-01T00:00:00Z",
                    value: 2.5,
                    currencyCode: "EUR",
                    capabilityName: "Host Monitoring",
                  },
                ],
              },
              {
                environmentId: "other",
                cost: [{ startTime: "2026-10-01T00:00:00Z", value: 99, capabilityName: "x" }],
              },
            ],
          },
        };
      }
      return undefined;
    });
    const client = new DynatraceClient(
      {
        ...CREDS,
        accountUuid: "acc-1",
        oauthClientId: "dt0s02.ID",
        oauthClientSecret: "dt0s02.ID.S",
      },
      { http },
    );
    const rows = await client.fetchCostData("acct", {
      fromDate: "2026-10-01",
      toDate: "2026-10-02",
    });
    expect(rows).toEqual([
      {
        date: "2026-10-01",
        service: "Host Monitoring",
        currency: "EUR",
        amount: 15,
        tags: { subscription: "DPS" },
      },
    ]);
    const token = calls.find((c) => c.url.hostname === "sso.dynatrace.com");
    expect(token?.rawBody).toContain("resource=urn%3Adtaccount%3Aacc-1");
    const cost = calls.find((c) => c.url.pathname.endsWith("/environments/cost"));
    expect(cost?.url.searchParams.get("environmentIds")).toBe("abc12345");
    expect(cost?.headers["Authorization"]).toBe("Bearer at");
  });

  it("explains missing cost credentials", async () => {
    const client = new DynatraceClient(CREDS);
    await expect(
      client.fetchCostData("acct", { fromDate: "2026-10-01", toDate: "2026-10-02" }),
    ).rejects.toThrow(/OAuth client/);
  });
});

describe("preflight", () => {
  it("compares the token's own scopes", async () => {
    const { http } = makeHttp((url) =>
      url.pathname === "/api/v2/apiTokens/lookup"
        ? { body: { name: "iw", owner: "me@x", scopes: ["entities.read", "metrics.read"] } }
        : undefined,
    );
    const ctx = new DynatraceClient(CREDS, { http }).context;
    const res = await verifyDynatraceCredentials(ctx);
    expect(res.identity).toBe("iw · me@x");
    expect(res.checks.find((c) => c.capabilityId === "entities")?.status).toBe("ok");
    const slo = res.checks.find((c) => c.capabilityId === "slo");
    expect(slo?.status).toBe("missing");
  });
});

describe("mappers and helpers", () => {
  it("maps service relationships for dependsOn", () => {
    const r = mapEntity("a", "service", {
      entityId: "SERVICE-1",
      displayName: "checkout",
      properties: { serviceType: "WEB_REQUEST_SERVICE" },
      fromRelationships: {
        runsOn: [
          { id: "PROCESS_GROUP-1", type: "PROCESS_GROUP" },
          { id: "PROCESS_GROUP-2", type: "PROCESS_GROUP" },
        ],
      },
    });
    expect(r.fields["runsOn"]).toBe("PROCESS_GROUP-1, PROCESS_GROUP-2");
  });

  it("edits alerting profile delays without touching other rules", () => {
    const v = applyAlertingEdits(
      {
        name: "p",
        severityRules: [
          {
            severityLevel: "AVAILABILITY",
            delayInMinutes: 0,
            tagFilterIncludeMode: "INCLUDE_ALL",
            tagFilter: ["a"],
          },
          { severityLevel: "ERRORS", delayInMinutes: 5 },
        ],
      },
      { delayAvailability: "10", delayErrors: "", delayCustom: "3" },
    );
    expect(v.severityRules).toEqual([
      {
        severityLevel: "AVAILABILITY",
        delayInMinutes: 10,
        tagFilterIncludeMode: "INCLUDE_ALL",
        tagFilter: ["a"],
      },
      {
        severityLevel: "CUSTOM_ALERT",
        delayInMinutes: 3,
        tagFilterIncludeMode: "NONE",
        tagFilter: [],
      },
    ]);
  });

  it("builds maintenance window values", () => {
    expect(toLocalDateTime("2026-10-06T09:30:00Z")).toBe("2026-10-06T09:30:00");
    const weekly = maintenanceValue({
      name: "w",
      scheduleType: "WEEKLY",
      dayOfWeek: "MONDAY",
      startTime: "9:00",
      endTime: "10:30",
      scheduleStartDate: "2026-10-01",
      scheduleEndDate: "2026-12-31",
      timeZone: "Europe/Vienna",
      entityTags: "env:prod",
    });
    expect(weekly.schedule).toEqual({
      scheduleType: "WEEKLY",
      weeklyRecurrence: {
        dayOfWeek: "MONDAY",
        recurrenceRange: { scheduleStartDate: "2026-10-01", scheduleEndDate: "2026-12-31" },
        timeWindow: { startTime: "09:00:00", endTime: "10:30:00", timeZone: "Europe/Vienna" },
      },
    });
    expect(weekly.filters).toEqual([{ entityTags: ["env:prod"] }]);
  });

  it("chunks cost ranges and picks metric resolutions", () => {
    expect(chunkRange("2026-01-01", "2026-02-15", 31)).toEqual([
      ["2026-01-01", "2026-01-31"],
      ["2026-02-01", "2026-02-15"],
    ]);
    expect(resolutionFor(24 * 3600_000)).toBe("12m");
    expect(resolutionFor(30 * 24 * 3600_000)).toBe("6h");
  });
});

describe("status feed", () => {
  it("parses containers and synthesises degraded ones", () => {
    expect(parseContainer("Process-AWS-americas")).toEqual({
      service: "Process",
      region: "aws-americas",
    });
    expect(parseContainer("Dynatrace Website")).toBeNull();
    const incidents = parseStatusFeed(
      JSON.stringify({
        result: {
          status: [
            {
              name: "Dynatrace Product",
              containers: [
                {
                  id: "c1",
                  name: "Analyze-GCP-emea",
                  status: "Degraded Performance",
                  status_code: 300,
                },
                { id: "c2", name: "Process-AWS-emea", status_code: 100 },
              ],
            },
          ],
          incidents: [],
        },
      }),
    );
    expect(incidents).toHaveLength(1);
    expect(incidents[0]).toMatchObject({
      regions: ["gcp-emea"],
      services: ["Analyze"],
      impact: "minor",
    });
    expect(() => parseStatusFeed("{}")).toThrow();
  });
});

describe("terraform", () => {
  it("exports alerting profiles with a dynamic rule block", () => {
    const r = mapAlertingProfile("a", {
      objectId: "vu9U3hXa",
      value: {
        name: "Ops",
        severityRules: [
          {
            severityLevel: "AVAILABILITY",
            delayInMinutes: 0,
            tagFilterIncludeMode: "NONE",
            tagFilter: [],
          },
          {
            severityLevel: "ERRORS",
            delayInMinutes: 5,
            tagFilterIncludeMode: "NONE",
            tagFilter: [],
          },
        ],
      },
    });
    const out = exportResourcesToTerraform([r], () => dynatraceTerraformExport);
    const hcl = JSON.stringify(out);
    expect(hcl).toContain("dynatrace_alerting");
    expect(hcl).toContain('dynamic \\"rule\\"');
    expect(hcl).toContain("vu9U3hXa");
  });
});

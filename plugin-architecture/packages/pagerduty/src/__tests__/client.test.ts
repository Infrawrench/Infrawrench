import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HttpHostServices } from "@infrawrench/plugin-base";
import { bytesToHex, hmacSha256 } from "@infrawrench/plugin-base";
import { PagerDutyClient } from "../client.js";
import { buildEventBody, verifyWebhook } from "../paging.js";
import { toPagingIncident } from "../mappers.js";
import { plugin } from "../plugin.js";
import { pagerdutyTerraformExport } from "../terraform.js";
import { mapService } from "../mappers.js";

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: unknown;
}

function fakeHttp(handler: (call: Call) => { status: number; body?: unknown }): {
  http: HttpHostServices;
  calls: Call[];
} {
  const calls: Call[] = [];
  const http: HttpHostServices = {
    async request(req) {
      const call: Call = {
        url: req.url,
        method: req.method,
        headers: req.headers,
        ...(typeof req.body === "string" ? { body: JSON.parse(req.body) } : {}),
      };
      calls.push(call);
      const res = handler(call);
      return {
        status: res.status,
        headers: {},
        body: res.body === undefined ? "" : JSON.stringify(res.body),
      };
    },
  };
  return { http, calls };
}

function client(handler: Parameters<typeof fakeHttp>[0], creds: Record<string, string> = {}) {
  const { http, calls } = fakeHttp(handler);
  return { c: new PagerDutyClient({ apiKey: "k1", ...creds }, { http }), calls };
}

describe("transport", () => {
  it("sends the token, the v2 Accept header and walks offset pages", async () => {
    const { c, calls } = client((call) => {
      const offset = Number(new URL(call.url).searchParams.get("offset"));
      return {
        status: 200,
        body: {
          teams: offset === 0 ? [{ id: "T1", name: "A" }] : [{ id: "T2", name: "B" }],
          more: offset === 0,
        },
      };
    });
    const teams = await c.listResources("pagerduty-team", "acc");
    expect(teams.map((t) => t.externalId)).toEqual(["T1", "T2"]);
    expect(calls[0]!.headers["Authorization"]).toBe("Token token=k1");
    expect(calls[0]!.headers["Accept"]).toBe("application/vnd.pagerduty+json;version=2");
    expect(calls[0]!.url).toContain("https://api.pagerduty.com/teams?");
    expect(calls).toHaveLength(2);
  });

  it("uses the EU hosts for an EU account", async () => {
    const { c, calls } = client(() => ({ status: 200, body: { teams: [], more: false } }), {
      region: "eu",
    });
    await c.listResources("pagerduty-team", "acc");
    expect(calls[0]!.url).toMatch(/^https:\/\/api\.eu\.pagerduty\.com\//);
  });

  it("attaches the HTTP status and PagerDuty's message to errors", async () => {
    const { c } = client(() => ({
      status: 403,
      body: { error: { message: "Access Denied", code: 2010, errors: ["read-only key"] } },
    }));
    await expect(c.listResources("pagerduty-team", "acc")).rejects.toMatchObject({
      status: 403,
      message: expect.stringContaining("Access Denied: read-only key"),
    });
  });

  it("encodes array parameters PagerDuty-style", async () => {
    const { c, calls } = client(() => ({ status: 200, body: { incidents: [], more: false } }));
    await c.listResources("pagerduty-incident", "acc");
    const url = new URL(calls[0]!.url);
    expect(url.searchParams.getAll("statuses[]")).toEqual(["triggered", "acknowledged"]);
  });
});

describe("paging: sending events", () => {
  it("reuses an existing Events API v2 integration's key", async () => {
    const { c, calls } = client((call) => {
      if (call.url.includes("/services/S1?")) {
        return {
          status: 200,
          body: {
            service: {
              id: "S1",
              integrations: [
                { id: "I1", type: "events_api_v2_inbound_integration", integration_key: "rk-1" },
              ],
            },
          },
        };
      }
      if (call.url.includes("events.pagerduty.com")) {
        return { status: 202, body: { status: "success", dedup_key: "iw:o:probe:p" } };
      }
      return { status: 404 };
    });
    const res = await c.sendPagingEvent("S1", {
      action: "trigger",
      dedupKey: "iw:o:probe:p",
      summary: "Probe down",
      severity: "critical",
      source: "infrawrench/probeAlerts",
      url: "https://app/x",
    });
    expect(res.dedupKey).toBe("iw:o:probe:p");
    const event = calls.find((x) => x.url.includes("events."))!;
    expect(event.body).toMatchObject({
      routing_key: "rk-1",
      event_action: "trigger",
      dedup_key: "iw:o:probe:p",
      payload: { summary: "Probe down", severity: "critical" },
      links: [{ href: "https://app/x", text: "Open in Infrawrench" }],
    });
    expect(event.headers["Authorization"]).toBeUndefined();
    // The key is cached: a second event does not look the service up again.
    await c.sendPagingEvent("S1", {
      action: "resolve",
      dedupKey: "iw:o:probe:p",
      summary: "x",
      severity: "info",
      source: "s",
    });
    expect(calls.filter((x) => x.url.includes("/services/S1?"))).toHaveLength(1);
    expect(calls.at(-1)!.body).toEqual({
      routing_key: "rk-1",
      event_action: "resolve",
      dedup_key: "iw:o:probe:p",
    });
  });

  it("creates an Infrawrench integration when the service has none", async () => {
    const { c, calls } = client((call) => {
      if (call.method === "GET")
        return { status: 200, body: { service: { id: "S1", integrations: [] } } };
      if (call.url.endsWith("/services/S1/integrations")) {
        return { status: 201, body: { integration: { id: "I9", integration_key: "rk-new" } } };
      }
      return { status: 202, body: { dedup_key: "d" } };
    });
    await c.sendPagingEvent("S1", {
      action: "trigger",
      dedupKey: "d",
      summary: "s",
      severity: "warning",
      source: "x",
    });
    const create = calls.find((x) => x.url.endsWith("/services/S1/integrations"))!;
    expect(create.body).toMatchObject({
      integration: { type: "events_api_v2_inbound_integration", name: "Infrawrench" },
    });
    expect(calls.at(-1)!.body).toMatchObject({ routing_key: "rk-new" });
  });

  it("routes orchestration targets through the orchestration's routing key", async () => {
    const { c, calls } = client((call) => {
      if (call.url.includes("/event_orchestrations/E1/integrations")) {
        return { status: 200, body: { integrations: [{ parameters: { routing_key: "R0" } }] } };
      }
      return { status: 202, body: {} };
    });
    await c.sendPagingEvent("orchestration:E1", {
      action: "trigger",
      dedupKey: "d",
      summary: "s",
      severity: "info",
      source: "x",
    });
    expect(calls.at(-1)!.body).toMatchObject({ routing_key: "R0" });
  });

  it("truncates long summaries and keeps the dedup key within 255", () => {
    const body = buildEventBody("rk", {
      action: "trigger",
      dedupKey: "k".repeat(300),
      summary: "s".repeat(2000),
      severity: "critical",
      source: "x",
    });
    expect(body.dedup_key).toHaveLength(255);
    expect(body.payload!.summary).toHaveLength(1024);
  });
});

describe("paging: on-call", () => {
  it("reads a schedule's users at the instant", async () => {
    const { c, calls } = client(() => ({
      status: 200,
      body: { users: [{ id: "U1", name: "Ada", email: "ada@x.io" }] },
    }));
    const people = await c.resolvePagingOnCall("schedule:SCH1", new Date("2026-10-06T10:00:00Z"));
    expect(people).toEqual([{ userId: "U1", name: "Ada", email: "ada@x.io", level: 1 }]);
    expect(calls[0]!.url).toContain("/schedules/SCH1/users?since=2026-10-06T10%3A00%3A00.000Z");
  });

  it("orders an escalation policy's people by level and dedupes them", async () => {
    const { c } = client(() => ({
      status: 200,
      body: {
        oncalls: [
          { escalation_level: 2, user: { id: "U2", name: "Bo", email: "bo@x.io" } },
          { escalation_level: 1, user: { id: "U1", name: "Ada", email: "ada@x.io" }, end: "E" },
          { escalation_level: 2, user: { id: "U1", name: "Ada", email: "ada@x.io" } },
        ],
        more: false,
      },
    }));
    const people = await c.resolvePagingOnCall("policy:P1", new Date());
    expect(people.map((p) => [p.userId, p.level])).toEqual([
      ["U1", 1],
      ["U2", 2],
    ]);
  });
});

describe("paging: incidents", () => {
  it("acts as the member first and falls back to the default user", async () => {
    const { c, calls } = client(
      (call) => {
        if (call.method === "PUT" && call.headers["From"] === "member@x.io") {
          return { status: 400, body: { error: { message: "Requester User Not Found" } } };
        }
        if (call.method === "PUT") return { status: 200, body: { incident: { id: "Q1" } } };
        return {
          status: 200,
          body: { incident: { id: "Q1", status: "acknowledged", incident_number: 7 } },
        };
      },
      { fromEmail: "bot@x.io" },
    );
    const updated = await c.updatePagingIncident("Q1", {
      action: "acknowledge",
      actorEmail: "member@x.io",
    });
    const puts = calls.filter((x) => x.method === "PUT");
    expect(puts.map((p) => p.headers["From"])).toEqual(["member@x.io", "bot@x.io"]);
    expect(puts[1]!.body).toEqual({
      incident: { type: "incident_reference", status: "acknowledged" },
    });
    expect(updated).toMatchObject({ id: "Q1", status: "acknowledged", reference: "#7" });
  });

  it("refuses a write with no user to act as", async () => {
    const { c } = client(() => ({ status: 200, body: {} }));
    await expect(c.updatePagingIncident("Q1", { action: "resolve" })).rejects.toMatchObject({
      status: 400,
    });
  });

  it("maps assignees, the acknowledger and the dedup key", () => {
    const incident = toPagingIncident({
      id: "Q1",
      incident_number: 12,
      title: "DB down",
      status: "acknowledged",
      urgency: "high",
      incident_key: "iw:o:probe:p",
      service: { id: "S1", summary: "db" },
      assignments: [{ assignee: { name: "Ada", email: "ada@x.io" } }],
      acknowledgements: [{ acknowledger: { name: "Bo", email: "bo@x.io" } }],
      created_at: "2026-10-06T00:00:00Z",
    });
    expect(incident).toMatchObject({
      reference: "#12",
      dedupKey: "iw:o:probe:p",
      serviceName: "db",
      assignees: [
        { name: "Bo", email: "bo@x.io" },
        { name: "Ada", email: "ada@x.io" },
      ],
    });
  });

  it("lists every open incident plus the window's resolved ones, once each", async () => {
    const { c, calls } = client((call) => {
      const statuses = new URL(call.url).searchParams.getAll("statuses[]");
      return {
        status: 200,
        body: {
          incidents: statuses.includes("resolved")
            ? [{ id: "R1", status: "resolved" }]
            : [{ id: "O1", status: "triggered" }],
          more: false,
        },
      };
    });
    const list = await c.listPagingIncidents({ since: new Date("2026-10-05T00:00:00Z") });
    expect(list.map((i) => i.id).sort()).toEqual(["O1", "R1"]);
    expect(calls.some((x) => new URL(x.url).searchParams.get("date_range") === "all")).toBe(true);
  });
});

describe("paging: webhooks", () => {
  const body = JSON.stringify({
    event: {
      event_type: "incident.acknowledged",
      resource_type: "incident",
      data: { id: "Q1", type: "incident", incident_key: "iw:o:probe:p" },
    },
  });

  it("accepts a valid v1 signature among several and reads the change", async () => {
    const sig = bytesToHex(await hmacSha256("s3cret", body));
    const result = await plugin.verifyPagingWebhook!({
      headers: { "x-pagerduty-signature": `v1=deadbeef, v1=${sig}` },
      body,
      secret: "s3cret",
      now: new Date(),
    });
    expect(result).toMatchObject({
      valid: true,
      incidentIds: ["Q1"],
      acknowledgedDedupKeys: ["iw:o:probe:p"],
      resolvedDedupKeys: [],
    });
  });

  it("rejects a wrong signature, a missing header and a tampered body", async () => {
    const sig = bytesToHex(await hmacSha256("s3cret", body));
    for (const [headers, b] of [
      [{ "x-pagerduty-signature": "v1=00" }, body],
      [{}, body],
      [{ "x-pagerduty-signature": `v1=${sig}` }, `${body} `],
    ] as const) {
      const result = await verifyWebhook({ headers, body: b, secret: "s3cret", now: new Date() });
      expect(result.valid).toBe(false);
    }
  });

  it("subscribes an account-wide webhook and returns its one-time secret", async () => {
    const { c, calls } = client(() => ({
      status: 200,
      body: { webhook_subscription: { id: "W1", delivery_method: { secret: "shh" } } },
    }));
    expect(await c.registerPagingWebhook("https://app/api/paging-webhooks/t")).toEqual({
      webhookId: "W1",
      secret: "shh",
    });
    expect(calls[0]!.body).toMatchObject({
      webhook_subscription: {
        delivery_method: { type: "http_delivery_method", url: "https://app/api/paging-webhooks/t" },
        filter: { type: "account_reference" },
      },
    });
  });
});

describe("terraform export", () => {
  it("maps a service with its timeouts in seconds", () => {
    const r = mapService("acc", {
      id: "S1",
      name: "api",
      escalation_policy: { id: "P1" },
      auto_resolve_timeout: 14400,
      acknowledgement_timeout: null,
    });
    const out = pagerdutyTerraformExport.mapResource(r);
    expect(out?.resource).toMatchObject({
      type: "pagerduty_service",
      importId: "S1",
      attributes: {
        escalation_policy: { kind: "string", value: "P1" },
        auto_resolve_timeout: { kind: "number", value: 14400 },
      },
    });
    expect(out?.resource.attributes["acknowledgement_timeout"]).toBeUndefined();
  });
});

beforeEach(() => {
  vi.restoreAllMocks();
});

import { describe, expect, it } from "vitest";
import type { HttpHostServices } from "@infrawrench/plugin-base";
import { bytesToBase64, hmacSha256 } from "@infrawrench/plugin-base";
import { IncidentIoClient } from "../client.js";
import { queryString } from "../api.js";
import { pagingStatusOf, toPagingIncident } from "../mappers.js";
import { buildAlertEvent, verifyWebhook } from "../paging.js";
import { parseStatusFeed } from "../status-feed.js";

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: unknown;
}

function client(handler: (call: Call) => { status: number; body?: unknown }) {
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
  return { c: new IncidentIoClient({ apiKey: "key-1" }, { http }), calls };
}

describe("transport", () => {
  it("encodes deep-object filters the way incident.io documents them", () => {
    expect(
      decodeURIComponent(
        queryString({ status_category: { one_of: ["triage", "live"] }, page_size: 5 }),
      ),
    ).toBe("?status_category[one_of]=triage&status_category[one_of]=live&page_size=5");
  });

  it("sends the bearer key and follows the after cursor", async () => {
    const { c, calls } = client((call) => {
      const after = new URL(call.url).searchParams.get("after");
      return {
        status: 200,
        body: after
          ? { users: [{ id: "U2", name: "Bo" }], pagination_meta: {} }
          : { users: [{ id: "U1", name: "Ada" }], pagination_meta: { after: "U1" } },
      };
    });
    const users = await c.listResources("incident-io-user", "acc");
    expect(users.map((u) => u.externalId)).toEqual(["U1", "U2"]);
    expect(calls[0]!.headers["Authorization"]).toBe("Bearer key-1");
    expect(new URL(calls[1]!.url).searchParams.get("after")).toBe("U1");
  });

  it("attaches the status and incident.io's error messages", async () => {
    const { c } = client(() => ({
      status: 403,
      body: {
        type: "forbidden",
        status: 403,
        errors: [{ code: "missing_scope", message: "Needs Manage on-call" }],
      },
    }));
    await expect(c.listResources("incident-io-schedule", "acc")).rejects.toMatchObject({
      status: 403,
      code: "missing_scope",
      message: expect.stringContaining("Needs Manage on-call"),
    });
  });
});

describe("paging: alert events", () => {
  it("offers only HTTP sources with a token as targets", async () => {
    const { c } = client(() => ({
      status: 200,
      body: {
        alert_sources: [
          { id: "A1", name: "Infrawrench", source_type: "http", secret_token: "t" },
          { id: "A2", name: "Datadog", source_type: "datadog", secret_token: "t" },
          { id: "A3", name: "No token", source_type: "http" },
        ],
      },
    }));
    expect((await c.listPagingTargets()).map((t) => t.id)).toEqual(["A1"]);
  });

  it("fires and resolves with the source's own token and the dedup key", async () => {
    const { c, calls } = client((call) => {
      if (call.url.endsWith("/v2/alert_sources/A1")) {
        return {
          status: 200,
          body: { alert_source: { id: "A1", source_type: "http", secret_token: "src-tok" } },
        };
      }
      return { status: 202, body: { deduplication_key: "iw:o:probe:p", status: "success" } };
    });
    await c.sendPagingEvent("A1", {
      action: "trigger",
      dedupKey: "iw:o:probe:p",
      summary: "Probe down",
      body: "api failed",
      severity: "critical",
      source: "infrawrench/probeAlerts",
      url: "https://app/x",
    });
    await c.sendPagingEvent("A1", {
      action: "resolve",
      dedupKey: "iw:o:probe:p",
      summary: "Probe down",
      severity: "info",
      source: "infrawrench/probeAlerts",
    });
    const events = calls.filter((x) => x.url.includes("/v2/alert_events/http/A1"));
    expect(events).toHaveLength(2);
    expect(events[0]!.headers["Authorization"]).toBe("Bearer src-tok");
    expect(events[0]!.body).toMatchObject({
      title: "Probe down",
      status: "firing",
      deduplication_key: "iw:o:probe:p",
      description: "api failed",
      source_url: "https://app/x",
    });
    expect(events[1]!.body).toMatchObject({ status: "resolved" });
    // The source is read once per client.
    expect(calls.filter((x) => x.url.endsWith("/v2/alert_sources/A1"))).toHaveLength(1);
  });

  it("never sends for an acknowledge", async () => {
    const { c, calls } = client(() => ({ status: 500 }));
    await c.sendPagingEvent("A1", {
      action: "acknowledge",
      dedupKey: "k",
      summary: "s",
      severity: "info",
      source: "x",
    });
    expect(calls).toHaveLength(0);
  });

  it("caps long titles", () => {
    const body = buildAlertEvent({
      action: "trigger",
      dedupKey: "k",
      summary: "s".repeat(900),
      severity: "info",
      source: "x",
    });
    expect((body["title"] as string).length).toBe(500);
  });
});

describe("paging: on-call", () => {
  it("reads a schedule's final entries at the instant", async () => {
    const at = new Date("2026-10-06T10:00:00Z");
    const { c, calls } = client(() => ({
      status: 200,
      body: {
        schedule_entries: {
          final: [
            {
              start_at: "2026-10-06T09:00:00Z",
              end_at: "2026-10-06T17:00:00Z",
              user: { id: "U1", name: "Ada", email: "ada@x.io" },
            },
            {
              start_at: "2026-10-06T17:00:00Z",
              end_at: "2026-10-07T09:00:00Z",
              user: { id: "U2", name: "Bo", email: "bo@x.io" },
            },
          ],
        },
      },
    }));
    const people = await c.resolvePagingOnCall("schedule:S1", at);
    expect(people).toEqual([
      { userId: "U1", name: "Ada", email: "ada@x.io", until: "2026-10-06T17:00:00Z", level: 1 },
    ]);
    expect(new URL(calls[0]!.url).searchParams.get("schedule_id")).toBe("S1");
  });

  it("reads an escalation path's current responders", async () => {
    const { c } = client(() => ({
      status: 200,
      body: {
        escalation_path: {
          id: "P1",
          current_responders: [{ id: "U9", name: "Cy", email: "cy@x.io" }],
        },
      },
    }));
    expect(await c.resolvePagingOnCall("path:P1", new Date())).toEqual([
      { userId: "U9", name: "Cy", email: "cy@x.io", level: 1 },
    ]);
  });
});

describe("paging: incidents", () => {
  it("maps status categories to the three paging states", () => {
    expect(pagingStatusOf("triage")).toBe("triggered");
    expect(pagingStatusOf("live")).toBe("acknowledged");
    expect(pagingStatusOf("paused")).toBe("acknowledged");
    expect(pagingStatusOf("learning")).toBe("resolved");
    expect(pagingStatusOf("closed")).toBe("resolved");
    expect(pagingStatusOf("declined")).toBe("resolved");
  });

  it("names the lead as the assignee", () => {
    const incident = toPagingIncident({
      id: "I1",
      reference: "INC-56",
      name: "Checkout down",
      incident_status: { name: "Investigating", category: "live" },
      severity: { name: "Major" },
      incident_role_assignments: [
        { role: { role_type: "reporter" }, assignee: { name: "Rep", email: "r@x.io" } },
        { role: { role_type: "lead" }, assignee: { name: "Ada", email: "ada@x.io" } },
      ],
      created_at: "2026-10-06T00:00:00Z",
    });
    expect(incident).toMatchObject({
      reference: "INC-56",
      status: "acknowledged",
      statusLabel: "Investigating",
      urgency: "Major",
      assignees: [{ name: "Ada", email: "ada@x.io" }],
    });
  });

  it("resolves by trying closed statuses, then post-incident ones", async () => {
    const { c, calls } = client((call) => {
      if (call.url.endsWith("/v1/incident_statuses")) {
        return {
          status: 200,
          body: {
            incident_statuses: [
              { id: "S-live", category: "live", rank: 1 },
              { id: "S-learn", category: "learning", rank: 2 },
              { id: "S-closed", category: "closed", rank: 3 },
            ],
          },
        };
      }
      if (call.url.endsWith("/actions/edit")) {
        const status = (call.body as { incident: { incident_status_id: string } }).incident
          .incident_status_id;
        if (status === "S-closed") {
          return { status: 422, body: { errors: [{ message: "requires post-incident flow" }] } };
        }
        return { status: 200, body: { incident: { id: "I1" } } };
      }
      return {
        status: 200,
        body: {
          incident: { id: "I1", incident_status: { category: "learning", name: "Post-incident" } },
        },
      };
    });
    const updated = await c.updatePagingIncident("I1", { action: "resolve" });
    const edits = calls.filter((x) => x.url.endsWith("/actions/edit"));
    expect(
      edits.map(
        (e) => (e.body as { incident: { incident_status_id: string } }).incident.incident_status_id,
      ),
    ).toEqual(["S-closed", "S-learn"]);
    expect(updated.status).toBe("resolved");
  });

  it("lists open incidents and the window's changes, skipping test incidents", async () => {
    const { c, calls } = client((call) => {
      const q = decodeURIComponent(call.url);
      return {
        status: 200,
        body: {
          incidents: q.includes("status_category[one_of]")
            ? [{ id: "O1", mode: "standard", incident_status: { category: "triage" } }]
            : [
                { id: "R1", mode: "standard", incident_status: { category: "closed" } },
                { id: "T1", mode: "test", incident_status: { category: "live" } },
              ],
          pagination_meta: {},
        },
      };
    });
    const list = await c.listPagingIncidents({ since: new Date("2026-10-05T12:00:00Z") });
    expect(list.map((i) => i.id).sort()).toEqual(["O1", "R1"]);
    expect(
      calls.some((x) => decodeURIComponent(x.url).includes("updated_at[gte]=2026-10-05")),
    ).toBe(true);
  });
});

describe("paging: webhooks", () => {
  const secretBytes = new TextEncoder().encode("super-secret-key-for-tests");
  const secret = `whsec_${bytesToBase64(secretBytes)}`;
  const now = new Date("2026-10-06T12:00:00Z");
  const ts = String(Math.floor(now.getTime() / 1000));

  async function sign(id: string, body: string): Promise<string> {
    return bytesToBase64(
      await hmacSha256(secretBytes as Uint8Array<ArrayBuffer>, `${id}.${ts}.${body}`),
    );
  }

  it("verifies a Svix signature and reads an escalation acknowledgement", async () => {
    const body = JSON.stringify({
      event_type: "public_escalation.escalation_status_updated_v1",
      "public_escalation.escalation_status_updated_v1": {
        new_status: "acked",
        actor: { user: { email: "ada@x.io" } },
        escalation: { id: "E1", related_alerts: [{ deduplication_key: "iw:o:probe:p" }] },
      },
    });
    const result = await verifyWebhook({
      headers: {
        "webhook-id": "msg_1",
        "webhook-timestamp": ts,
        "webhook-signature": `v1,bogus v1,${await sign("msg_1", body)}`,
      },
      body,
      secret,
      now,
    });
    expect(result).toMatchObject({
      valid: true,
      acknowledgedDedupKeys: ["iw:o:probe:p"],
      actorEmail: "ada@x.io",
    });
  });

  it("reads the incident id from incident events, nested or not", async () => {
    for (const [type, payload] of [
      ["public_incident.incident_updated_v2", { id: "I1" }],
      ["public_incident.incident_status_updated_v2", { incident: { id: "I1" } }],
      ["private_incident.incident_updated_v2", { id: "I1" }],
    ] as const) {
      const body = JSON.stringify({ event_type: type, [type]: payload });
      const result = await verifyWebhook({
        headers: {
          "webhook-id": "m",
          "webhook-timestamp": ts,
          "webhook-signature": `v1,${await sign("m", body)}`,
        },
        body,
        secret,
        now,
      });
      expect(result.incidentIds).toEqual(["I1"]);
    }
  });

  it("rejects a bad signature, a stale timestamp and a missing header", async () => {
    const body = "{}";
    const good = await sign("m", body);
    const cases: Array<Record<string, string>> = [
      { "webhook-id": "m", "webhook-timestamp": ts, "webhook-signature": "v1,AAAA" },
      {
        "webhook-id": "m",
        "webhook-timestamp": String(Number(ts) - 600),
        "webhook-signature": `v1,${good}`,
      },
      { "webhook-id": "m", "webhook-timestamp": ts },
    ];
    for (const headers of cases) {
      expect((await verifyWebhook({ headers, body, secret, now })).valid).toBe(false);
    }
  });
});

describe("status feed", () => {
  it("parses incident.io's Statuspage-compatible feed", () => {
    const incidents = parseStatusFeed(
      JSON.stringify({
        page: { id: "p", name: "incident.io", url: "https://status.incident.io" },
        incidents: [
          {
            id: "X1",
            name: "Delayed paging",
            status: "investigating",
            impact: "major",
            created_at: "2026-10-06T10:00:00Z",
            updated_at: "2026-10-06T10:05:00Z",
            started_at: null,
            shortlink: null,
            components: [{ name: "Alert ingestion, processing and paging" }],
            incident_updates: [{ body: "Looking into it", created_at: "2026-10-06T10:05:00Z" }],
          },
        ],
      }),
    );
    expect(incidents).toHaveLength(1);
    expect(incidents[0]!.title).toBe("Delayed paging");
  });
});

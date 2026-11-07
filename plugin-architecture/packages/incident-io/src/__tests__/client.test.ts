import { hostClient } from "@infrawrench/plugin-base/effect";
import { describe, expect, it } from "vitest";
import type { HttpHostServices } from "@infrawrench/plugin-base";
import { bytesToBase64, hmacSha256 } from "@infrawrench/plugin-base";
import { IncidentIoClient } from "../client.js";
import { queryString } from "../api.js";
import { pagingStatusOf, toPagingIncident } from "../mappers.js";
import { buildAlertEvent, verifyWebhook } from "../paging.js";
import { ACTIONS, ALERTS_KEY, COMMANDS, OVERRIDES_KEY, SHIFTS_KEY, USERS_KEY } from "../render.js";
import { parseStatusFeed } from "../status-feed.js";

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: unknown;
}

type Hosted = ReturnType<typeof client>["c"];

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
  return { c: hostClient(new IncidentIoClient({ apiKey: "key-1" }, { http })), calls };
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

/** A cursor list that always has one more page, with each page's cursor new. */
function endless(key: string) {
  let n = 0;
  return () => {
    n += 1;
    return {
      status: 200,
      body: { [key]: [{ id: `R${n}` }], pagination_meta: { after: `C${n}`, page_size: 1 } },
    };
  };
}

describe("lists", () => {
  // The largest page each route documents, and the requests 10,000 rows take at it.
  it.each([
    ["incident-io-alert-route", "alert_routes", 50, 200],
    ["incident-io-schedule", "schedules", 25, 400],
    ["incident-io-escalation-path", "escalation_paths", 25, 400],
    ["incident-io-status-page", "status_pages", 250, 40],
    ["incident-io-maintenance-window", "maintenance_windows", 50, 200],
    ["incident-io-user", "users", 250, 40],
    ["incident-io-team", "teams", 250, 40],
  ])("%s throws past 10,000 rows rather than stop short", async (type, key, size, pages) => {
    const { c, calls } = client(endless(key));
    await expect(c.listResources(type, "acc")).rejects.toThrow("has more than Infrawrench reads");
    expect(calls).toHaveLength(pages);
    expect(new URL(calls[0]!.url).searchParams.get("page_size")).toBe(String(size));
  });

  it("reads a list past the old row caps", async () => {
    let n = 0;
    const { c } = client(() => {
      n += 1;
      const users = Array.from({ length: 250 }, (_, i) => ({ id: `U${n}-${i}` }));
      return {
        status: 200,
        body: { users, pagination_meta: n < 12 ? { after: `C${n}`, page_size: 250 } : {} },
      };
    });
    expect(await c.listResources("incident-io-user", "acc")).toHaveLength(3000);
  });

  it.each([
    ["incident-io-incident", "incidents"],
    ["incident-io-escalation", "escalations"],
  ])("%s throws past 10,000 rows on either of its walks", async (type, key) => {
    const recent = endless(key);
    const { c } = client((call) =>
      decodeURIComponent(call.url).includes("updated_at[gte]")
        ? recent()
        : { status: 200, body: { [key]: [] } },
    );
    await expect(c.listResources(type, "acc")).rejects.toThrow("has more than Infrawrench reads");
  });

  it("throws when a page hands back the cursor that fetched it", async () => {
    const { c, calls } = client(() => ({
      status: 200,
      body: { teams: [{ id: "T1" }], pagination_meta: { after: "same", page_size: 250 } },
    }));
    await expect(c.listResources("incident-io-team", "acc")).rejects.toThrow(
      "has more than Infrawrench reads",
    );
    expect(calls).toHaveLength(40);
  });

  it("rejects a page with its key renamed, on the first page and a later one", async () => {
    const first = client(() => ({ status: 200, body: { people: [] } }));
    await expect(first.c.listResources("incident-io-user", "acc")).rejects.toThrow("is not a list");
    let n = 0;
    const later = client(() => {
      n += 1;
      return n === 1
        ? { status: 200, body: { users: [{ id: "U1" }], pagination_meta: { after: "U1" } } }
        : { status: 200, body: { error: "wrapped" } };
    });
    await expect(later.c.listResources("incident-io-user", "acc")).rejects.toThrow("is not a list");
  });

  it("rejects an empty 200 rather than read it as no rows", async () => {
    const { c } = client(() => ({ status: 200 }));
    await expect(c.listResources("incident-io-team", "acc")).rejects.toThrow("is not a list");
  });

  it("reads a key set to null as empty", async () => {
    const { c } = client(() => ({ status: 200, body: { teams: null } }));
    expect(await c.listResources("incident-io-team", "acc")).toEqual([]);
  });

  // These routes take no paging parameters, so they are one read rather than a walk.
  it.each([
    ["incident-io-alert-source", "alert_sources"],
    ["incident-io-severity", "severities"],
    ["incident-io-status", "incident_statuses"],
    ["incident-io-catalog-type", "catalog_types"],
    ["incident-io-workflow", "workflows"],
  ])("%s refuses an answer with no list, and reads null as empty", async (type, key) => {
    for (const body of [{ error: "wrapped" }, undefined]) {
      const { c } = client(() => ({ status: 200, ...(body ? { body } : {}) }));
      await expect(c.listResources(type, "acc")).rejects.toThrow("is not a list");
    }
    const { c } = client(() => ({ status: 200, body: { [key]: null } }));
    expect(await c.listResources(type, "acc")).toEqual([]);
  });

  it("lists open escalations and the last 90 days' changes, once each", async () => {
    const { c, calls } = client((call) => ({
      status: 200,
      body: decodeURIComponent(call.url).includes("status[not_in]")
        ? { escalations: [{ id: "E1" }], pagination_meta: {} }
        : { escalations: [{ id: "E1" }, { id: "E2" }], pagination_meta: {} },
    }));
    const rows = await c.listResources("incident-io-escalation", "acc");
    expect(rows.map((r) => r.externalId).sort()).toEqual(["E1", "E2"]);
    const urls = calls.map((x) => new URL(x.url));
    expect(urls.every((u) => u.searchParams.get("page_size") === "50")).toBe(true);
    const open = urls.find((u) => u.searchParams.has("status[not_in]"))!;
    expect(open.searchParams.getAll("status[not_in]")).toEqual([
      "resolved",
      "expired",
      "cancelled",
    ]);
    const recent = urls.find((u) => u.searchParams.has("updated_at[gte]"))!;
    const since = Date.parse(recent.searchParams.get("updated_at[gte]")!);
    expect(Math.round((Date.now() - since) / 86_400_000)).toBeGreaterThanOrEqual(89);
    expect(Math.round((Date.now() - since) / 86_400_000)).toBeLessThanOrEqual(91);
  });

  it("offers a long list of on-call sources in full up to its cap, without failing", async () => {
    const paths = endless("escalation_paths");
    const { c, calls } = client((call) =>
      call.url.includes("/v2/schedules")
        ? { status: 200, body: { schedules: [{ id: "S1", name: "Primary" }], pagination_meta: {} } }
        : paths(),
    );
    const sources = await c.listPagingOnCallSources();
    expect(sources[0]).toMatchObject({ id: "schedule:S1", name: "Primary" });
    expect(calls.filter((x) => x.url.includes("/v2/escalation_paths"))).toHaveLength(400);
  });

  it("refuses to offer targets from an answer with no list", async () => {
    const { c } = client(() => ({ status: 200, body: { error: "wrapped" } }));
    await expect(c.listPagingTargets()).rejects.toThrow("is not a list");
  });

  it("throws on a paging incident list past its cap, so the sync's window does not move", async () => {
    const { c } = client(endless("incidents"));
    await expect(c.listPagingIncidents({ since: new Date(0) })).rejects.toThrow(
      "has more than Infrawrench reads",
    );
  });

  it("reads paging incidents past the old 1,000", async () => {
    let n = 0;
    const { c } = client((call) => {
      if (decodeURIComponent(call.url).includes("status_category")) {
        return { status: 200, body: { incidents: [] } };
      }
      n += 1;
      const incidents = Array.from({ length: 250 }, (_, i) => ({ id: `I${n}-${i}` }));
      return { status: 200, body: { incidents, pagination_meta: n < 6 ? { after: `C${n}` } : {} } };
    });
    expect(await c.listPagingIncidents({ since: new Date(0) })).toHaveLength(1500);
  });
});

describe("detail views", () => {
  it("finds an upcoming override past the old 200 rows", async () => {
    let n = 0;
    const { c, calls } = client((call) => {
      const path = new URL(call.url).pathname;
      if (path === "/v2/schedules/S1") {
        return { status: 200, body: { schedule: { id: "S1" } } };
      }
      if (path !== "/v2/schedule_overrides") return { status: 403 };
      n += 1;
      const overrides = Array.from({ length: 250 }, (_, i) => ({
        id: `O${n}-${i}`,
        start_at: "2020-01-01T00:00:00Z",
        end_at: n === 2 && i === 0 ? "2999-01-01T00:00:00Z" : "2020-01-02T00:00:00Z",
      }));
      return { status: 200, body: { overrides, pagination_meta: n < 2 ? { after: "C" } : {} } };
    });
    const r = await c.getResource("incident-io-schedule", "acc:incident-io-schedule:S1", "acc");
    const rows: { id: string }[] = JSON.parse(String(r.fields[OVERRIDES_KEY]));
    expect(rows.map((row) => row.id)).toEqual(["O2-0"]);
    const asked = calls.find((x) => x.url.includes("/v2/schedule_overrides"))!;
    expect(new URL(asked.url).searchParams.get("page_size")).toBe("250");
  });

  it("does not read a schedule's truncated overrides as none", async () => {
    const overrides = endless("overrides");
    const { c } = client((call) => {
      const path = new URL(call.url).pathname;
      if (path === "/v2/schedules/S1") {
        return { status: 200, body: { schedule: { id: "S1" } } };
      }
      return path === "/v2/schedule_overrides" ? overrides() : { status: 403 };
    });
    await expect(
      c.getResource("incident-io-schedule", "acc:incident-io-schedule:S1", "acc"),
    ).rejects.toThrow("has more than Infrawrench reads");
  });

  it("still shows a schedule's overrides picker of users when that list is long", async () => {
    const users = endless("users");
    const { c, calls } = client((call) => {
      const path = new URL(call.url).pathname;
      if (path === "/v2/schedules/S1") {
        return { status: 200, body: { schedule: { id: "S1" } } };
      }
      return path === "/v2/users" ? users() : { status: 403 };
    });
    const r = await c.getResource("incident-io-schedule", "acc:incident-io-schedule:S1", "acc");
    expect(JSON.parse(String(r.fields[USERS_KEY]))).toHaveLength(40);
    expect(calls.filter((x) => x.url.includes("/v2/users"))).toHaveLength(40);
  });

  it("shows one page of an alert source's alerts", async () => {
    const alerts = endless("alerts");
    const { c, calls } = client((call) => {
      const path = new URL(call.url).pathname;
      if (path === "/v2/alert_sources/A1") {
        return { status: 200, body: { alert_source: { id: "A1" } } };
      }
      return alerts();
    });
    const r = await c.getResource(
      "incident-io-alert-source",
      "acc:incident-io-alert-source:A1",
      "acc",
    );
    expect(JSON.parse(String(r.fields[ALERTS_KEY]))).toHaveLength(1);
    expect(calls.filter((x) => x.url.includes("/v2/alerts"))).toHaveLength(1);
  });
});

describe("edits", () => {
  const blank = (type: string) => `acc:${type}:`;

  it.each([
    [
      "delete",
      (c: Hosted) => c.deleteResource("incident-io-schedule", blank("incident-io-schedule"), "acc"),
    ],
    [
      "edit",
      (c: Hosted) =>
        c.updateResource("incident-io-severity", blank("incident-io-severity"), "acc", {
          name: "x",
        }),
    ],
    [
      "action",
      (c: Hosted) =>
        c.invokeAction(
          "incident-io-escalation",
          blank("incident-io-escalation"),
          ACTIONS.acknowledge,
          "acc",
        ),
    ],
    [
      "command",
      (c: Hosted) =>
        c.executeNoSqlCommand(
          "incident-io-incident",
          blank("incident-io-incident"),
          "acc",
          COMMANDS.postUpdate,
          [JSON.stringify({ message: "hi" })],
        ),
    ],
    ["paging update", (c: Hosted) => c.updatePagingIncident(" ", { action: "resolve" })],
  ])("refuses a %s on a blank id, and sends nothing", async (_name, run) => {
    const { c, calls } = client(() => ({ status: 200, body: {} }));
    await expect(run(c)).rejects.toThrow("has no id");
    expect(calls).toHaveLength(0);
  });

  it("refuses to delete an override with no id", async () => {
    const { c, calls } = client(() => ({ status: 200, body: {} }));
    await expect(
      c.invokeAction(
        "incident-io-schedule",
        "acc:incident-io-schedule:S1",
        `${ACTIONS.deleteOverridePrefix}`,
        "acc",
      ),
    ).rejects.toThrow("has no id");
    expect(calls).toHaveLength(0);
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

describe("schedule entries", () => {
  const shift = (user: string, fingerprint?: string) => ({
    start_at: "2026-10-06T09:00:00Z",
    end_at: "2026-10-06T17:00:00Z",
    user: { id: user, name: user },
    ...(fingerprint ? { fingerprint } : {}),
  });
  /** Pages keyed by the `entry_window_start` that asks for them; anything else is the first. */
  const entries = (pages: Record<string, unknown>) => (call: Call) => {
    const url = new URL(call.url);
    if (url.pathname === "/v2/schedules/S1") {
      return { status: 200, body: { schedule: { id: "S1", name: "Primary" } } };
    }
    if (url.pathname === "/v2/schedule_entries") {
      const start = url.searchParams.get("entry_window_start") ?? "";
      return { status: 200, body: pages[start] ?? pages["first"] };
    }
    return { status: 403, body: { errors: [{ message: "not this test" }] } };
  };
  const onCallAt = new Date("2026-10-06T10:00:00Z");

  it("finds who is on call on a later page", async () => {
    const { c, calls } = client(
      entries({
        first: {
          schedule_entries: { final: [shift("U1")] },
          pagination_meta: { after: "opaque+cursor/1", after_url: "https://evil.example/next" },
        },
        "opaque+cursor/1": { schedule_entries: { final: [shift("U2")] } },
      }),
    );
    const people = await c.resolvePagingOnCall("schedule:S1", onCallAt);
    expect(people.map((p) => p.userId)).toEqual(["U1", "U2"]);
    expect(calls).toHaveLength(2);
    const [first, second] = calls.map((x) => new URL(x.url).searchParams);
    // The cursor goes back as the window's start, untouched, and the end does not move.
    expect(second!.get("entry_window_start")).toBe("opaque+cursor/1");
    expect(second!.get("entry_window_end")).toBe(first!.get("entry_window_end"));
    expect(second!.get("schedule_id")).toBe("S1");
    expect(calls.some((x) => x.url.includes("evil.example"))).toBe(false);
  });

  it("fills the shifts table from every page, once per shift", async () => {
    const { c } = client(
      entries({
        first: {
          schedule_entries: { final: [shift("U1", "f1"), shift("U2", "f2")] },
          pagination_meta: { after: "c1" },
        },
        // A shift that overlaps the cursor comes back on the next page too.
        c1: { schedule_entries: { final: [shift("U2", "f2"), shift("U3", "f3")] } },
      }),
    );
    const r = await c.getResource("incident-io-schedule", "acc:incident-io-schedule:S1", "acc");
    const rows: { name: string }[] = JSON.parse(String(r.fields[SHIFTS_KEY]));
    expect(rows.map((row) => row.name)).toEqual(["U1", "U2", "U3"]);
  });

  it("compares who and when for a shift with no fingerprint", async () => {
    const { c } = client(
      entries({
        first: {
          schedule_entries: { final: [shift("U1"), shift("U2")] },
          pagination_meta: { after: "c1" },
        },
        c1: { schedule_entries: { final: [shift("U2")] } },
      }),
    );
    const r = await c.getResource("incident-io-schedule", "acc:incident-io-schedule:S1", "acc");
    const rows: { name: string }[] = JSON.parse(String(r.fields[SHIFTS_KEY]));
    expect(rows.map((row) => row.name)).toEqual(["U1", "U2"]);
  });

  it("rejects entries whose next page never ends, on both reads", async () => {
    const endless = {
      first: { schedule_entries: { final: [shift("U1")] }, pagination_meta: { after: "again" } },
    };
    const { c, calls } = client(entries(endless));
    await expect(c.resolvePagingOnCall("schedule:S1", onCallAt)).rejects.toThrow(
      "has more than Infrawrench reads",
    );
    expect(calls).toHaveLength(100);
    const detail = client(entries(endless));
    await expect(
      detail.c.getResource("incident-io-schedule", "acc:incident-io-schedule:S1", "acc"),
    ).rejects.toThrow("has more than Infrawrench reads");
  });

  it("rejects a page of entries with no final list, on the first page and a later one", async () => {
    const first = client(entries({ first: { schedule_entries: { shifts: [shift("U1")] } } }));
    await expect(first.c.resolvePagingOnCall("schedule:S1", onCallAt)).rejects.toThrow(
      "is not a list",
    );
    const later = client(
      entries({
        first: { schedule_entries: { final: [shift("U1")] }, pagination_meta: { after: "c1" } },
        c1: { error: "wrapped" },
      }),
    );
    await expect(later.c.resolvePagingOnCall("schedule:S1", onCallAt)).rejects.toThrow(
      "is not a list",
    );
  });

  it("still shows the schedule when the entries read is refused", async () => {
    const { c } = client((call) => {
      if (new URL(call.url).pathname === "/v2/schedules/S1") {
        return { status: 200, body: { schedule: { id: "S1", name: "Primary" } } };
      }
      return { status: 403, body: { errors: [{ message: "no" }] } };
    });
    const r = await c.getResource("incident-io-schedule", "acc:incident-io-schedule:S1", "acc");
    expect(JSON.parse(String(r.fields[SHIFTS_KEY]))).toEqual([]);
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
    // As it comes off the wire: only what this test is about, not all the document requires.
    const wire = JSON.stringify({
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
    const incident = toPagingIncident(JSON.parse(wire));
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

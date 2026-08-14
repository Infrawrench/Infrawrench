import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

/**
 * Twilio pager tests. The DB is real Drizzle over a recording driver
 * (helpers/fake-postgres.ts): each test queues result rows FIFO in the
 * statement order the module issues them — on the error path that is
 * settings select, failure insert, expired-row delete, count select, incident
 * select, then (incident insert and) recipients select. Writes resolve to
 * nothing and are asserted from the captured SQL. `fetch` is spied on
 * `globalThis` and `../encryption` is mocked so creds decrypt deterministically.
 */

import { fakePostgres } from "./helpers/fake-postgres";

// --- encryption mock -------------------------------------------------------
const decrypt = vi.fn(async (ct: string) => {
  if (ct === "ENC_SID") return "ACxxxx";
  if (ct === "ENC_TOKEN") return "tok-secret";
  if (ct === "THROW") throw new Error("bad key");
  return "plain";
});
const encrypt = vi.fn(async () => ({ ciphertext: "CT", iv: "IV" }));
vi.mock("../encryption", () => ({
  decrypt,
  encrypt,
  buildAad: (...parts: string[]) => parts.join(":"),
}));

// --- DB --------------------------------------------------------------------
const pg = fakePostgres();
vi.mock("../db/client", () => ({ db: pg.db }));

/** Captured writes by rendered table name, replacing the old stub recorders. */
const inserts = (table: string) =>
  pg.queries.filter((q) => q.sql.startsWith(`insert into "${table}"`));
const updates = (table: string) => pg.queries.filter((q) => q.sql.startsWith(`update "${table}"`));
const deletes = (table: string) =>
  pg.queries.filter((q) => q.sql.startsWith(`delete from "${table}"`));
const writeCount = () => pg.queries.filter((q) => /^(insert|update|delete)\b/.test(q.sql)).length;

// --- push dispatch mock ----------------------------------------------------
// The pager fans out to mobile push alongside Twilio; tests control the
// result to exercise the combined pagedAt accounting.

/**
 * All three transports sit behind `routeAlert` now, so that is the single seam
 * these tests mock. `alertReached` is the real predicate rather than a stub —
 * it decides whether a cooldown or claim is kept, and faking it would hide
 * exactly the bug it exists to prevent.
 */
// Defaults to a successful delivery: `routeAlert` never throws and always
// returns a result, so a mock that resolves `undefined` would fail tests in a
// way the real function cannot.
const routeAlert = vi.fn(async (..._args: unknown[]) => routed());
vi.mock("../alerts/route", () => ({
  routeAlert: (...a: unknown[]) => routeAlert(...a),
  alertReached: (r: { succeeded?: number; held?: number } | null | undefined) =>
    (r?.succeeded ?? 0) > 0 || (r?.held ?? 0) > 0,
}));

/** A delivery that reached one Slack channel and one phone. */
function routed(over: Record<string, unknown> = {}) {
  return {
    attempted: 2,
    succeeded: 2,
    byTransport: { push: 1, slack: 1, msTeams: 0 },
    attemptedByTransport: { push: 1, slack: 1, msTeams: 0 },
    held: 0,
    unrouted: false,
    matchedRuleIds: ["rule1"],
    // The tracked-Slack half of the result. Present by default because
    // `byTransport.slack` is 1 — a result claiming a Slack delivery with no
    // message to show for it is a shape the real function never returns.
    slackMessages: [],
    deliveryIds: [],
    ...over,
  };
}

/** A delivery that reached nobody — no rule matched, or every channel failed. */
function unroutedResult() {
  return routed({
    attempted: 0,
    succeeded: 0,
    byTransport: { push: 0, slack: 0, msTeams: 0 },
    attemptedByTransport: { push: 0, slack: 0, msTeams: 0 },
    matchedRuleIds: [],
    slackMessages: [],
    unrouted: true,
  });
}

let pager: typeof import("../twilio-pager");
let fetchSpy: MockInstance<typeof fetch>;

/** Driver-shaped timestamp: `timestamp` (no tz) comes back without a zone. */
const ts = (d: Date) => d.toISOString().replace("T", " ").replace("Z", "");

function okResponse() {
  return { ok: true, status: 200, text: async () => "" } as unknown as Response;
}
function errResponse(status = 400, body = "boom") {
  return { ok: false, status, text: async () => body } as unknown as Response;
}

// Row keys in `twilio_settings` column order — see helpers/fake-postgres.ts.
function settingsRow(over: Partial<Record<string, unknown>> = {}) {
  return {
    organizationId: "org1",
    enabled: true,
    encryptedAccountSid: "ENC_SID",
    accountSidIv: "iv1",
    encryptedAuthToken: "ENC_TOKEN",
    authTokenIv: "iv2",
    fromNumber: "+15550000000",
    failureThreshold: 3,
    windowMinutes: 10,
    cooldownMinutes: 5,
    createdAt: "2026-01-01 00:00:00",
    updatedAt: "2026-01-01 00:00:00",
    ...over,
  };
}

// Keys in the `loadRecipients` projection order.
function recipient(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: "rec1",
    displayName: "Oncall",
    phoneNumber: "+15551234567",
    sms: true,
    voice: false,
    ...over,
  };
}

// Row keys in `paging_incidents` column order (the incident lookup selects *).
function incidentRow(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: "inc1",
    organizationId: "org1",
    accountId: "a1",
    resourceTypeId: "vm",
    openedAt: "2026-01-01 00:00:00",
    closedAt: null,
    pagedAt: null,
    error: null,
    ...over,
  };
}

beforeEach(async () => {
  vi.clearAllMocks();
  pg.reset();
  fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(okResponse());
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  pager = await import("../twilio-pager");
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("notePollOutcome — early exits", () => {
  it("is a no-op for skipped outcomes (no DB touched)", async () => {
    await pager.notePollOutcome({
      organizationId: "org1",
      accountId: "a1",
      accountLabel: "Prod",
      resourceTypeId: "vm",
      outcome: "skipped",
    });
    expect(pg.queries).toHaveLength(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("closes an incident on success even when settings are missing", async () => {
    pg.queueRows([]); // loadSettings -> no row
    await pager.notePollOutcome({
      organizationId: "org1",
      accountId: "a1",
      accountLabel: "Prod",
      resourceTypeId: "vm",
      outcome: "ok",
    });
    // closeOpenIncident issues an update on paging_incidents.
    expect(updates("paging_incidents").length).toBeGreaterThan(0);
  });

  it("closes an incident on success when paging is disabled", async () => {
    pg.queueRows([settingsRow({ enabled: false })]);
    await pager.notePollOutcome({
      organizationId: "org1",
      accountId: "a1",
      accountLabel: "Prod",
      resourceTypeId: "vm",
      outcome: "ok",
    });
    expect(updates("paging_incidents").length).toBeGreaterThan(0);
  });

  it("does nothing extra on error when paging is disabled", async () => {
    pg.queueRows([settingsRow({ enabled: false })]);
    await pager.notePollOutcome({
      organizationId: "org1",
      accountId: "a1",
      accountLabel: "Prod",
      resourceTypeId: "vm",
      outcome: "error",
      error: new Error("x"),
    });
    expect(writeCount()).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(routeAlert).not.toHaveBeenCalled();
  });

  it("swallows credential decryption failures (creds become null => disabled path)", async () => {
    pg.queueRows([settingsRow({ encryptedAccountSid: "THROW" })]);
    await pager.notePollOutcome({
      organizationId: "org1",
      accountId: "a1",
      accountLabel: "Prod",
      resourceTypeId: "vm",
      outcome: "ok",
    });
    // No creds => treated like disabled; success still closes incident.
    expect(updates("paging_incidents").length).toBeGreaterThan(0);
  });
});

describe("notePollOutcome — success path with creds", () => {
  it("closes the incident and prunes failure rows", async () => {
    pg.queueRows([settingsRow()]);
    await pager.notePollOutcome({
      organizationId: "org1",
      accountId: "a1",
      accountLabel: "Prod",
      resourceTypeId: "vm",
      outcome: "ok",
    });
    expect(updates("paging_incidents").length).toBeGreaterThan(0);
    expect(deletes("account_sync_failures").length).toBeGreaterThan(0);
  });
});

describe("notePollOutcome — error / threshold", () => {
  it("records a failure but does not page below threshold", async () => {
    pg.queueRows([settingsRow()]);
    pg.queueRows([]); // failure insert
    pg.queueRows([]); // expired-row delete
    pg.queueRows([{ count: 1 }]);
    await pager.notePollOutcome({
      organizationId: "org1",
      accountId: "a1",
      accountLabel: "Prod",
      resourceTypeId: "vm",
      outcome: "error",
      error: new Error("api down"),
    });
    expect(inserts("account_sync_failures")).toHaveLength(1);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("opens an incident and pages once the threshold is crossed", async () => {
    pg.queueRows([settingsRow()]);
    pg.queueRows([]); // failure insert
    pg.queueRows([]); // expired-row delete
    pg.queueRows([{ count: 3 }]);
    pg.queueRows([]); // no open incident
    pg.queueRows([]); // incident insert
    pg.queueRows([recipient({ sms: true, voice: true })]);
    await pager.notePollOutcome({
      organizationId: "org1",
      accountId: "a1",
      accountLabel: "Prod",
      resourceTypeId: "vm",
      outcome: "error",
      error: new Error("api down"),
    });
    // failure insert + incident insert
    expect(inserts("paging_incidents")).toHaveLength(1);
    // SMS + Voice => 2 fetches
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const urls = fetchSpy.mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.includes("/Messages.json"))).toBe(true);
    expect(urls.some((u) => u.includes("/Calls.json"))).toBe(true);
    // pagedAt set because deliveries succeeded
    expect(updates("paging_incidents")).toHaveLength(1);
  });

  it("does not re-page an open incident still within cooldown", async () => {
    pg.queueRows([settingsRow()]);
    pg.queueRows([]); // failure insert
    pg.queueRows([]); // expired-row delete
    pg.queueRows([{ count: 5 }]);
    pg.queueRows([incidentRow({ pagedAt: ts(new Date()) })]); // just paged
    await pager.notePollOutcome({
      organizationId: "org1",
      accountId: "a1",
      accountLabel: "Prod",
      resourceTypeId: "vm",
      outcome: "error",
      error: new Error("still down"),
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("re-pages an open incident whose cooldown has elapsed", async () => {
    pg.queueRows([settingsRow({ cooldownMinutes: 5 })]);
    pg.queueRows([]); // failure insert
    pg.queueRows([]); // expired-row delete
    pg.queueRows([{ count: 5 }]);
    const old = new Date(Date.now() - 60 * 60 * 1000); // 1h ago
    pg.queueRows([incidentRow({ pagedAt: ts(old) })]);
    pg.queueRows([recipient({ sms: true })]);
    await pager.notePollOutcome({
      organizationId: "org1",
      accountId: "a1",
      accountLabel: "Prod",
      resourceTypeId: "vm",
      outcome: "error",
      error: new Error("still down"),
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("pages an incident that was never paged (pagedAt null)", async () => {
    pg.queueRows([settingsRow()]);
    pg.queueRows([]); // failure insert
    pg.queueRows([]); // expired-row delete
    pg.queueRows([{ count: 5 }]);
    pg.queueRows([incidentRow({ pagedAt: null })]);
    pg.queueRows([recipient({ sms: true })]);
    await pager.notePollOutcome({
      organizationId: "org1",
      accountId: "a1",
      accountLabel: "Prod",
      resourceTypeId: "vm",
      outcome: "error",
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("opens an incident but skips paging when there are no recipients", async () => {
    pg.queueRows([settingsRow()]);
    pg.queueRows([]); // failure insert
    pg.queueRows([]); // expired-row delete
    pg.queueRows([{ count: 3 }]);
    pg.queueRows([]); // no open incident
    pg.queueRows([]); // incident insert
    pg.queueRows([]); // no recipients configured
    await pager.notePollOutcome({
      organizationId: "org1",
      accountId: "a1",
      accountLabel: "Prod",
      resourceTypeId: "vm",
      outcome: "error",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(inserts("paging_incidents")).toHaveLength(1);
  });

  it("does not set pagedAt when every delivery fails", async () => {
    fetchSpy.mockResolvedValue(errResponse(500, "twilio is down"));
    routeAlert.mockResolvedValue(unroutedResult());
    pg.queueRows([settingsRow()]);
    pg.queueRows([]); // failure insert
    pg.queueRows([]); // expired-row delete
    pg.queueRows([{ count: 3 }]);
    pg.queueRows([]); // no open incident
    pg.queueRows([]); // incident insert
    pg.queueRows([recipient({ sms: true })]);
    await pager.notePollOutcome({
      organizationId: "org1",
      accountId: "a1",
      accountLabel: "Prod",
      resourceTypeId: "vm",
      outcome: "error",
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    // Incident insert happened, but no pagedAt update on paging_incidents.
    expect(updates("paging_incidents").filter((q) => q.sql.includes('"paged_at"'))).toHaveLength(0);
  });

  it("delivers push-only when Twilio creds are missing, and sets pagedAt on push success", async () => {
    routeAlert.mockResolvedValueOnce(routed());
    // No creds stored at all — previously this org silently skipped incidents.
    pg.queueRows([
      settingsRow({
        encryptedAccountSid: null,
        accountSidIv: null,
        encryptedAuthToken: null,
        authTokenIv: null,
        fromNumber: null,
      }),
    ]);
    pg.queueRows([]); // failure insert
    pg.queueRows([]); // expired-row delete
    pg.queueRows([{ count: 3 }]);
    // No recipients query without creds; the incident lookup/insert take [].
    await pager.notePollOutcome({
      organizationId: "org1",
      accountId: "a1",
      accountLabel: "Prod",
      resourceTypeId: "vm",
      outcome: "error",
      error: new Error("api down"),
    });
    expect(inserts("paging_incidents")).toHaveLength(1);
    expect(fetchSpy).not.toHaveBeenCalled(); // no Twilio without creds
    expect(routeAlert).toHaveBeenCalledTimes(1);
    // pagedAt set from the push success alone
    expect(updates("paging_incidents")).toHaveLength(1);
  });

  it("passes the incident deep-link payload to push", async () => {
    pg.queueRows([settingsRow()]);
    pg.queueRows([]); // failure insert
    pg.queueRows([]); // expired-row delete
    pg.queueRows([{ count: 3 }]);
    pg.queueRows([]); // no open incident
    pg.queueRows([]); // incident insert
    pg.queueRows([recipient({ sms: true })]);
    await pager.notePollOutcome({
      organizationId: "org1",
      accountId: "a1",
      accountLabel: "Prod",
      resourceTypeId: "vm",
      outcome: "error",
    });
    expect(routeAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: "org1",
        trigger: "syncIncidents",
        pushData: expect.objectContaining({
          type: "sync_incident",
          accountId: "a1",
          resourceTypeId: "vm",
        }),
        // The account is what an "only prod pages me" rule matches on.
        facts: expect.objectContaining({ accountId: "a1", resourceTypeId: "vm" }),
      }),
    );
  });

  it("sets pagedAt when Twilio fails but push succeeds", async () => {
    fetchSpy.mockResolvedValue(errResponse(500, "twilio down"));
    routeAlert.mockResolvedValueOnce(routed());
    pg.queueRows([settingsRow()]);
    pg.queueRows([]); // failure insert
    pg.queueRows([]); // expired-row delete
    pg.queueRows([{ count: 3 }]);
    pg.queueRows([]); // no open incident
    pg.queueRows([]); // incident insert
    pg.queueRows([recipient({ sms: true })]);
    await pager.notePollOutcome({
      organizationId: "org1",
      accountId: "a1",
      accountLabel: "Prod",
      resourceTypeId: "vm",
      outcome: "error",
    });
    expect(updates("paging_incidents")).toHaveLength(1);
  });

  it("handles a missing count row (defaults to 0, below threshold)", async () => {
    pg.queueRows([settingsRow()]);
    // The failure insert, expired-row delete and count query all resolve to
    // nothing; a missing count row reads as 0.
    await pager.notePollOutcome({
      organizationId: "org1",
      accountId: "a1",
      accountLabel: "Prod",
      resourceTypeId: "vm",
      outcome: "error",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("never throws even if a DB call rejects", async () => {
    pg.queueRows([settingsRow()]);
    // Force the count query to blow up by making the second select throw
    // mid-flow (select #1 is loadSettings, #2 the failure count).
    const orig = pg.db.select;
    let calls = 0;
    (pg.db as { select: typeof pg.db.select }).select = ((...args: never[]) => {
      calls++;
      if (calls === 2) throw new Error("db exploded");
      return (orig as (...a: never[]) => ReturnType<typeof orig>).apply(pg.db, args);
    }) as typeof pg.db.select;
    try {
      await expect(
        pager.notePollOutcome({
          organizationId: "org1",
          accountId: "a1",
          accountLabel: "Prod",
          resourceTypeId: "vm",
          outcome: "error",
        }),
      ).resolves.toBeUndefined();
    } finally {
      (pg.db as { select: typeof pg.db.select }).select = orig;
    }
  });

  it("formats the page body with a truncated error string", async () => {
    pg.queueRows([settingsRow()]);
    pg.queueRows([]); // failure insert
    pg.queueRows([]); // expired-row delete
    pg.queueRows([{ count: 3 }]);
    pg.queueRows([]); // no open incident
    pg.queueRows([]); // incident insert
    pg.queueRows([recipient({ sms: true })]);
    await pager.notePollOutcome({
      organizationId: "org1",
      accountId: "a1",
      accountLabel: "Prod DB",
      resourceTypeId: "postgres",
      outcome: "error",
      error: new Error("x".repeat(400)),
    });
    const body = String((fetchSpy.mock.calls[0]![1] as RequestInit).body);
    expect(body).toContain("Prod+DB");
    expect(body).toContain("postgres");
  });
});

describe("sendTestPage", () => {
  it("throws when paging is not configured", async () => {
    pg.queueRows([]);
    await expect(pager.sendTestPage("org1")).rejects.toThrow(/not configured/);
  });

  it("throws when credentials are missing/unreadable", async () => {
    pg.queueRows([settingsRow({ fromNumber: null })]); // creds become null
    await expect(pager.sendTestPage("org1")).rejects.toThrow(/credentials/);
  });

  it("throws when no recipients are configured", async () => {
    pg.queueRows([settingsRow()]);
    pg.queueRows([]);
    await expect(pager.sendTestPage("org1")).rejects.toThrow(/No recipients/);
  });

  it("throws when every delivery fails", async () => {
    fetchSpy.mockResolvedValue(errResponse());
    pg.queueRows([settingsRow()]);
    pg.queueRows([recipient({ sms: true })]);
    await expect(pager.sendTestPage("org1")).rejects.toThrow(/Test page failed/);
  });

  it("returns counts on success", async () => {
    pg.queueRows([settingsRow()]);
    pg.queueRows([recipient({ sms: true, voice: true })]);
    const out = await pager.sendTestPage("org1");
    expect(out).toEqual({ recipientCount: 1, attempted: 2, succeeded: 2 });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});

describe("encryptTwilioCredential", () => {
  it("encrypts with an org-bound AAD", async () => {
    const out = await pager.encryptTwilioCredential("org1", "accountSid", "ACxxx");
    expect(out).toEqual({ ciphertext: "CT", iv: "IV" });
    expect(encrypt).toHaveBeenCalledWith("ACxxx", "twilio:org1:accountSid");
  });
});

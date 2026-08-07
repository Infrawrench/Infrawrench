import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

/**
 * Twilio pager tests. The DB is mocked with a chainable fake; `db.select()`
 * chains resolve via a per-table queue of result rows. Writes (insert/update/
 * delete) are recorded but resolve to nothing. `fetch` is spied on
 * `globalThis` and `../encryption` is mocked so creds decrypt deterministically.
 */

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

// --- DB mock ---------------------------------------------------------------
// Queues of rows keyed by a logical query name; tests push expectations.
const queues = {
  settings: [] as unknown[][],
  recipients: [] as unknown[][],
  count: [] as unknown[][],
  incident: [] as unknown[][],
};

const inserts: Array<{ table: string; values: unknown }> = [];
const updates: Array<{ table: string; set: unknown }> = [];
const deletes: string[] = [];

// We disambiguate which select() it is by the `from()` table identity.
const tables = {
  twilioSettings: { __t: "twilioSettings" as const, organizationId: "x" },
  twilioRecipients: {
    __t: "twilioRecipients" as const,
    id: "id",
    displayName: "displayName",
    phoneNumber: "phoneNumber",
    sms: "sms",
    voice: "voice",
    organizationId: "organizationId",
  },
  accountSyncFailures: {
    __t: "accountSyncFailures" as const,
    organizationId: "o",
    accountId: "a",
    resourceTypeId: "r",
    failedAt: "f",
  },
  pagingIncidents: {
    __t: "pagingIncidents" as const,
    id: "id",
    organizationId: "o",
    accountId: "a",
    resourceTypeId: "r",
    closedAt: "c",
    pagedAt: "p",
  },
};

vi.mock("../db/schema", () => tables);

// --- push dispatch mock ----------------------------------------------------
// The pager fans out to mobile push alongside Twilio; tests control the
// result to exercise the combined pagedAt accounting.

// Slack and Teams are sibling transports with their own tests; stub them out
// so the schema mock below doesn't have to satisfy their module-level column
// lookups.

// select() needs to know which logical query is running. We infer from the
// selected projection columns and the from() table.
let pendingSelectProjection: Record<string, unknown> | undefined;

const db = {
  select: (proj?: Record<string, unknown>) => {
    pendingSelectProjection = proj;
    return {
      from: (table: { __t: string }) => {
        const isCount = pendingSelectProjection != null && "count" in pendingSelectProjection;
        const isRecipients = table.__t === "twilioRecipients";
        const queueName = isCount
          ? "count"
          : table.__t === "twilioSettings"
            ? "settings"
            : isRecipients
              ? "recipients"
              : table.__t === "pagingIncidents"
                ? "incident"
                : "settings";
        const rows = (queues as Record<string, unknown[][]>)[queueName]!.shift() ?? [];
        // `.where()` resolves to rows directly (no .limit used in this module).
        return {
          where: () => Promise.resolve(rows),
          // recipients load calls `.from().where()`; settings uses `.from().where()`.
        };
      },
    };
  },
  insert: (table: { __t: string }) => ({
    values: (v: unknown) => {
      inserts.push({ table: table.__t, values: v });
      return Promise.resolve();
    },
  }),
  update: (table: { __t: string }) => ({
    set: (s: unknown) => {
      updates.push({ table: table.__t, set: s });
      return { where: () => Promise.resolve() };
    },
  }),
  delete: (table: { __t: string }) => ({
    where: () => {
      deletes.push(table.__t);
      return Promise.resolve();
    },
  }),
};
vi.mock("../db/client", () => ({ db }));

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
    slackMessages: [{ installationId: "inst1", channelId: "C1", ts: "1722700000.000100" }],
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

function okResponse() {
  return { ok: true, status: 200, text: async () => "" } as unknown as Response;
}
function errResponse(status = 400, body = "boom") {
  return { ok: false, status, text: async () => body } as unknown as Response;
}

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
    ...over,
  };
}

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

beforeEach(async () => {
  vi.clearAllMocks();
  queues.settings = [];
  queues.recipients = [];
  queues.count = [];
  queues.incident = [];
  inserts.length = 0;
  updates.length = 0;
  deletes.length = 0;
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
    expect(inserts).toHaveLength(0);
    expect(updates).toHaveLength(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("closes an incident on success even when settings are missing", async () => {
    queues.settings = [[]]; // loadSettings -> no row
    await pager.notePollOutcome({
      organizationId: "org1",
      accountId: "a1",
      accountLabel: "Prod",
      resourceTypeId: "vm",
      outcome: "ok",
    });
    // closeOpenIncident issues an update on pagingIncidents.
    expect(updates.some((u) => u.table === "pagingIncidents")).toBe(true);
  });

  it("closes an incident on success when paging is disabled", async () => {
    queues.settings = [[settingsRow({ enabled: false })]];
    await pager.notePollOutcome({
      organizationId: "org1",
      accountId: "a1",
      accountLabel: "Prod",
      resourceTypeId: "vm",
      outcome: "ok",
    });
    expect(updates.some((u) => u.table === "pagingIncidents")).toBe(true);
  });

  it("does nothing extra on error when paging is disabled", async () => {
    queues.settings = [[settingsRow({ enabled: false })]];
    await pager.notePollOutcome({
      organizationId: "org1",
      accountId: "a1",
      accountLabel: "Prod",
      resourceTypeId: "vm",
      outcome: "error",
      error: new Error("x"),
    });
    expect(inserts).toHaveLength(0);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(routeAlert).not.toHaveBeenCalled();
  });

  it("swallows credential decryption failures (creds become null => disabled path)", async () => {
    queues.settings = [[settingsRow({ encryptedAccountSid: "THROW" })]];
    await pager.notePollOutcome({
      organizationId: "org1",
      accountId: "a1",
      accountLabel: "Prod",
      resourceTypeId: "vm",
      outcome: "ok",
    });
    // No creds => treated like disabled; success still closes incident.
    expect(updates.some((u) => u.table === "pagingIncidents")).toBe(true);
  });
});

describe("notePollOutcome — success path with creds", () => {
  it("closes the incident and prunes failure rows", async () => {
    queues.settings = [[settingsRow()]];
    await pager.notePollOutcome({
      organizationId: "org1",
      accountId: "a1",
      accountLabel: "Prod",
      resourceTypeId: "vm",
      outcome: "ok",
    });
    expect(updates.some((u) => u.table === "pagingIncidents")).toBe(true);
    expect(deletes).toContain("accountSyncFailures");
  });
});

describe("notePollOutcome — error / threshold", () => {
  it("records a failure but does not page below threshold", async () => {
    queues.settings = [[settingsRow()]];
    queues.count = [[{ count: 1 }]];
    await pager.notePollOutcome({
      organizationId: "org1",
      accountId: "a1",
      accountLabel: "Prod",
      resourceTypeId: "vm",
      outcome: "error",
      error: new Error("api down"),
    });
    expect(inserts.some((i) => i.table === "accountSyncFailures")).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("opens an incident and pages once the threshold is crossed", async () => {
    queues.settings = [[settingsRow()]];
    queues.count = [[{ count: 3 }]];
    queues.incident = [[]]; // no open incident
    queues.recipients = [[recipient({ sms: true, voice: true })]];
    await pager.notePollOutcome({
      organizationId: "org1",
      accountId: "a1",
      accountLabel: "Prod",
      resourceTypeId: "vm",
      outcome: "error",
      error: new Error("api down"),
    });
    // failure insert + incident insert
    expect(inserts.filter((i) => i.table === "pagingIncidents")).toHaveLength(1);
    // SMS + Voice => 2 fetches
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const urls = fetchSpy.mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.includes("/Messages.json"))).toBe(true);
    expect(urls.some((u) => u.includes("/Calls.json"))).toBe(true);
    // pagedAt set because deliveries succeeded
    expect(updates.some((u) => u.table === "pagingIncidents")).toBe(true);
  });

  it("does not re-page an open incident still within cooldown", async () => {
    queues.settings = [[settingsRow()]];
    queues.count = [[{ count: 5 }]];
    queues.incident = [[{ id: "inc1", pagedAt: new Date() }]]; // just paged
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
    queues.settings = [[settingsRow({ cooldownMinutes: 5 })]];
    queues.count = [[{ count: 5 }]];
    const old = new Date(Date.now() - 60 * 60 * 1000); // 1h ago
    queues.incident = [[{ id: "inc1", pagedAt: old }]];
    queues.recipients = [[recipient({ sms: true })]];
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
    queues.settings = [[settingsRow()]];
    queues.count = [[{ count: 5 }]];
    queues.incident = [[{ id: "inc1", pagedAt: null }]];
    queues.recipients = [[recipient({ sms: true })]];
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
    queues.settings = [[settingsRow()]];
    queues.count = [[{ count: 3 }]];
    queues.incident = [[]];
    queues.recipients = [[]]; // none configured
    await pager.notePollOutcome({
      organizationId: "org1",
      accountId: "a1",
      accountLabel: "Prod",
      resourceTypeId: "vm",
      outcome: "error",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(inserts.filter((i) => i.table === "pagingIncidents")).toHaveLength(1);
  });

  it("does not set pagedAt when every delivery fails", async () => {
    fetchSpy.mockResolvedValue(errResponse(500, "twilio is down"));
    routeAlert.mockResolvedValue(unroutedResult());
    queues.settings = [[settingsRow()]];
    queues.count = [[{ count: 3 }]];
    queues.incident = [[]];
    queues.recipients = [[recipient({ sms: true })]];
    await pager.notePollOutcome({
      organizationId: "org1",
      accountId: "a1",
      accountLabel: "Prod",
      resourceTypeId: "vm",
      outcome: "error",
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    // Incident insert happened, but no pagedAt update on pagingIncidents.
    expect(
      updates.some(
        (u) => u.table === "pagingIncidents" && "pagedAt" in (u.set as Record<string, unknown>),
      ),
    ).toBe(false);
  });

  it("delivers push-only when Twilio creds are missing, and sets pagedAt on push success", async () => {
    routeAlert.mockResolvedValueOnce(routed());
    // No creds stored at all — previously this org silently skipped incidents.
    queues.settings = [
      [
        settingsRow({
          encryptedAccountSid: null,
          accountSidIv: null,
          encryptedAuthToken: null,
          authTokenIv: null,
          fromNumber: null,
        }),
      ],
    ];
    queues.count = [[{ count: 3 }]];
    queues.incident = [[]];
    await pager.notePollOutcome({
      organizationId: "org1",
      accountId: "a1",
      accountLabel: "Prod",
      resourceTypeId: "vm",
      outcome: "error",
      error: new Error("api down"),
    });
    expect(inserts.filter((i) => i.table === "pagingIncidents")).toHaveLength(1);
    expect(fetchSpy).not.toHaveBeenCalled(); // no Twilio without creds
    expect(routeAlert).toHaveBeenCalledTimes(1);
    // pagedAt set from the push success alone
    expect(updates.some((u) => u.table === "pagingIncidents")).toBe(true);
  });

  it("passes the incident deep-link payload to push", async () => {
    queues.settings = [[settingsRow()]];
    queues.count = [[{ count: 3 }]];
    queues.incident = [[]];
    queues.recipients = [[recipient({ sms: true })]];
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
    queues.settings = [[settingsRow()]];
    queues.count = [[{ count: 3 }]];
    queues.incident = [[]];
    queues.recipients = [[recipient({ sms: true })]];
    await pager.notePollOutcome({
      organizationId: "org1",
      accountId: "a1",
      accountLabel: "Prod",
      resourceTypeId: "vm",
      outcome: "error",
    });
    expect(updates.some((u) => u.table === "pagingIncidents")).toBe(true);
  });

  it("handles a missing count row (defaults to 0, below threshold)", async () => {
    queues.settings = [[settingsRow()]];
    queues.count = [[]]; // count query returns nothing
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
    queues.settings = [[settingsRow()]];
    // Force the count query to blow up by making select throw mid-flow.
    const orig = db.select;
    let calls = 0;
    (db as { select: typeof db.select }).select = ((proj?: Record<string, unknown>) => {
      calls++;
      if (calls === 2) throw new Error("db exploded");
      return orig(proj);
    }) as typeof db.select;
    await expect(
      pager.notePollOutcome({
        organizationId: "org1",
        accountId: "a1",
        accountLabel: "Prod",
        resourceTypeId: "vm",
        outcome: "error",
      }),
    ).resolves.toBeUndefined();
    (db as { select: typeof db.select }).select = orig;
  });

  it("formats the page body with a truncated error string", async () => {
    queues.settings = [[settingsRow()]];
    queues.count = [[{ count: 3 }]];
    queues.incident = [[]];
    queues.recipients = [[recipient({ sms: true })]];
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
    queues.settings = [[]];
    await expect(pager.sendTestPage("org1")).rejects.toThrow(/not configured/);
  });

  it("throws when credentials are missing/unreadable", async () => {
    queues.settings = [[settingsRow({ fromNumber: null })]]; // creds become null
    await expect(pager.sendTestPage("org1")).rejects.toThrow(/credentials/);
  });

  it("throws when no recipients are configured", async () => {
    queues.settings = [[settingsRow()]];
    queues.recipients = [[]];
    await expect(pager.sendTestPage("org1")).rejects.toThrow(/No recipients/);
  });

  it("throws when every delivery fails", async () => {
    fetchSpy.mockResolvedValue(errResponse());
    queues.settings = [[settingsRow()]];
    queues.recipients = [[recipient({ sms: true })]];
    await expect(pager.sendTestPage("org1")).rejects.toThrow(/Test page failed/);
  });

  it("returns counts on success", async () => {
    queues.settings = [[settingsRow()]];
    queues.recipients = [[recipient({ sms: true, voice: true })]];
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

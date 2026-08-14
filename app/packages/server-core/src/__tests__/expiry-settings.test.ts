import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The settings module is the API surface of the expiry radar's tunables. What
 * matters here is the server-side bounds (a zero lead would silence the radar
 * through the API, a huge one would page about everything) and the invariant
 * that a settings save can never touch `lastNotifiedAt` — that column is the
 * poller's cooldown claim, and writing it from the form would re-open or
 * close a quiet period mid-window.
 */

import { fakePostgres } from "./helpers/fake-postgres";

// Real Drizzle over a recording driver against the real schema: the select and
// the upsert render their actual SQL (and shadow-validate under
// test:postgres:shadow). An update issues two queries in order — the
// current-row select, then the upsert's `returning()` — so results are queued.
const pg = fakePostgres();
vi.mock("../db/client", () => ({ db: pg.db }));

const { EXPIRY_ALERT_LIMITS, defaultExpirySettings, getExpirySettings, updateExpirySettings } =
  await import("../expiry/settings");

const ORG = "org1";

/**
 * A stored `org_expiry_settings` row, keys in the table's column order and
 * timestamps driver-shaped (postgres-js "YYYY-MM-DD HH:MM:SS.mmm", read as UTC
 * by the column mapping).
 */
function settingsRow(over: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    organizationId: ORG,
    enabled: true,
    leadDays: 60,
    lastNotifiedAt: null,
    createdAt: "2026-08-01 00:00:00.000",
    updatedAt: "2026-08-01 00:00:00.000",
    ...over,
  };
}

/** Queue one update's two queries: the current-row select, then the upsert. */
function queueUpdate(current: Array<Record<string, unknown>>, saved: Record<string, unknown>) {
  pg.queueRows(current);
  pg.queueRows([saved]);
}

/** The rendered upsert, if one was issued. */
function upsert() {
  return pg.queries.find((q) => q.sql.startsWith('insert into "org_expiry_settings"'));
}

beforeEach(() => {
  pg.reset();
});

describe("getExpirySettings", () => {
  it("reads the shipped defaults when the org has no row", async () => {
    expect(await getExpirySettings(ORG)).toEqual({
      organizationId: ORG,
      enabled: true,
      leadDays: 60,
      lastNotifiedAt: null,
    });
  });

  it("prefers the stored row when one exists", async () => {
    const notified = new Date("2026-07-30T00:00:00.000Z");
    pg.setRows([
      settingsRow({ enabled: false, leadDays: 14, lastNotifiedAt: "2026-07-30 00:00:00.000" }),
    ]);
    expect(await getExpirySettings(ORG)).toEqual({
      organizationId: ORG,
      enabled: false,
      leadDays: 14,
      lastNotifiedAt: notified,
    });
  });
});

describe("updateExpirySettings — bounds", () => {
  it("accepts the full valid range", async () => {
    queueUpdate([], settingsRow({ leadDays: 1 }));
    expect((await updateExpirySettings(ORG, { leadDays: 1 })).leadDays).toBe(1);
    // lead_days in the values tuple — the clamp passed the value through.
    expect(upsert()?.params[2]).toBe(1);

    pg.reset();
    queueUpdate([], settingsRow({ leadDays: 365 }));
    expect((await updateExpirySettings(ORG, { leadDays: 365 })).leadDays).toBe(365);
    expect(upsert()?.params[2]).toBe(365);
  });

  it("rejects a lead of zero — it would silence the radar", async () => {
    await expect(updateExpirySettings(ORG, { leadDays: 0 })).rejects.toThrow(/between 1 and 365/);
    expect(upsert()).toBeUndefined();
  });

  it("rejects a lead past a year", async () => {
    await expect(updateExpirySettings(ORG, { leadDays: 366 })).rejects.toThrow(/between 1 and 365/);
    expect(upsert()).toBeUndefined();
  });

  it("rejects fractional days", async () => {
    await expect(updateExpirySettings(ORG, { leadDays: 30.5 })).rejects.toThrow(/whole number/);
    expect(upsert()).toBeUndefined();
  });

  it("publishes the bounds it enforces", () => {
    expect(EXPIRY_ALERT_LIMITS.leadDays).toEqual({ min: 1, max: 365 });
  });
});

describe("updateExpirySettings — merge and claim safety", () => {
  it("keeps unspecified fields at their current values", async () => {
    queueUpdate(
      [settingsRow({ enabled: false, leadDays: 30 })],
      settingsRow({ enabled: false, leadDays: 90 }),
    );
    const saved = await updateExpirySettings(ORG, { leadDays: 90 });
    expect(saved.enabled).toBe(false);
    expect(saved.leadDays).toBe(90);
    // The merge is what the write carries: (organization_id, enabled,
    // lead_days) in the values tuple, then the conflict SET repeats both.
    expect(upsert()?.params.slice(0, 5)).toEqual([ORG, false, 90, false, 90]);
  });

  it("never writes lastNotifiedAt — that column is the poller's claim", async () => {
    queueUpdate([], settingsRow({ enabled: false, leadDays: 30 }));
    await updateExpirySettings(ORG, { enabled: false, leadDays: 30 });
    const insert = upsert()!;
    // The values tuple leaves last_notified_at (and the timestamps) to their
    // column defaults, and the conflict SET never names it.
    expect(insert.sql).toContain("values ($1, $2, $3, default, default, default)");
    const setClause = insert.sql.slice(
      insert.sql.indexOf("do update set"),
      insert.sql.indexOf(" returning "),
    );
    expect(setClause).not.toContain('"last_notified_at"');
  });

  it("defaults match the shipped contract", () => {
    expect(defaultExpirySettings(ORG)).toEqual({
      organizationId: ORG,
      enabled: true,
      leadDays: 60,
      lastNotifiedAt: null,
    });
  });
});

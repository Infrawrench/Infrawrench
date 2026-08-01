import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The settings module is the API surface of the expiry radar's tunables. What
 * matters here is the server-side bounds (a zero lead would silence the radar
 * through the API, a huge one would page about everything) and the invariant
 * that a settings save can never touch `lastNotifiedAt` — that column is the
 * poller's cooldown claim, and writing it from the form would re-open or
 * close a quiet period mid-window.
 */

vi.mock("../db/schema", () => ({
  orgExpirySettings: {
    __t: "orgExpirySettings",
    organizationId: "organizationId",
    enabled: "enabled",
    leadDays: "leadDays",
    lastNotifiedAt: "lastNotifiedAt",
  },
}));

/** Rows the settings select resolves to. */
let settingsRows: unknown[] = [];
/** `values(...)` argument of the most recent upsert. */
let lastValues: Record<string, unknown> | undefined;
/** `set` of the most recent `onConflictDoUpdate`. */
let lastConflictSet: Record<string, unknown> | undefined;

vi.mock("../db/client", () => {
  const selectChain = () => {
    const self: Record<string, unknown> = {};
    for (const m of ["where"]) self[m] = () => self;
    self["limit"] = () => Promise.resolve(settingsRows);
    return self;
  };
  const insertChain = () => {
    const self: Record<string, unknown> = {};
    self["values"] = (v: Record<string, unknown>) => {
      lastValues = v;
      return self;
    };
    self["onConflictDoUpdate"] = (arg: { set: Record<string, unknown> }) => {
      lastConflictSet = arg.set;
      return self;
    };
    self["returning"] = () =>
      Promise.resolve([
        {
          organizationId: lastValues?.["organizationId"],
          enabled: lastValues?.["enabled"],
          leadDays: lastValues?.["leadDays"],
          lastNotifiedAt: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ]);
    return self;
  };
  return {
    db: {
      select: () => ({ from: () => selectChain() }),
      insert: () => insertChain(),
    },
  };
});

vi.mock("drizzle-orm", () => ({
  eq: (a: unknown, b: unknown) => ({ eq: [a, b] }),
}));

import {
  EXPIRY_ALERT_LIMITS,
  defaultExpirySettings,
  getExpirySettings,
  updateExpirySettings,
} from "../expiry/settings";

const ORG = "org1";

beforeEach(() => {
  settingsRows = [];
  lastValues = undefined;
  lastConflictSet = undefined;
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
    settingsRows = [
      {
        organizationId: ORG,
        enabled: false,
        leadDays: 14,
        lastNotifiedAt: notified,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ];
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
    expect((await updateExpirySettings(ORG, { leadDays: 1 })).leadDays).toBe(1);
    expect((await updateExpirySettings(ORG, { leadDays: 365 })).leadDays).toBe(365);
  });

  it("rejects a lead of zero — it would silence the radar", async () => {
    await expect(updateExpirySettings(ORG, { leadDays: 0 })).rejects.toThrow(/between 1 and 365/);
  });

  it("rejects a lead past a year", async () => {
    await expect(updateExpirySettings(ORG, { leadDays: 366 })).rejects.toThrow(/between 1 and 365/);
  });

  it("rejects fractional days", async () => {
    await expect(updateExpirySettings(ORG, { leadDays: 30.5 })).rejects.toThrow(/whole number/);
  });

  it("publishes the bounds it enforces", () => {
    expect(EXPIRY_ALERT_LIMITS.leadDays).toEqual({ min: 1, max: 365 });
  });
});

describe("updateExpirySettings — merge and claim safety", () => {
  it("keeps unspecified fields at their current values", async () => {
    settingsRows = [
      {
        organizationId: ORG,
        enabled: false,
        leadDays: 30,
        lastNotifiedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ];
    const saved = await updateExpirySettings(ORG, { leadDays: 90 });
    expect(saved.enabled).toBe(false);
    expect(saved.leadDays).toBe(90);
  });

  it("never writes lastNotifiedAt — that column is the poller's claim", async () => {
    await updateExpirySettings(ORG, { enabled: false, leadDays: 30 });
    expect(lastValues).not.toHaveProperty("lastNotifiedAt");
    expect(lastConflictSet).not.toHaveProperty("lastNotifiedAt");
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

import { describe, expect, it } from "vitest";
import { normalizeSeatRecords } from "../seats.js";
import { resolveSeatRemediationCommands } from "../remediation.js";

const base = {
  memberId: "u1",
  name: "Ada",
  email: "Ada@Example.com ",
  product: "Cursor",
  category: "ai-coding",
  seatType: "Standard",
  price: { monthly: 40, currency: "usd", source: "list-price" },
  activity: { basis: "last-activity", lastActiveAt: "2026-09-01T00:00:00Z", source: "Usage" },
  assignedAt: "2026-01-01",
  removable: true,
};

describe("normalizeSeatRecords", () => {
  it("lower-cases emails and upper-cases currencies", () => {
    const [seat] = normalizeSeatRecords([base]);
    expect(seat?.email).toBe("ada@example.com");
    expect(seat?.price?.currency).toBe("USD");
  });

  it("drops rows without identity and duplicate identities", () => {
    const out = normalizeSeatRecords([
      base,
      { ...base },
      { ...base, memberId: "" },
      { ...base, memberId: "u2", seatType: undefined },
      null,
      "x",
    ]);
    expect(out.map((s) => s.memberId)).toEqual(["u1"]);
  });

  it("keeps two seats for one member when the seat keys differ", () => {
    const out = normalizeSeatRecords([
      { ...base, seatKey: "a" },
      { ...base, seatKey: "b" },
    ]);
    expect(out).toHaveLength(2);
  });

  it("turns an unknown basis into none and never keeps a date on none", () => {
    const [a, b] = normalizeSeatRecords([
      { ...base, activity: { basis: "telepathy", lastActiveAt: "2020-01-01" } },
      { ...base, memberId: "u2", activity: { basis: "none", lastActiveAt: "2020-01-01" } },
    ]);
    expect(a?.activity).toEqual({ basis: "none", lastActiveAt: null, source: "" });
    expect(b?.activity.lastActiveAt).toBeNull();
  });

  it("nulls an unparseable date instead of guessing", () => {
    const [seat] = normalizeSeatRecords([
      { ...base, activity: { basis: "last-login", lastActiveAt: "yesterday-ish" } },
    ]);
    expect(seat?.activity.lastActiveAt).toBeNull();
    expect(seat?.activity.basis).toBe("last-login");
  });

  it("drops a negative or non-numeric price rather than storing it", () => {
    const [a, b] = normalizeSeatRecords([
      { ...base, price: { monthly: -1, currency: "USD", source: "list-price" } },
      { ...base, memberId: "u2", price: { monthly: 10, currency: "USD", source: "guess" } },
    ]);
    expect(a?.price).toBeNull();
    expect(b?.price).toBeNull();
  });

  it("keeps windowDays only for usage-window evidence and unknown categories become other", () => {
    const [seat] = normalizeSeatRecords([
      {
        ...base,
        category: "spaceships",
        activity: { basis: "usage-window", lastActiveAt: null, windowDays: 30.7, source: "x" },
      },
    ]);
    expect(seat?.activity.windowDays).toBe(30);
    expect(seat?.category).toBe("other");
  });
});

describe("resolveSeatRemediationCommands", () => {
  const finding = {
    reason: "inactive" as const,
    seat: {
      memberId: "u1",
      seatKey: "",
      email: null,
      login: null,
      name: null,
      seatType: "Standard",
      targetSeatType: null,
      context: {},
    },
  };

  it("returns nothing when the plugin has no generator or throws", () => {
    expect(resolveSeatRemediationCommands(undefined, finding).commands).toEqual([]);
    expect(
      resolveSeatRemediationCommands(
        {
          seatRemediationCommands: () => {
            throw new Error("bug");
          },
        },
        finding,
      ).commands,
    ).toEqual([]);
  });

  it("validates entries and collects placeholders", () => {
    const out = resolveSeatRemediationCommands(
      {
        seatRemediationCommands: () => [
          {
            tool: "curl",
            command: "curl x",
            description: "d",
            destructive: false,
            placeholders: [{ name: "TOKEN", description: "t" }],
          },
          { tool: "", command: "nope", description: "" } as never,
        ],
      },
      finding,
    );
    expect(out.commands).toHaveLength(1);
    expect(out.placeholders.map((p) => p.name)).toEqual(["TOKEN"]);
  });
});

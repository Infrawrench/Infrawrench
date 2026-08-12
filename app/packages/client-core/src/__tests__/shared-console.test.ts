import { describe, expect, it } from "vitest";

import {
  currentDriver,
  formatInviteExpiry,
  letterboxScale,
  mintRoutingKey,
  type SharedConsoleParticipant,
} from "../shared-console";

function participant(overrides: Partial<SharedConsoleParticipant> = {}): SharedConsoleParticipant {
  return {
    id: "p-1",
    userId: "u-1",
    userName: "Priya",
    role: "observer",
    status: "joined",
    driverRequestedAt: null,
    joinedAt: "2026-08-11T12:00:00.000Z",
    ...overrides,
  };
}

describe("letterboxScale", () => {
  it("scales down to fit the smaller dimension", () => {
    expect(letterboxScale({ width: 1000, height: 500 }, { width: 500, height: 500 })).toBe(0.5);
    expect(letterboxScale({ width: 500, height: 1000 }, { width: 500, height: 500 })).toBe(0.5);
  });

  it("never scales up — a small pty sits centred rather than going soft", () => {
    expect(letterboxScale({ width: 100, height: 100 }, { width: 1000, height: 1000 })).toBe(1);
  });

  it("returns 1 rather than NaN or Infinity when something is not laid out yet", () => {
    expect(letterboxScale({ width: 0, height: 0 }, { width: 500, height: 500 })).toBe(1);
    expect(letterboxScale({ width: 500, height: 500 }, { width: 0, height: 0 })).toBe(1);
  });
});

describe("formatInviteExpiry", () => {
  const now = Date.parse("2026-08-11T12:00:00Z");

  it("says there is no invite when there is none", () => {
    expect(formatInviteExpiry(null, now)).toBe("no open invite");
    expect(formatInviteExpiry("not a date", now)).toBe("no open invite");
  });

  it("says expired rather than showing a negative countdown", () => {
    expect(formatInviteExpiry("2026-08-11T11:59:00Z", now)).toBe("expired");
    expect(formatInviteExpiry("2026-08-11T12:00:00Z", now)).toBe("expired");
  });

  it("counts seconds while the link is nearly gone, and minutes otherwise", () => {
    expect(formatInviteExpiry("2026-08-11T12:00:45Z", now)).toBe("expires in 45s");
    expect(formatInviteExpiry("2026-08-11T12:14:00Z", now)).toBe("expires in 14 min");
  });
});

describe("currentDriver", () => {
  it("finds the joined driver", () => {
    const driver = participant({ id: "p-2", role: "driver" });
    expect(currentDriver([participant(), driver])).toBe(driver);
  });

  it("ignores a driver who has left, so a stale row does not read as live", () => {
    expect(currentDriver([participant({ role: "driver", status: "left" })])).toBeNull();
  });

  it("is null when nobody holds the keyboard", () => {
    expect(currentDriver([participant()])).toBeNull();
  });
});

describe("mintRoutingKey", () => {
  it("is 128 bits of hex and differs each time", () => {
    const a = mintRoutingKey();
    const b = mintRoutingKey();
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(a).not.toBe(b);
  });
});

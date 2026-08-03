import { describe, it, expect, vi } from "vitest";

vi.mock("../../db/client", () => ({ db: {} }));
vi.mock("@infrawrench/server-core/permissions/catalog", () => ({ hasPermission: vi.fn() }));
vi.mock("@infrawrench/server-core/status/match", () => ({ getOrgStatusIncidents: vi.fn() }));
vi.mock("@infrawrench/server-core/drift/settings", () => ({ getDriftAlertSettings: vi.fn() }));
vi.mock("@infrawrench/server-core/expiry/settings", () => ({ getExpirySettings: vi.fn() }));

const { parseMomentTimestamp } = await import("../moment");

describe("parseMomentTimestamp", () => {
  // The process TZ is whatever the runner has; the point of the parser is
  // that the result must not depend on it.
  it("pins an offset-less ISO date-time to UTC", () => {
    const parsed = parseMomentTimestamp("2026-08-03T03:14:00");
    expect(parsed?.toISOString()).toBe("2026-08-03T03:14:00.000Z");
  });

  it("pins an offset-less timestamp with fractional seconds to UTC", () => {
    const parsed = parseMomentTimestamp("2026-08-03T03:14:00.500");
    expect(parsed?.toISOString()).toBe("2026-08-03T03:14:00.500Z");
  });

  it("keeps an explicit Z offset", () => {
    const parsed = parseMomentTimestamp("2026-08-03T03:14:00Z");
    expect(parsed?.toISOString()).toBe("2026-08-03T03:14:00.000Z");
  });

  it("keeps an explicit numeric offset", () => {
    const parsed = parseMomentTimestamp("2026-08-03T03:14:00+02:00");
    expect(parsed?.toISOString()).toBe("2026-08-03T01:14:00.000Z");
  });

  it("accepts hour:minute precision without an offset", () => {
    const parsed = parseMomentTimestamp("2026-08-03T03:14");
    expect(parsed?.toISOString()).toBe("2026-08-03T03:14:00.000Z");
  });

  it("returns null for garbage", () => {
    expect(parseMomentTimestamp("not-a-date")).toBeNull();
    expect(parseMomentTimestamp("")).toBeNull();
  });
});

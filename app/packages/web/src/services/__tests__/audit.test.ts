import { describe, it, expect, vi, beforeEach } from "vitest";

const mockValues = vi.fn().mockResolvedValue(undefined);
const mockInsert = vi.fn(() => ({ values: mockValues }));

vi.mock("@/db/client", () => {
  return {
    db: {
      get insert() {
        return mockInsert;
      },
    },
  };
});

vi.mock("@/db/schema", () => ({
  auditLogs: Symbol("auditLogs"),
}));

vi.mock("uuid", () => ({
  v4: () => "test-uuid",
}));

import { logAudit } from "../audit";

describe("logAudit", () => {
  beforeEach(() => {
    mockInsert.mockClear();
    mockValues.mockClear();
    mockValues.mockResolvedValue(undefined);
  });

  it("inserts an audit log into the database", async () => {
    const recorded = await logAudit({
      organizationId: "org1",
      userId: "user1",
      action: "create",
      entityType: "resource",
      entityId: "r1",
    });

    expect(recorded).toBe(true);
    expect(mockInsert).toHaveBeenCalled();
    expect(mockValues).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "test-uuid",
        organizationId: "org1",
        userId: "user1",
        action: "create",
        entityType: "resource",
        entityId: "r1",
      }),
    );
  });

  it("does not throw when db insert fails, and reports that it didn't land", async () => {
    mockValues.mockRejectedValue(new Error("db down"));
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    // Never a throw: an audit failure must not make a mutation that already
    // happened read as failed. The boolean is how the handful of callers that
    // record irreversible external side effects can surface the gap instead.
    await expect(
      logAudit({
        organizationId: "org1",
        action: "delete",
        entityType: "resource",
        entityId: "r1",
      }),
    ).resolves.toBe(false);

    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });
});

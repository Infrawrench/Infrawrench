import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHash } from "node:crypto";

const mockInsert = vi.fn();
const mockDelete = vi.fn();

vi.mock("@/db/client", () => ({
  db: {
    insert: (...args: unknown[]) => mockInsert(...args),
    delete: (...args: unknown[]) => mockDelete(...args),
  },
}));

const { createWsToken, validateWsToken } = await import("../ws-tokens");

describe("ws-tokens", () => {
  const values = vi.fn().mockResolvedValue(undefined);
  const returning = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockInsert.mockReturnValue({ values });
    // createWsToken's cleanup uses delete().where().catch(); validateWsToken
    // uses delete().where().returning().
    mockDelete.mockReturnValue({
      where: vi.fn().mockReturnValue({ returning, catch: vi.fn() }),
    });
  });

  it("stores the token hashed with a ~30s expiry and returns the raw token", async () => {
    const before = Date.now();
    const token = await createWsToken("user1", "org1");
    expect(token).toMatch(/^[0-9a-f]{64}$/);

    const row = values.mock.calls[0]![0] as {
      hashedToken: string;
      userId: string;
      organizationId: string;
      expiresAt: Date;
    };
    expect(row.hashedToken).toBe(createHash("sha256").update(token).digest("hex"));
    expect(row.hashedToken).not.toBe(token);
    expect(row.userId).toBe("user1");
    expect(row.organizationId).toBe("org1");
    expect(row.expiresAt.getTime()).toBeGreaterThanOrEqual(before + 29_000);
    expect(row.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + 31_000);
  });

  it("returns the deleted row's identity on validation", async () => {
    returning.mockResolvedValue([{ organizationId: "org1", userId: "user1" }]);
    await expect(validateWsToken("raw")).resolves.toEqual({
      organizationId: "org1",
      userId: "user1",
    });
  });

  it("returns null when no live row matches (unknown, expired, or already used)", async () => {
    returning.mockResolvedValue([]);
    await expect(validateWsToken("nonexistent")).resolves.toBeNull();
  });
});

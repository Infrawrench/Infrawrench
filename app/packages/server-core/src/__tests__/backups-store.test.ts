import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The per-org policy limit has to be enforced atomically with the insert.
 *
 * Counting on `db` and then inserting on `db` is two statements in two
 * transactions: two concurrent creates with one slot left both observe a count
 * below the limit and both take it. Under READ COMMITTED even folding it into
 * a single `INSERT … SELECT … WHERE count < limit` would not close the window,
 * because each transaction counts against its own snapshot — so the check runs
 * inside a transaction behind an org-scoped advisory lock, the stance
 * `probes/store.ts` and `schedules/store.ts` already take.
 *
 * These assertions are structural rather than concurrent: a genuine race needs
 * two live Postgres sessions, which this suite has no database for. What can
 * be pinned down without one is that the count and the insert are issued on
 * the transaction handle and are preceded by the lock — which is exactly what
 * was missing, and what the fix restores.
 */

interface TxCall {
  kind: "execute" | "select" | "insert";
  sqlText?: string;
}

const calls: TxCall[] = [];
const outerSelect = vi.fn();
const outerInsert = vi.fn();

/**
 * Flatten a drizzle `sql` template into something matchable: the literal
 * fragments arrive as `StringChunk`s holding an array of strings, while an
 * interpolated value arrives as a boxed primitive that renders itself.
 */
function renderSql(value: unknown): string {
  const chunks = (value as { queryChunks?: unknown[] })?.queryChunks ?? [];
  return chunks
    .map((chunk) => {
      const c = chunk as { value?: unknown };
      if (Array.isArray(c?.value)) return c.value.join("");
      return String(chunk);
    })
    .join(" ");
}

/** Rows the mocked count query reports. Set per test. */
let existingPolicyCount = 0;

const tx = {
  execute: vi.fn(async (statement: unknown) => {
    calls.push({ kind: "execute", sqlText: renderSql(statement) });
  }),
  select: vi.fn(() => {
    calls.push({ kind: "select" });
    return {
      from: () => ({
        where: async () => [{ n: existingPolicyCount }],
      }),
    };
  }),
  insert: vi.fn(() => {
    calls.push({ kind: "insert" });
    return {
      values: (row: Record<string, unknown>) => ({
        returning: async () => [
          {
            ...row,
            createdAt: new Date("2026-08-01T00:00:00.000Z"),
            updatedAt: new Date("2026-08-01T00:00:00.000Z"),
          },
        ],
      }),
    };
  }),
};

vi.mock("../db/client", () => ({
  db: {
    transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
    select: (...a: unknown[]) => outerSelect(...a),
    insert: (...a: unknown[]) => outerInsert(...a),
  },
}));

const { createBackupPolicy, BackupPolicyInputError } = await import("../backups/store");
const { BACKUP_POLICY_LIMITS } = await import("@infrawrench/client-core");

describe("createBackupPolicy limit enforcement", () => {
  beforeEach(() => {
    calls.length = 0;
    existingPolicyCount = 0;
    vi.clearAllMocks();
  });

  it("takes an org-scoped advisory lock before counting", async () => {
    await createBackupPolicy("org-1", { name: "Daily", maxRpoHours: 24 }, "user-1");

    const lock = calls[0];
    expect(lock?.kind).toBe("execute");
    expect(lock?.sqlText).toContain("pg_advisory_xact_lock");
    // Scoped to the org, so two different orgs never serialize against each
    // other — a global lock would make policy creation a system-wide
    // chokepoint — and namespaced by table so it cannot collide with the
    // probe or schedule locks taken on the same org id.
    expect(lock?.sqlText).toContain("backup_policies:org-1");
  });

  it("counts and inserts on the transaction, never on the outer connection", async () => {
    await createBackupPolicy("org-1", { name: "Daily", maxRpoHours: 24 }, "user-1");

    expect(calls.map((c) => c.kind)).toEqual(["execute", "select", "insert"]);
    // The regression: the count used to run on `db` outside any transaction,
    // so the lock could not cover it and the check bought nothing.
    expect(outerSelect).not.toHaveBeenCalled();
    expect(outerInsert).not.toHaveBeenCalled();
  });

  it("refuses the create when the org is already at the limit, and inserts nothing", async () => {
    existingPolicyCount = BACKUP_POLICY_LIMITS.maxPolicies;

    await expect(
      createBackupPolicy("org-1", { name: "One too many", maxRpoHours: 24 }, "user-1"),
    ).rejects.toBeInstanceOf(BackupPolicyInputError);
    expect(calls.map((c) => c.kind)).toEqual(["execute", "select"]);
    expect(tx.insert).not.toHaveBeenCalled();
  });

  it("rejects invalid input before opening a transaction at all", async () => {
    await expect(createBackupPolicy("org-1", { name: "Empty" }, "user-1")).rejects.toThrow(
      /must set an RPO/,
    );
    expect(calls).toEqual([]);
  });
});

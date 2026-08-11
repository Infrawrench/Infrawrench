import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The revert claim, as a race.
 *
 * Reverting has to be mutually exclusive per event — two people pressing Revert
 * at the same moment must produce one provider write, not two — and it has to
 * be *recoverable*, because the thing holding the exclusion is a row that
 * outlives the request that wrote it. A process that stops between the claim
 * committing and the provider write returning would otherwise leave the event
 * marked forever, blocking every retry and labelling as reverted something that
 * never was.
 *
 * So this models just enough Postgres to run the claim honestly: the
 * conditional `UPDATE` re-checks its `WHERE` against the row's latest committed
 * state, and a predicate the fake doesn't understand throws rather than being
 * waved through. That way a claim can only pass these tests for the reason a
 * real deployment would.
 *
 * Same approach as `server-core/src/__tests__/network-flow-claim.test.ts`,
 * scaled down: this claim is one row, not a batch, so there is no SELECT half
 * and no snapshot to freeze.
 */

/** A row of `resource_changes`, reduced to the three columns the claim reads. */
interface Row {
  id: string;
  organization_id: string;
  /** Epoch ms, or null. Set only when a provider write actually landed. */
  reverted_at: number | null;
  /** Epoch ms, or null. The lease an in-flight revert holds. */
  revert_claimed_at: number | null;
  /** Identity of the lease holder. What makes the lease an exclusion, not a timer. */
  revert_claim_owner: string | null;
  reverted_by_user_id: string | null;
}

/**
 * `and`/`eq`/`or`/`isNull`/`lt` become inspectable descriptors so the fake
 * below can evaluate the claim's real predicate. Everything else in drizzle
 * stays real — the schema module this service imports is built out of it.
 */
vi.mock("drizzle-orm", async (importOriginal) => ({
  ...(await importOriginal<typeof import("drizzle-orm")>()),
  eq: (column: { name: string }, value: unknown) => ({
    op: "eq" as const,
    column: column.name,
    value,
  }),
  isNull: (column: { name: string }) => ({ op: "isNull" as const, column: column.name }),
  lt: (column: { name: string }, value: unknown) => ({
    op: "lt" as const,
    column: column.name,
    value,
  }),
  and: (...conditions: unknown[]) => ({ op: "and" as const, conditions }),
  or: (...conditions: unknown[]) => ({ op: "or" as const, conditions }),
}));

/**
 * Evaluate one of the claim's predicate atoms against a row.
 *
 * Deliberately narrow: it understands the five operators this claim is allowed
 * to use and throws on anything else, so a predicate that doesn't actually test
 * lease staleness cannot pass by being waved through as "there is a WHERE, so
 * it must be exclusive".
 */
function matches(cond: unknown, row: Row): boolean {
  if (cond === undefined || cond === null) return true;
  const c = cond as {
    op: string;
    column?: string;
    value?: unknown;
    conditions?: unknown[];
  };
  const cell = (name: string): unknown => (row as unknown as Record<string, unknown>)[name];
  switch (c.op) {
    case "and":
      return (c.conditions ?? []).every((inner) => matches(inner, row));
    case "or":
      return (c.conditions ?? []).some((inner) => matches(inner, row));
    case "eq":
      return cell(c.column!) === c.value;
    case "isNull":
      return cell(c.column!) === null;
    case "lt": {
      const actual = cell(c.column!);
      const bound = c.value instanceof Date ? c.value.getTime() : (c.value as number);
      return actual !== null && (actual as number) < bound;
    }
    default:
      throw new Error(`unsupported claim predicate operator: ${c.op}`);
  }
}

/** The single row every test in this file races against. */
let row: Row;

const update = vi.fn((_table: unknown) => ({
  set: (values: Record<string, unknown>) => ({
    where: (cond: unknown) => {
      const apply = () => {
        if (!matches(cond, row)) return [];
        for (const [key, value] of Object.entries(values)) {
          const column = COLUMN_OF[key];
          if (!column) throw new Error(`unmapped column in claim SET: ${key}`);
          (row as unknown as Record<string, unknown>)[column] =
            value instanceof Date ? value.getTime() : value;
        }
        return [{ id: row.id }];
      };
      // `.returning()` and a bare await are both used by the service.
      const thenable = {
        returning: () => Promise.resolve(apply()),
        then: (fn: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
          Promise.resolve(apply()).then(fn, rej),
      };
      return thenable;
    },
  }),
}));

/** Drizzle field name → column name, for the fake's writes. */
const COLUMN_OF: Record<string, string> = {
  revertClaimedAt: "revert_claimed_at",
  revertClaimOwner: "revert_claim_owner",
  revertedAt: "reverted_at",
  revertedByUserId: "reverted_by_user_id",
};

const dbMock = { db: { update: (t: unknown) => update(t), select: vi.fn() } };
vi.mock("@/db/client", () => dbMock);
vi.mock("@infrawrench/server-core/db/client", () => dbMock);
vi.mock("@/services/plugin-clients", () => ({ getClientForAccount: vi.fn() }));

const { claimRevert, completeRevert, releaseRevert, REVERT_CLAIM_LEASE_MS } =
  await import("@/services/change-revert");

const T0 = new Date("2026-08-11T12:00:00.000Z");
const at = (ms: number) => new Date(T0.getTime() + ms);

beforeEach(() => {
  row = {
    id: "chg-1",
    organization_id: "org-1",
    reverted_at: null,
    revert_claimed_at: null,
    revert_claim_owner: null,
    reverted_by_user_id: null,
  };
  update.mockClear();
});

describe("claimRevert — exclusivity", () => {
  it("lets exactly one of two concurrent reverts through", async () => {
    const first = await claimRevert("org-1", "chg-1", "user-a", T0);
    const second = await claimRevert("org-1", "chg-1", "user-b", at(50));
    expect(first).toEqual(expect.any(String));
    expect(second).toBeNull();
  });

  it("mints a distinct owner token per claim", async () => {
    const first = await claimRevert("org-1", "chg-1", "user-a", T0);
    await releaseRevert("org-1", "chg-1", first!);
    const second = await claimRevert("org-1", "chg-1", "user-b", at(50));
    expect(second).not.toBe(first);
    expect(row.revert_claim_owner).toBe(second);
  });

  it("refuses an event that already completed, however long ago", async () => {
    row.reverted_at = T0.getTime();
    expect(await claimRevert("org-1", "chg-1", "user-b", at(365 * 24 * 3_600_000))).toBeNull();
  });

  it("is scoped to the organization", async () => {
    expect(await claimRevert("org-2", "chg-1", "user-a", T0)).toBeNull();
    expect(row.revert_claimed_at).toBeNull();
  });
});

describe("claimRevert — abandoned claims recover", () => {
  /**
   * The regression this file exists for. A process that stops after the claim
   * commits and before the provider write returns leaves a claim nobody will
   * ever release; without a lease the event is permanently unrevertible.
   */
  it("reclaims a lease left behind by a process that never finished", async () => {
    expect(await claimRevert("org-1", "chg-1", "user-a", T0)).toEqual(expect.any(String));
    // ...that request's process dies here: no completeRevert, no releaseRevert.
    expect(row.reverted_at).toBeNull();

    const afterLease = at(REVERT_CLAIM_LEASE_MS + 1_000);
    expect(await claimRevert("org-1", "chg-1", "user-b", afterLease)).toEqual(expect.any(String));
    expect(row.revert_claimed_at).toBe(afterLease.getTime());
    expect(row.reverted_by_user_id).toBe("user-b");
  });

  it("does not steal a claim that is still inside its lease", async () => {
    expect(await claimRevert("org-1", "chg-1", "user-a", T0)).toEqual(expect.any(String));
    expect(
      await claimRevert("org-1", "chg-1", "user-b", at(REVERT_CLAIM_LEASE_MS - 1_000)),
    ).toBeNull();
    expect(row.reverted_by_user_id).toBe("user-a");
  });

  it("recovers when the best-effort release itself failed", async () => {
    const owner = await claimRevert("org-1", "chg-1", "user-a", T0);
    // A release that throws is swallowed by design; the row keeps its claim.
    update.mockImplementationOnce(() => {
      throw new Error("connection reset");
    });
    await expect(releaseRevert("org-1", "chg-1", owner!)).resolves.toBeUndefined();
    expect(row.revert_claimed_at).toBe(T0.getTime());

    // The lease is the backstop that makes that survivable.
    expect(await claimRevert("org-1", "chg-1", "user-b", at(REVERT_CLAIM_LEASE_MS + 1))).toEqual(
      expect.any(String),
    );
  });
});

/**
 * The regression this round of review found: a lease with no owner is only a
 * timer. Every one of these describes the same shape — an attempt whose
 * provider call outlived the five-minute lease, finishing after a replacement
 * has already taken the event over.
 */
describe("a superseded attempt can touch nothing", () => {
  /** Claim as A, let the lease lapse, claim as B. Returns both tokens. */
  async function supersede() {
    const a = await claimRevert("org-1", "chg-1", "user-a", T0);
    const b = await claimRevert("org-1", "chg-1", "user-b", at(REVERT_CLAIM_LEASE_MS + 1_000));
    expect(a).toEqual(expect.any(String));
    expect(b).toEqual(expect.any(String));
    expect(b).not.toBe(a);
    return { a: a!, b: b! };
  }

  it("does not release the replacement's claim on its failure path", async () => {
    const { a, b } = await supersede();

    // A's provider call finally fails and it runs its rollback.
    await releaseRevert("org-1", "chg-1", a);

    // B still holds the event. Without the owner fence this cleared B's claim,
    // and a third attempt could then claim it while B was mid-write.
    expect(row.revert_claim_owner).toBe(b);
    expect(row.revert_claimed_at).toBe(at(REVERT_CLAIM_LEASE_MS + 1_000).getTime());
    expect(await claimRevert("org-1", "chg-1", "user-c", at(REVERT_CLAIM_LEASE_MS + 2_000))).toBe(
      null,
    );
  });

  it("does not complete on the replacement's behalf", async () => {
    const { a, b } = await supersede();

    // A's provider write landed, but the event is not A's to close any more.
    expect(await completeRevert("org-1", "chg-1", a, at(REVERT_CLAIM_LEASE_MS + 5_000))).toBe(
      false,
    );
    expect(row.reverted_at).toBeNull();
    expect(row.revert_claim_owner).toBe(b);
  });

  it("leaves the replacement able to finish normally", async () => {
    const { a, b } = await supersede();
    await releaseRevert("org-1", "chg-1", a);
    expect(await completeRevert("org-1", "chg-1", b, at(REVERT_CLAIM_LEASE_MS + 9_000))).toBe(true);
    expect(row.reverted_at).toBe(at(REVERT_CLAIM_LEASE_MS + 9_000).getTime());
    expect(row.revert_claim_owner).toBeNull();
  });

  it("cannot re-open an event the replacement already completed", async () => {
    const { a, b } = await supersede();
    await completeRevert("org-1", "chg-1", b, at(REVERT_CLAIM_LEASE_MS + 3_000));

    // A arrives late on either path; neither may disturb the recorded outcome.
    await releaseRevert("org-1", "chg-1", a);
    expect(await completeRevert("org-1", "chg-1", a, at(REVERT_CLAIM_LEASE_MS + 4_000))).toBe(
      false,
    );
    expect(row.reverted_at).toBe(at(REVERT_CLAIM_LEASE_MS + 3_000).getTime());
  });
});

describe("claim vs completion are different columns", () => {
  it("does not mark the event reverted merely by claiming it", async () => {
    await claimRevert("org-1", "chg-1", "user-a", T0);
    // `reverted_at` is what the feed renders as "reverted" and what a later
    // claim refuses on. A claim must not set it: the write hasn't happened yet.
    expect(row.reverted_at).toBeNull();
    expect(row.revert_claimed_at).toBe(T0.getTime());
  });

  it("marks it reverted only on completion, and drops the lease", async () => {
    const owner = await claimRevert("org-1", "chg-1", "user-a", T0);
    expect(await completeRevert("org-1", "chg-1", owner!, at(1_200))).toBe(true);
    expect(row.reverted_at).toBe(at(1_200).getTime());
    expect(row.revert_claimed_at).toBeNull();
    expect(row.revert_claim_owner).toBeNull();

    // And a completed event is never claimable again.
    expect(
      await claimRevert("org-1", "chg-1", "user-b", at(10 * REVERT_CLAIM_LEASE_MS)),
    ).toBeNull();
  });

  it("releases the claim without ever un-reverting a completed event", async () => {
    const owner = await claimRevert("org-1", "chg-1", "user-a", T0);
    await completeRevert("org-1", "chg-1", owner!, at(1_200));
    await releaseRevert("org-1", "chg-1", owner!);
    expect(row.reverted_at).toBe(at(1_200).getTime());
  });

  it("frees the event immediately when the provider call failed", async () => {
    const owner = await claimRevert("org-1", "chg-1", "user-a", T0);
    await releaseRevert("org-1", "chg-1", owner!);
    expect(row.revert_claimed_at).toBeNull();
    expect(row.revert_claim_owner).toBeNull();
    expect(row.reverted_at).toBeNull();
    // Retryable at once, not at lease expiry.
    expect(await claimRevert("org-1", "chg-1", "user-a", at(10))).toEqual(expect.any(String));
  });
});

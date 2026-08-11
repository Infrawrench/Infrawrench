import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * "One note per pinned subject" has to hold when two requests pin the same
 * subject at once, and the interesting case is the **loser**: it must not leave
 * behind the annotation it already created, and it must end up describing the
 * winner's note rather than failing.
 *
 * The db is a drizzle-shaped chain fake (the `agent-setup.test.ts` pattern) with
 * queued results, which is what lets a single-threaded test drive the two
 * outcomes of a compare-and-swap. `conflictTolerantInserts` records whether the
 * link insert went out under `onConflictDoNothing` — without that, the second
 * writer's insert is a raw unique violation, which is the shape of the bug.
 */

// --- drizzle chain fake -----------------------------------------------------

/** Rows the next `insert(...).onConflictDoNothing().returning()` yields. */
const insertReturning: unknown[][] = [];
/** Rows the next `select(...).from(...).where(...).limit()` yields. */
const selectResults: unknown[][] = [];
/** Rows the next `update(...).set(...).where(...).returning()` yields. */
const updateReturning: unknown[][] = [];
/** One entry per insert: did it go out conflict-tolerant? */
const conflictTolerantInserts: boolean[] = [];
/** Values passed to each `.set()`, in order. */
const updateSetCalls: Array<Record<string, unknown>> = [];

vi.mock("@/db/client", () => ({
  db: {
    insert: () => ({
      values: () => {
        const withConflict = {
          onConflictDoNothing: () => {
            conflictTolerantInserts.push(true);
            return { returning: () => Promise.resolve(insertReturning.shift() ?? []) };
          },
          // A bare insert with no conflict clause: recorded so the test can
          // tell the two spellings apart.
          returning: () => {
            conflictTolerantInserts.push(false);
            return Promise.resolve(insertReturning.shift() ?? []);
          },
          then: (resolve: (v: unknown) => unknown) => {
            conflictTolerantInserts.push(false);
            return Promise.resolve(undefined).then(resolve);
          },
        };
        return withConflict;
      },
    }),
    select: () => ({
      from: () => ({
        where: () => ({ limit: () => Promise.resolve(selectResults.shift() ?? []) }),
      }),
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: () => {
          updateSetCalls.push(values);
          const result = Promise.resolve() as Promise<unknown> & {
            returning?: () => Promise<unknown[]>;
          };
          result.returning = () => Promise.resolve(updateReturning.shift() ?? []);
          return result;
        },
      }),
    }),
  },
}));

// --- the impact itself is not what these tests are about --------------------

const impact = {
  status: "measured" as const,
  costBasis: "cash" as const,
  windowDays: 7,
  effectiveWindowDays: 7,
  eventDay: "2026-06-15",
  before: { from: "2026-06-08", to: "2026-06-14" },
  after: { from: "2026-06-16", to: "2026-06-22" },
  series: [
    {
      currency: "USD",
      beforePerDay: 10,
      afterPerDay: 22,
      deltaPerDay: 12,
      deltaPercent: 120,
      beforeTotal: 70,
      afterTotal: 154,
    },
  ],
  confidence: "high" as const,
  reasons: [],
  overlappingChanges: 0,
};

vi.mock("@infrawrench/server-core/cost/change-impact-load", () => ({
  loadChangeCostImpact: vi.fn(async () => ({ changeId: "chg-1", resourceId: "res-1", impact })),
  loadDeploymentCostImpact: vi.fn(async () => null),
  describeChangeSubject: vi.fn(async () => "api-prod updated"),
  describeDeploymentSubject: vi.fn(async () => "acme/web → prod"),
}));

const mockCreate = vi.fn();
const mockUpdate = vi.fn();
const mockDelete = vi.fn();
class FakeCostAnnotationError extends Error {}
vi.mock("../cost-annotations", () => ({
  CostAnnotationError: FakeCostAnnotationError,
  createCostAnnotation: (...args: unknown[]) => mockCreate(...args),
  updateCostAnnotation: (...args: unknown[]) => mockUpdate(...args),
  deleteCostAnnotation: (...args: unknown[]) => mockDelete(...args),
}));

const { writeChangeImpactAnnotation, ChangeImpactAnnotationError } =
  await import("../change-cost-impact-annotations");

const request = { subjectKind: "change" as const, subjectId: "chg-1" };

beforeEach(() => {
  vi.clearAllMocks();
  insertReturning.length = 0;
  selectResults.length = 0;
  updateReturning.length = 0;
  conflictTolerantInserts.length = 0;
  updateSetCalls.length = 0;
  mockCreate.mockImplementation(async () => ({ id: "ann-mine" }));
  mockUpdate.mockImplementation(async (_org: string, id: string) => ({ id }));
  mockDelete.mockResolvedValue(true);
});

describe("writeChangeImpactAnnotation — first pin", () => {
  it("claims the subject before writing anything, and conflict-tolerantly", () => {
    // The claim is what stops two writers both minting a note. A plain insert
    // here is a unique violation waiting to happen, with an orphaned annotation
    // already committed behind it.
    insertReturning.push([{ id: "link-1", costAnnotationId: null }]);
    updateReturning.push([{ id: "link-1" }]);
    return writeChangeImpactAnnotation("org-1", request, "user-1").then((result) => {
      expect(conflictTolerantInserts).toEqual([true]);
      expect(result).toMatchObject({ annotationId: "ann-mine" });
    });
  });

  it("claims with a null annotation id — the note is written after the claim", async () => {
    insertReturning.push([{ id: "link-1", costAnnotationId: null }]);
    updateReturning.push([{ id: "link-1" }]);
    await writeChangeImpactAnnotation("org-1", request, "user-1");
    // The attach is a compare-and-swap, so it goes out as its own conditional
    // update carrying the note id.
    expect(updateSetCalls.at(-1)).toMatchObject({ costAnnotationId: "ann-mine" });
  });
});

describe("writeChangeImpactAnnotation — concurrent first pins", () => {
  it("does not orphan the loser's annotation, and both end on one note", async () => {
    // The loser's path, step by step:
    //  1. its link insert conflicts (the winner claimed first) → no rows;
    //  2. it reads the winner's link, which is still unattached;
    //  3. it writes its own note;
    //  4. its compare-and-swap finds the column already filled → no rows.
    insertReturning.push([]);
    selectResults.push([{ id: "link-1", costAnnotationId: null }]);
    updateReturning.push([]); // the CAS loses
    selectResults.push([{ costAnnotationId: "ann-winner" }]); // re-read the link
    selectResults.push([{ id: "ann-winner", startDate: "2026-06-15" }]);

    const result = await writeChangeImpactAnnotation("org-1", request, "user-1");

    // The regression: before the claim-then-CAS ordering, this call created an
    // annotation and then died on the unique index, leaving `ann-mine` behind
    // as a second, unreachable marker on the same day.
    expect(mockDelete).toHaveBeenCalledWith("org-1", "ann-mine");
    // ...and it converges on the winner's note rather than failing outright.
    expect(result).toMatchObject({ annotationId: "ann-winner" });
    expect(mockUpdate).toHaveBeenCalledWith(
      "org-1",
      "ann-winner",
      expect.objectContaining({ startDate: "2026-06-15" }),
    );
  });

  it("reports a retry rather than a 500 when the winner's note vanishes too", async () => {
    insertReturning.push([]);
    selectResults.push([{ id: "link-1", costAnnotationId: null }]);
    updateReturning.push([]); // the CAS loses
    selectResults.push([{ costAnnotationId: "ann-winner" }]);
    selectResults.push([]); // ...and that note is gone

    await expect(writeChangeImpactAnnotation("org-1", request, "user-1")).rejects.toBeInstanceOf(
      ChangeImpactAnnotationError,
    );
    expect(mockDelete).toHaveBeenCalledWith("org-1", "ann-mine");
  });

  it("retries the claim once when the row vanishes between conflict and read", async () => {
    insertReturning.push([]); // conflict
    selectResults.push([]); // ...but gone by the time we look
    insertReturning.push([{ id: "link-2", costAnnotationId: null }]); // second go
    updateReturning.push([{ id: "link-2" }]);

    const result = await writeChangeImpactAnnotation("org-1", request, "user-1");
    expect(result).toMatchObject({ annotationId: "ann-mine" });
    expect(conflictTolerantInserts).toEqual([true, true]);
  });

  it("gives up with a retry message rather than looping when it never settles", async () => {
    insertReturning.push([], []);
    selectResults.push([], []);
    await expect(writeChangeImpactAnnotation("org-1", request, "user-1")).rejects.toBeInstanceOf(
      ChangeImpactAnnotationError,
    );
    expect(mockCreate).not.toHaveBeenCalled();
  });
});

describe("writeChangeImpactAnnotation — re-pinning", () => {
  it("rewords the existing note instead of minting a second marker", async () => {
    insertReturning.push([]); // the link already exists
    selectResults.push([{ id: "link-1", costAnnotationId: "ann-old" }]);
    selectResults.push([{ id: "ann-old", startDate: "2026-06-15" }]);

    const result = await writeChangeImpactAnnotation("org-1", request, "user-1");

    expect(mockCreate).not.toHaveBeenCalled();
    expect(result).toMatchObject({ annotationId: "ann-old" });
  });

  it("does not move the note's date or scope — only its text", async () => {
    insertReturning.push([]);
    // Somebody widened the note to a span and moved its start deliberately.
    selectResults.push([{ id: "link-1", costAnnotationId: "ann-old" }]);
    selectResults.push([{ id: "ann-old", startDate: "2026-06-01" }]);

    await writeChangeImpactAnnotation("org-1", request, "user-1");

    const [, , input] = mockUpdate.mock.calls[0] as [string, string, { startDate: string }];
    expect(input.startDate).toBe("2026-06-01");
  });

  it("writes a fresh note when the old one was deleted out from under the link", async () => {
    // ON DELETE SET NULL nulls the column; deleting a marker is not a
    // retraction, so the finding is simply re-pinned.
    insertReturning.push([]);
    selectResults.push([{ id: "link-1", costAnnotationId: null }]);
    updateReturning.push([{ id: "link-1" }]);

    const result = await writeChangeImpactAnnotation("org-1", request, "user-1");
    expect(mockCreate).toHaveBeenCalled();
    expect(result).toMatchObject({ annotationId: "ann-mine" });
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

const execute = vi.fn();
vi.mock("../db/client", () => ({ db: { execute: (q: unknown) => execute(q) } }));
vi.mock("../db/schema", () => ({ resourceChanges: {} }));

// Capture the sql tag's inputs so tests can assert on the raw statement text,
// the same way the poller's claim tests do.
vi.mock("drizzle-orm", () => ({
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
    strings: [...strings],
    values,
  }),
}));

import {
  pruneResourceChanges,
  CHANGE_RETENTION_DAYS,
  CHANGE_RETENTION_INTERVAL_MS,
} from "../resource-changes";

interface CapturedQuery {
  strings: string[];
  values: unknown[];
}

/** postgres-js hands back an array carrying the command tag's `count`. */
function rowList(count: number): unknown {
  return Object.assign([] as unknown[], { count });
}

function orgList(...ids: string[]): unknown {
  return ids.map((id) => ({ id }));
}

function queries(): CapturedQuery[] {
  return execute.mock.calls.map((c) => c[0] as CapturedQuery);
}

function text(q: CapturedQuery): string {
  return q.strings.join("?");
}

const NOW = new Date("2026-07-31T12:00:00.000Z");

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("pruneResourceChanges", () => {
  it("deletes per org through the (organization_id, created_at) index, batched and SKIP LOCKED", async () => {
    execute.mockResolvedValueOnce(orgList("org-1")).mockResolvedValueOnce(rowList(0));

    await pruneResourceChanges(NOW);

    const [orgQuery, deleteQuery] = queries();
    expect(text(orgQuery!)).toContain("SELECT id FROM organizations");

    const del = text(deleteQuery!);
    expect(del).toContain("DELETE FROM resource_changes");
    expect(del).toContain("WHERE ctid IN");
    expect(del).toContain("organization_id =");
    expect(del).toContain("created_at <");
    expect(del).toContain("::timestamp");
    expect(del).toContain("FOR UPDATE SKIP LOCKED");
    // org id, cutoff literal, batch size
    expect(deleteQuery!.values[0]).toBe("org-1");
    expect(deleteQuery!.values[2]).toBe(2_000);
  });

  it("cuts off exactly CHANGE_RETENTION_DAYS back, as a UTC timestamp literal", async () => {
    execute.mockResolvedValueOnce(orgList("org-1")).mockResolvedValueOnce(rowList(0));

    const result = await pruneResourceChanges(NOW);

    expect(result.cutoff.getTime()).toBe(
      NOW.getTime() - CHANGE_RETENTION_DAYS * 24 * 60 * 60 * 1000,
    );
    // 90 days before 2026-07-31 is 2026-05-02, rendered without a zone suffix
    // so Postgres reads it as-is into the (timezone-less) column.
    expect(queries()[1]!.values[1]).toBe("2026-05-02 12:00:00.000");
  });

  it("keeps deleting while batches come back full, then stops", async () => {
    execute
      .mockResolvedValueOnce(orgList("org-1"))
      .mockResolvedValueOnce(rowList(2_000))
      .mockResolvedValueOnce(rowList(2_000))
      .mockResolvedValueOnce(rowList(37));

    const result = await pruneResourceChanges(NOW);

    expect(execute).toHaveBeenCalledTimes(4); // org list + 3 deletes
    expect(result.deleted).toBe(4_037);
    expect(result.truncated).toBe(false);
  });

  it("stops at the per-org batch ceiling and reports the leftover", async () => {
    execute.mockResolvedValueOnce(orgList("org-1")).mockResolvedValue(rowList(2_000));

    const result = await pruneResourceChanges(NOW);

    // 50 batches max, plus the org listing.
    expect(execute).toHaveBeenCalledTimes(51);
    expect(result.deleted).toBe(100_000);
    expect(result.truncated).toBe(true);
    expect(console.warn).toHaveBeenCalled();
  });

  it("does one probe per org and skips orgs with nothing expired", async () => {
    execute.mockResolvedValueOnce(orgList("org-1", "org-2", "org-3")).mockResolvedValue(rowList(0));

    const result = await pruneResourceChanges(NOW);

    expect(execute).toHaveBeenCalledTimes(4);
    expect(result.organizationsScanned).toBe(3);
    expect(result.deleted).toBe(0);
  });

  it("logs a failing org and carries on with the rest", async () => {
    execute
      .mockResolvedValueOnce(orgList("org-1", "org-2"))
      .mockRejectedValueOnce(new Error("deadlock"))
      .mockResolvedValueOnce(rowList(5));

    const result = await pruneResourceChanges(NOW);

    expect(result.failed).toBe(1);
    expect(result.deleted).toBe(5);
    expect(console.error).toHaveBeenCalledWith(
      "[retention] org org-1: resource_changes prune failed:",
      expect.any(Error),
    );
  });

  it("logs and returns instead of throwing when the org listing fails", async () => {
    execute.mockRejectedValueOnce(new Error("db down"));

    const result = await pruneResourceChanges(NOW);

    expect(result).toMatchObject({ organizationsScanned: 0, deleted: 0 });
    expect(console.error).toHaveBeenCalledWith(
      "[retention] failed to list organizations for resource_changes prune:",
      expect.any(Error),
    );
  });

  it("logs what it pruned, so the pass is never silent", async () => {
    execute.mockResolvedValueOnce(orgList("org-1")).mockResolvedValueOnce(rowList(12));

    await pruneResourceChanges(NOW);

    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("deleted 12 row(s)"));
  });

  it("keeps a window long enough for the feed to be a history", () => {
    expect(CHANGE_RETENTION_DAYS).toBeGreaterThanOrEqual(90);
    expect(CHANGE_RETENTION_INTERVAL_MS).toBe(60 * 60 * 1000);
  });
});

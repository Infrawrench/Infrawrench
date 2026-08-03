import { describe, it, expect } from "vitest";
import {
  groupFanoutResults,
  normalizeFanoutOutput,
  diffLines,
  compactDiff,
  runWithConcurrency,
  type FanoutHostResult,
} from "../ssh-fanout";

function result(overrides: Partial<FanoutHostResult> & { targetId: string }): FanoutHostResult {
  return {
    label: overrides.targetId,
    status: "done",
    exitCode: 0,
    stdout: "",
    stderr: "",
    ...overrides,
  };
}

describe("normalizeFanoutOutput", () => {
  it("strips trailing whitespace per line and trailing newlines", () => {
    expect(normalizeFanoutOutput("a  \nb\t\r\n\n\n", "")).toBe("a\nb");
  });

  it("falls back to stderr when stdout is blank", () => {
    expect(normalizeFanoutOutput("  \n", "boom\n")).toBe("boom");
  });

  it("prefers stdout when both streams have content", () => {
    expect(normalizeFanoutOutput("out\n", "warn\n")).toBe("out");
  });
});

describe("groupFanoutResults", () => {
  it("groups identical output and marks the largest group majority", () => {
    const results = [
      result({ targetId: "a", stdout: "6.1.0\n" }),
      result({ targetId: "b", stdout: "6.1.0" }),
      result({ targetId: "c", stdout: "5.15.0\n" }),
    ];
    const groups = groupFanoutResults(results);
    expect(groups).toHaveLength(2);
    expect(groups[0]?.results.map((r) => r.targetId)).toEqual(["a", "b"]);
    expect(groups[0]?.isMajority).toBe(true);
    expect(groups[1]?.isMajority).toBe(false);
    expect(groups[1]?.output).toBe("5.15.0");
  });

  it("splits same output with different exit codes into different groups", () => {
    const results = [
      result({ targetId: "a", stdout: "x" }),
      result({ targetId: "b", stdout: "x", exitCode: 1 }),
    ];
    const groups = groupFanoutResults(results);
    expect(groups).toHaveLength(2);
  });

  it("keeps failures out of the majority and sorts them last", () => {
    const results = [
      result({ targetId: "a", stdout: "ok" }),
      result({ targetId: "b", status: "error", exitCode: null, error: "connect ECONNREFUSED" }),
      result({ targetId: "c", status: "error", exitCode: null, error: "connect ECONNREFUSED" }),
    ];
    const groups = groupFanoutResults(results);
    expect(groups[0]?.isMajority).toBe(true);
    expect(groups[0]?.results[0]?.targetId).toBe("a");
    expect(groups[1]?.isFailure).toBe(true);
    expect(groups[1]?.results).toHaveLength(2);
    expect(groups[1]?.output).toBe("connect ECONNREFUSED");
  });

  it("marks the failure group majority only when nothing succeeded", () => {
    const groups = groupFanoutResults([
      result({ targetId: "a", status: "error", exitCode: null, error: "nope" }),
    ]);
    expect(groups[0]?.isMajority).toBe(true);
    expect(groups[0]?.isFailure).toBe(true);
  });

  it("ignores pending/running hosts", () => {
    const groups = groupFanoutResults([
      result({ targetId: "a", stdout: "x" }),
      result({ targetId: "b", status: "running" }),
      result({ targetId: "c", status: "pending" }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.results).toHaveLength(1);
  });

  it("answers 'which box has the wrong kernel' at a glance", () => {
    const results = Array.from({ length: 30 }, (_, i) =>
      result({ targetId: `host-${i}`, stdout: i === 17 ? "5.10.0-old\n" : "6.8.0-fleet\n" }),
    );
    const groups = groupFanoutResults(results);
    expect(groups).toHaveLength(2);
    expect(groups[0]?.results).toHaveLength(29);
    expect(groups[1]?.results.map((r) => r.targetId)).toEqual(["host-17"]);
  });
});

describe("diffLines", () => {
  it("returns all-same for identical inputs", () => {
    const d = diffLines("a\nb", "a\nb");
    expect(d.every((l) => l.type === "same")).toBe(true);
    expect(d).toHaveLength(2);
  });

  it("marks outlier-only lines added and majority-only lines removed", () => {
    const d = diffLines("kernel 6.8\narch x86_64", "kernel 5.10\narch x86_64");
    expect(d).toEqual([
      { type: "removed", line: "kernel 6.8" },
      { type: "added", line: "kernel 5.10" },
      { type: "same", line: "arch x86_64" },
    ]);
  });

  it("handles empty sides", () => {
    expect(diffLines("", "x")).toEqual([{ type: "added", line: "x" }]);
    expect(diffLines("x", "")).toEqual([{ type: "removed", line: "x" }]);
    expect(diffLines("", "")).toEqual([]);
  });

  it("keeps common prefix/suffix aligned around an insertion", () => {
    const d = diffLines("a\nb\nc", "a\nb\nnew\nc");
    expect(d).toEqual([
      { type: "same", line: "a" },
      { type: "same", line: "b" },
      { type: "added", line: "new" },
      { type: "same", line: "c" },
    ]);
  });
});

describe("compactDiff", () => {
  it("collapses long unchanged runs to context lines", () => {
    const lines = [
      ...Array.from({ length: 10 }, (_, i) => ({ type: "same" as const, line: `l${i}` })),
      { type: "added" as const, line: "outlier" },
      ...Array.from({ length: 10 }, (_, i) => ({ type: "same" as const, line: `t${i}` })),
    ];
    const compact = compactDiff(lines, 2);
    expect(compact[0]).toEqual({ skipped: 8 });
    expect(compact.at(-1)).toEqual({ skipped: 8 });
    expect(compact).toHaveLength(1 + 2 + 1 + 2 + 1);
  });

  it("returns everything when there is nothing to collapse", () => {
    const lines = [
      { type: "removed" as const, line: "a" },
      { type: "added" as const, line: "b" },
    ];
    expect(compactDiff(lines)).toEqual(lines);
  });
});

describe("runWithConcurrency", () => {
  it("preserves input order and caps in-flight work", async () => {
    let inFlight = 0;
    let peak = 0;
    const items = Array.from({ length: 20 }, (_, i) => i);
    const out = await runWithConcurrency(items, 4, async (i) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return i * 2;
    });
    expect(out).toEqual(items.map((i) => i * 2));
    expect(peak).toBeLessThanOrEqual(4);
    expect(peak).toBeGreaterThan(1);
  });

  it("handles limits larger than the item count and empty input", async () => {
    expect(await runWithConcurrency([1], 8, async (i) => i)).toEqual([1]);
    expect(await runWithConcurrency([], 8, async (i) => i)).toEqual([]);
  });
});

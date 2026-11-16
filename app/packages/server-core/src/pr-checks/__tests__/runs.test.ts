import { describe, expect, it, vi } from "vitest";
import type { PrCheckReport } from "@infrawrench/client-core";

vi.mock("../../db/client.js", () => ({ db: {} }));

const { withCurrentFileKinds } = await import("../runs.js");

function report(files: PrCheckReport["files"]): PrCheckReport {
  return {
    generatedAt: "2026-10-07T00:00:00.000Z",
    files,
    changes: [],
    totals: {
      monthlyDelta: null,
      currency: null,
      partial: false,
      pricedChanges: 0,
      unpricedChanges: 0,
      otherCurrencyChanges: 0,
    },
    blast: { touchedResources: 0, dependants: 0, highestSeverity: null },
    notes: [],
    truncated: false,
  };
}

describe("stored pull request check reports", () => {
  it("leaves out files of a kind the check no longer lists", () => {
    const stored = report([
      { path: "main.tf", kind: "terraform", status: "modified", analysed: true, note: null },
      // A report stored while the check still listed this kind.
      {
        path: "Infrafile",
        kind: "infrafile" as PrCheckReport["files"][number]["kind"],
        status: "modified",
        analysed: false,
        note: "listed but not analysed",
      },
      { path: "k8s/web.yaml", kind: "kubernetes", status: "added", analysed: false, note: "n" },
    ]);
    expect(withCurrentFileKinds(stored).files.map((f) => f.path)).toEqual([
      "main.tf",
      "k8s/web.yaml",
    ]);
  });

  it("returns a current report unchanged", () => {
    const current = report([
      { path: "main.tf", kind: "terraform", status: "added", analysed: true, note: null },
    ]);
    expect(withCurrentFileKinds(current)).toBe(current);
  });
});

import { describe, it, expect } from "vitest";
import {
  COST_REPORT_FOLDER_LIMITS,
  COST_REPORT_LIMITS,
  DASHBOARD_WIDGET_KINDS,
  costReportFolderMoveBlocker,
  costReportFolderPaths,
  duplicateCostReportName,
  flattenCostReportFolderTree,
  normalizeCostReportName,
  type CostReportFolder,
} from "../index";

function folder(id: string, name: string, parentFolderId: string | null = null): CostReportFolder {
  return {
    id,
    name,
    parentFolderId,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
  };
}

describe("normalizeCostReportName", () => {
  it("trims", () => {
    expect(normalizeCostReportName("  Monthly spend  ")).toBe("Monthly spend");
  });

  it("rejects blank names", () => {
    expect(normalizeCostReportName("")).toBeNull();
    expect(normalizeCostReportName("   ")).toBeNull();
  });

  it("rejects names past the stored column's limit", () => {
    expect(normalizeCostReportName("a".repeat(COST_REPORT_LIMITS.maxNameLength))).not.toBeNull();
    expect(normalizeCostReportName("a".repeat(COST_REPORT_LIMITS.maxNameLength + 1))).toBeNull();
  });
});

describe("duplicateCostReportName", () => {
  it("prefixes with 'Copy of'", () => {
    expect(duplicateCostReportName("Spend by service", [])).toBe("Copy of Spend by service");
  });

  it("numbers a second copy rather than colliding", () => {
    expect(duplicateCostReportName("Spend", ["Spend", "Copy of Spend"])).toBe("Copy of Spend (2)");
    expect(duplicateCostReportName("Spend", ["Copy of Spend", "Copy of Spend (2)"])).toBe(
      "Copy of Spend (3)",
    );
  });

  it("compares case- and whitespace-insensitively", () => {
    expect(duplicateCostReportName("Spend", ["  copy of spend "])).toBe("Copy of Spend (2)");
  });

  it("never exceeds the stored column, even when suffixing", () => {
    const long = "x".repeat(COST_REPORT_LIMITS.maxNameLength);
    const first = duplicateCostReportName(long, []);
    expect(first.length).toBeLessThanOrEqual(COST_REPORT_LIMITS.maxNameLength);
    const second = duplicateCostReportName(long, [first]);
    expect(second.length).toBeLessThanOrEqual(COST_REPORT_LIMITS.maxNameLength);
    expect(second).not.toBe(first);
  });
});

describe("DASHBOARD_WIDGET_KINDS", () => {
  it("keeps the ad-hoc cost_graph kind alongside the new cost_report one", () => {
    // Both exist on purpose: a one-off card must not require naming and filing
    // a report first. Losing either is a silent regression for stored widgets.
    expect(DASHBOARD_WIDGET_KINDS).toContain("cost_graph");
    expect(DASHBOARD_WIDGET_KINDS).toContain("cost_report");
  });
});

describe("flattenCostReportFolderTree", () => {
  it("walks depth-first with alphabetical siblings and joined paths", () => {
    const rows = flattenCostReportFolderTree([
      folder("ops", "Ops"),
      folder("fin", "Finance"),
      folder("fin-monthly", "Monthly", "fin"),
      folder("fin-annual", "Annual", "fin"),
    ]);
    expect(rows.map((r) => r.path)).toEqual([
      "Finance",
      "Finance / Annual",
      "Finance / Monthly",
      "Ops",
    ]);
    expect(rows.map((r) => r.depth)).toEqual([0, 1, 1, 0]);
  });

  it("treats a dangling parent as top-level rather than dropping the folder", () => {
    const rows = flattenCostReportFolderTree([folder("orphan", "Orphan", "gone")]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.depth).toBe(0);
    expect(rows[0]!.path).toBe("Orphan");
  });

  it("terminates on a parent cycle instead of recursing forever", () => {
    // Impossible via the API (the move blocker rejects it) but a corrupted
    // payload must never hang the sidebar.
    const rows = flattenCostReportFolderTree([folder("a", "A", "b"), folder("b", "B", "a")]);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThanOrEqual(2);
  });
});

describe("costReportFolderPaths", () => {
  it("maps every folder id to its full path", () => {
    const paths = costReportFolderPaths([folder("fin", "Finance"), folder("m", "Monthly", "fin")]);
    expect(paths.get("fin")).toBe("Finance");
    expect(paths.get("m")).toBe("Finance / Monthly");
  });
});

describe("costReportFolderMoveBlocker", () => {
  const tree = [
    folder("root", "Root"),
    folder("child", "Child", "root"),
    folder("grandchild", "Grandchild", "child"),
    folder("other", "Other"),
  ];

  it("allows a legal move and a move to the top level", () => {
    expect(costReportFolderMoveBlocker(tree, "other", "root")).toBeNull();
    expect(costReportFolderMoveBlocker(tree, "grandchild", null)).toBeNull();
  });

  it("rejects an unknown parent", () => {
    expect(costReportFolderMoveBlocker(tree, "other", "nope")).toMatch(/unknown/i);
  });

  it("rejects moving a folder into itself", () => {
    expect(costReportFolderMoveBlocker(tree, "root", "root")).toMatch(/inside itself/i);
  });

  it("rejects moving a folder under its own descendant — the cycle case", () => {
    expect(costReportFolderMoveBlocker(tree, "root", "grandchild")).toMatch(/inside itself/i);
    expect(costReportFolderMoveBlocker(tree, "root", "child")).toMatch(/inside itself/i);
  });

  it("enforces the depth limit when creating", () => {
    // A new folder under the deepest allowed parent is fine; one level further
    // is not. maxDepth is 3: root(1) / child(2) / grandchild(3).
    expect(COST_REPORT_FOLDER_LIMITS.maxDepth).toBe(3);
    expect(costReportFolderMoveBlocker(tree, null, "child")).toBeNull();
    expect(costReportFolderMoveBlocker(tree, null, "grandchild")).toMatch(/3 levels/);
  });

  it("enforces the depth limit for the whole subtree being moved", () => {
    // "root" carries two levels below it, so it can only live at the top:
    // parking it under even a top-level folder would push "grandchild" to
    // depth 4.
    expect(costReportFolderMoveBlocker(tree, "root", "other")).toMatch(/3 levels/);
    // A childless folder still fits under a depth-2 parent.
    expect(costReportFolderMoveBlocker(tree, "other", "child")).toBeNull();
  });
});

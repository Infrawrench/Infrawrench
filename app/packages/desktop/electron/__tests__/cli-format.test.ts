import { beforeAll, describe, expect, it } from "vitest";

import { anomalyDeltaPercent, formatChangeTime, renderTree, type TreeChild } from "../cli/format";
import { setColorEnabled } from "../cli/output";

// Colors would wrap every assertion in escape sequences; the CLI turns them off
// the same way when stdout isn't a TTY.
beforeAll(() => setColorEnabled(false));

/** `a → b, c` adjacency for the tree tests. */
function adjacency(map: Record<string, string[]>): (id: string) => TreeChild[] {
  return (id) => (map[id] ?? []).map((child) => ({ id: child, caption: `via ${child}` }));
}

const identity = (id: string): string | null => id;

describe("renderTree", () => {
  it("renders nothing for a leaf", () => {
    expect(renderTree("a", adjacency({}), identity)).toEqual([]);
  });

  it("draws branch glyphs and indents children under their parent", () => {
    const lines = renderTree("root", adjacency({ root: ["a", "b"], a: ["a1"] }), identity);
    expect(lines).toEqual(["├─ a  via a", "│  └─ a1  via a1", "└─ b  via b"]);
  });

  it("uses blank continuation under the last child", () => {
    const lines = renderTree("root", adjacency({ root: ["a"], a: ["a1"] }), identity);
    expect(lines).toEqual(["└─ a  via a", "   └─ a1  via a1"]);
  });

  it("marks a link back to the root and does not recurse forever", () => {
    const lines = renderTree("a", adjacency({ a: ["b"], b: ["a"] }), identity);
    expect(lines).toEqual(["└─ b  via b", "   └─ a  via a ↺"]);
  });

  it("breaks a longer cycle rather than hanging", () => {
    const lines = renderTree("a", adjacency({ a: ["b"], b: ["c"], c: ["b"] }), identity);
    expect(lines.at(-1)).toContain("↺");
    expect(lines).toHaveLength(3);
  });

  it("stops at the depth cap and marks the branch", () => {
    const chain = adjacency({ a: ["b"], b: ["c"], c: ["d"], d: ["e"] });
    const lines = renderTree("a", chain, identity, { maxDepth: 2 });
    expect(lines).toEqual(["└─ b  via b", "   └─ c  via c …"]);
  });

  it("drops children whose node is unknown", () => {
    const lines = renderTree("root", adjacency({ root: ["known", "missing"] }), (id) =>
      id === "missing" ? null : id,
    );
    // "known" is no longer last in the child list, so it keeps the ├─ glyph —
    // the branch is dropped, not re-numbered.
    expect(lines).toEqual(["├─ known  via known"]);
  });

  it("records visited ids in a caller-supplied set", () => {
    const seen = new Set<string>(["root"]);
    renderTree("root", adjacency({ root: ["a"], a: ["b"] }), identity, { seen });
    expect([...seen].sort()).toEqual(["a", "b", "root"]);
  });
});

describe("anomalyDeltaPercent", () => {
  it("reports the rise over baseline, rounded", () => {
    expect(anomalyDeltaPercent(2730, 1000)).toBe("+173%");
  });

  it("is null when the baseline is zero — a new key has nothing to be up from", () => {
    expect(anomalyDeltaPercent(5000, 0)).toBeNull();
    expect(anomalyDeltaPercent(5000, -1)).toBeNull();
  });

  it("keeps the sign explicit for a small rise", () => {
    expect(anomalyDeltaPercent(1050, 1000)).toBe("+5%");
  });

  it("is null for a new spend source however its baseline rounded", () => {
    // A near-zero 28-day window rounds to a cent; a percentage off that is
    // arithmetically enormous and tells the reader nothing.
    expect(anomalyDeltaPercent(500_000, 1, "new_source")).toBeNull();
    expect(anomalyDeltaPercent(500_000, 0, "new_source")).toBeNull();
  });

  it("still reports a percentage for a spike with the same numbers", () => {
    expect(anomalyDeltaPercent(500_000, 1, "spike")).not.toBeNull();
  });
});

describe("formatChangeTime", () => {
  it("renders a UTC minute-precision stamp", () => {
    expect(formatChangeTime("2026-07-30T14:05:09.123Z")).toBe("2026-07-30 14:05");
  });

  it("passes an unparseable value through rather than printing Invalid Date", () => {
    expect(formatChangeTime("not a date")).toBe("not a date");
  });
});

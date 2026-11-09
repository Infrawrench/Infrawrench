import { describe, expect, it } from "vitest";
import {
  baseKey,
  groupStatus,
  layoutGraph,
  MAX_ROWS,
  SINGLE_HEIGHT,
  type GraphJob,
} from "../graph";

const job = (
  id: string,
  needs: string[] = [],
  status: GraphJob["status"] = "passed",
): GraphJob => ({
  pipeline: "Test",
  id,
  name: id,
  status,
  durationMs: 1000,
  needs,
});

describe("the CI job graph", () => {
  it("groups matrix entries and package jobs under the key they were written as", () => {
    expect(baseKey("build[app/packages/ui]")).toBe("build");
    expect(baseKey("test[linux,strict]")).toBe("test");
    expect(baseKey("prep")).toBe("prep");
  });

  it("puts each group a layer below everything it needs", () => {
    const layout = layoutGraph(
      [
        job("prep"),
        job("build[a]", ["prep"]),
        job("build[b]", ["prep", "build[a]"]),
        job("check[web]", ["prep", "build[b]"]),
        job("lint"),
      ],
      new Set(),
    );
    const at = Object.fromEntries(layout.groups.map((g) => [g.key, g]));
    expect(at["prep"]!.layer).toBe(0);
    expect(at["lint"]!.layer).toBe(0);
    expect(at["build"]!.layer).toBe(1);
    expect(at["build"]!.needs).toEqual(["prep"]);
    expect(at["check"]!.layer).toBe(2);
    expect(at["check"]!.y).toBeGreaterThan(at["build"]!.y + at["build"]!.height);
    // One edge per group it needs, never one from a group to itself.
    expect(layout.edges.map((e) => `${e.from}->${e.to}`).sort()).toEqual([
      "build->check",
      "prep->build",
      "prep->check",
    ]);
  });

  it("orders a layer to follow the layer above it", () => {
    const layout = layoutGraph(
      [
        job("a"),
        job("b"),
        // Listed in the opposite order to their parents.
        job("under-b", ["b"]),
        job("under-a", ["a"]),
      ],
      new Set(),
    );
    const x = Object.fromEntries(layout.groups.map((g) => [g.key, g.x]));
    expect(Math.sign(x["a"]! - x["b"]!)).toBe(Math.sign(x["under-a"]! - x["under-b"]!));
  });

  it("shows a large group's first rows until it is expanded", () => {
    const many = Array.from({ length: MAX_ROWS + 5 }, (_, i) => job(`t[${i}]`));
    const folded = layoutGraph(many, new Set()).groups[0]!;
    expect(folded.hidden).toBe(5);
    const open = layoutGraph(many, new Set(["t"])).groups[0]!;
    expect(open.hidden).toBe(0);
    expect(open.height).toBeGreaterThan(folded.height);
    expect(layoutGraph([job("one")], new Set()).groups[0]!.height).toBe(SINGLE_HEIGHT);
  });

  it("survives a cycle rather than recursing forever", () => {
    const layout = layoutGraph([job("a", ["b"]), job("b", ["a"])], new Set());
    expect(layout.groups).toHaveLength(2);
  });

  it("summarises a group's status, running and failures first", () => {
    expect(groupStatus([job("a"), job("b", [], "running"), job("c", [], "failed")])).toBe(
      "running",
    );
    expect(groupStatus([job("a"), job("c", [], "failed")])).toBe("failed");
    expect(groupStatus([job("a", [], "skipped"), job("b", [], "skipped")])).toBe("skipped");
    expect(groupStatus([job("a"), job("b", [], "skipped")])).toBe("passed");
    expect(groupStatus([job("a"), job("b", [], "pending")])).toBe("pending");
  });
});

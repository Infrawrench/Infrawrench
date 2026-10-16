import { describe, expect, it } from "vitest";
import {
  DEFAULT_VIRTUAL_TAG_RULE,
  VIRTUAL_TAG_LIMITS,
  virtualTagDependencies,
  virtualTagDependents,
  virtualTagEvaluationOrder,
  virtualTagReferenceError,
  type VirtualTagGraphNode,
  type VirtualTagRule,
} from "../virtual-tags";

function valueRule(query: string, value = "x"): VirtualTagRule {
  return { ...DEFAULT_VIRTUAL_TAG_RULE, query, value };
}

function splitRule(): VirtualTagRule {
  return {
    ...DEFAULT_VIRTUAL_TAG_RULE,
    kind: "split",
    value: null,
    allocations: [
      { value: "a", percent: 50, metricId: null },
      { value: "b", percent: 50, metricId: null },
    ],
  };
}

/** A tag whose single rule filters on each of `uses`. */
function node(key: string, ...uses: string[]): VirtualTagGraphNode {
  const query = uses.map((u) => `virtual_tag['${u}'] = 'v'`).join(" AND ");
  return { key, rules: [valueRule(query)] };
}

describe("virtualTagDependencies", () => {
  it("collects keys from rule filters and per-source filters, once each", () => {
    const rules: VirtualTagRule[] = [
      valueRule("virtual_tag['team'] IN ('a', 'b') AND provider = 'aws'"),
      {
        ...DEFAULT_VIRTUAL_TAG_RULE,
        kind: "tag",
        value: null,
        sources: [
          { tagKey: "env", valuePrefix: null, query: "virtual_tag['stage'] IS SET" },
          { tagKey: "Env", valuePrefix: null, query: "virtual_tag['team'] ~= 'x'" },
        ],
      },
    ];
    expect(virtualTagDependencies(rules)).toEqual(["team", "stage"]);
  });

  it("ignores filters that do not parse (the rule check reports those)", () => {
    expect(virtualTagDependencies([valueRule("virtual_tag['team'] >")])).toEqual([]);
  });
});

describe("virtualTagReferenceError", () => {
  it("accepts a tag that builds on a single-valued tag", () => {
    expect(virtualTagReferenceError(node("unit", "team"), [node("team")])).toBeNull();
  });

  it("names a reference to a tag that does not exist", () => {
    expect(virtualTagReferenceError(node("unit", "ghost"), [node("team")])).toBe(
      'A rule of "unit" filters on the virtual tag "ghost", which does not exist.',
    );
  });

  it("refuses a self-reference", () => {
    expect(virtualTagReferenceError(node("unit", "unit"), [])).toContain("itself");
  });

  it("refuses filtering on a split tag, and a split on a tag something filters on", () => {
    const team: VirtualTagGraphNode = { key: "team", rules: [splitRule()] };
    expect(virtualTagReferenceError(node("unit", "team"), [team])).toContain(
      "splits rows between values",
    );
    expect(virtualTagReferenceError(team, [node("unit", "team")])).toContain(
      '"unit" filters on "team", so "team" cannot split',
    );
  });

  it("names the whole cycle", () => {
    const error = virtualTagReferenceError(node("unit", "team"), [
      node("team", "owner"),
      node("owner", "unit"),
    ]);
    expect(error).toContain("unit → team → owner → unit");
  });

  it("replaces the candidate's stored row rather than reading both", () => {
    // Editing `team` to stop filtering on `unit` breaks the stored cycle.
    expect(
      virtualTagReferenceError(node("team"), [node("unit", "team"), node("team", "unit")]),
    ).toBeNull();
  });

  it(`limits chains to ${VIRTUAL_TAG_LIMITS.maxReferenceDepth} tags, counting both directions`, () => {
    const max = VIRTUAL_TAG_LIMITS.maxReferenceDepth;
    const keys = Array.from({ length: max + 1 }, (_, i) => `t${i}`);
    // t0 → t1 → … → t{max}; validate the middle tag so the chain runs both ways.
    const all = keys.map((k, i) => (i < keys.length - 1 ? node(k, keys[i + 1]!) : node(k)));
    const mid = Math.floor(keys.length / 2);
    const error = virtualTagReferenceError(
      all[mid]!,
      all.filter((_, i) => i !== mid),
    );
    expect(error).toContain(`at most ${max} deep`);
    expect(error).toContain(keys.join(" → "));

    // One shorter is fine.
    const ok = all.slice(1);
    expect(virtualTagReferenceError(ok[0]!, ok.slice(1))).toBeNull();
  });

  it("finds the longest chain into the candidate even when a user's longest chain goes elsewhere", () => {
    // x → c, and x → y → z → w → v: x's own longest chain skips c.
    const nodes = [node("x", "c", "y"), node("y", "z"), node("z", "w"), node("w", "v"), node("v")];
    // c → d → e → f → g gives x → c → d → e → f → g = 6 > 5.
    const below = [node("d", "e"), node("e", "f"), node("f", "g"), node("g")];
    expect(virtualTagReferenceError(node("c", "d"), [...nodes, ...below])).toContain(
      "x → c → d → e → f → g",
    );
  });
});

describe("virtualTagEvaluationOrder", () => {
  it("puts every tag after the tags it filters on", () => {
    const order = virtualTagEvaluationOrder([
      node("unit", "team", "stage"),
      node("team", "owner"),
      node("stage"),
      node("owner"),
    ]);
    expect(order.indexOf("owner")).toBeLessThan(order.indexOf("team"));
    expect(order.indexOf("team")).toBeLessThan(order.indexOf("unit"));
    expect(order.indexOf("stage")).toBeLessThan(order.indexOf("unit"));
    expect(order).toHaveLength(4);
  });

  it("terminates on a stored cycle and keeps every key", () => {
    expect(virtualTagEvaluationOrder([node("a", "b"), node("b", "a")]).sort()).toEqual(["a", "b"]);
  });
});

describe("virtualTagDependents", () => {
  it("lists direct and transitive users, nearest first", () => {
    const nodes = [node("unit", "team"), node("division", "unit"), node("team"), node("other")];
    expect(virtualTagDependents("team", nodes)).toEqual([
      { key: "unit", distance: 1 },
      { key: "division", distance: 2 },
    ]);
    expect(virtualTagDependents("other", nodes)).toEqual([]);
  });
});

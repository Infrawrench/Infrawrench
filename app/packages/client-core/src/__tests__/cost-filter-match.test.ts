import { describe, expect, it } from "vitest";
import {
  costFilterMatches,
  costFilterOpError,
  foldCostFilterCase,
  isCompleteCostFilter,
  normalizeCostFilterValue,
} from "../cost-filter-match";
import { COST_FILTER_OPS, COST_FILTER_OP_DESCRIPTIONS, COST_FILTER_OP_LABELS } from "../costs";

describe("normalizeCostFilterValue", () => {
  it("treats case, whitespace, underscores and hyphens as the same value", () => {
    const spellings = ["Prod_Env", "prod-env", "PROD ENV", "prodenv", " prod\t_-env\n"];
    for (const s of spellings) expect(normalizeCostFilterValue(s)).toBe("prodenv");
  });

  it("folds ASCII letters only, exactly like ClickHouse lower()", () => {
    // `toLowerCase` would fold these too, and the editor would then promise a
    // match the query never makes.
    expect(foldCostFilterCase("ÄÖÜ Straße")).toBe("ÄÖÜ straße");
    expect(normalizeCostFilterValue("Café-Prod")).toBe("caféprod");
  });

  it("keeps every other separator, so dots and slashes still distinguish values", () => {
    expect(normalizeCostFilterValue("team.a/b:c")).toBe("team.a/b:c");
  });

  it("removes exactly RE2's [[:space:]] set plus _ and -", () => {
    // [[:space:]] is [\t\n\v\f\r ]: no non-breaking space, no Unicode spaces.
    expect(normalizeCostFilterValue("a\t\n\v\f\r b")).toBe("ab");
    expect(normalizeCostFilterValue("a b")).toBe("a b");
  });
});

describe("costFilterMatches", () => {
  const m = (op: (typeof COST_FILTER_OPS)[number], values: string[], actual: string) =>
    costFilterMatches({ op, values }, actual);

  it("in / not_in are exact", () => {
    expect(m("in", ["prod"], "prod")).toBe(true);
    expect(m("in", ["prod"], "Prod")).toBe(false);
    expect(m("not_in", ["prod"], "Prod")).toBe(true);
  });

  it("flexible_match ignores case, spaces, underscores and hyphens on both sides", () => {
    expect(m("flexible_match", ["prod-env"], "Prod_Env")).toBe(true);
    expect(m("flexible_match", ["staging", "PROD ENV"], "prod_env")).toBe(true);
    expect(m("flexible_match", ["prod"], "production")).toBe(false);
  });

  it("contains / not_contains / starts_with ignore case and accept any value", () => {
    expect(m("contains", ["compute"], "Amazon Elastic Compute Cloud")).toBe(true);
    expect(m("contains", ["x", "elastic"], "Amazon Elastic Compute Cloud")).toBe(true);
    expect(m("not_contains", ["support"], "AWS Support")).toBe(false);
    expect(m("not_contains", ["support"], "Amazon S3")).toBe(true);
    expect(m("starts_with", ["ARN:AWS:RDS"], "arn:aws:rds:us-east-1:1:db:x")).toBe(true);
    expect(m("starts_with", ["rds"], "arn:aws:rds")).toBe(false);
  });

  it("is_set / is_not_set read a missing tag as the empty string", () => {
    expect(m("is_set", [], "")).toBe(false);
    expect(m("is_set", [], "x")).toBe(true);
    expect(m("is_not_set", [], "")).toBe(true);
    expect(m("not_contains", ["a"], "")).toBe(true);
  });
});

describe("costFilterOpError", () => {
  it("accepts a well-formed term for every operator", () => {
    for (const op of COST_FILTER_OPS) {
      const valueless = op === "is_set" || op === "is_not_set";
      expect(
        costFilterOpError({ dimension: "tag", op, values: valueless ? [] : ["a"] }),
      ).toBeNull();
    }
  });

  it("limits IS SET to keyed dimensions and refuses values on it", () => {
    expect(costFilterOpError({ dimension: "service", op: "is_set", values: [] })).toContain(
      "tags and virtual tags only",
    );
    expect(costFilterOpError({ dimension: "tag", op: "is_not_set", values: ["a"] })).toContain(
      "take no values",
    );
  });

  it("refuses empty or meaningless text matches", () => {
    expect(costFilterOpError({ dimension: "service", op: "contains", values: [""] })).toContain(
      "matches everything",
    );
    expect(
      costFilterOpError({ dimension: "tag", op: "flexible_match", values: ["_ -"] }),
    ).toContain("IS NOT SET");
    expect(costFilterOpError({ dimension: "service", op: "in", values: [] })).toContain(
      "at least one value",
    );
    // An equality match on the empty string stays legal: it is "untagged".
    expect(costFilterOpError({ dimension: "tag", op: "in", values: [""] })).toBeNull();
  });

  it("names an unknown operator", () => {
    expect(
      costFilterOpError({ dimension: "service", op: "like" as never, values: ["a"] }),
    ).toContain('"like"');
  });
});

describe("isCompleteCostFilter", () => {
  it("treats a valueless operator as complete and an empty list as unfinished", () => {
    expect(isCompleteCostFilter({ op: "is_set", values: [] })).toBe(true);
    expect(isCompleteCostFilter({ op: "contains", values: [] })).toBe(false);
    expect(isCompleteCostFilter({ op: "in", values: ["a"] })).toBe(true);
  });
});

describe("operator vocabulary", () => {
  it("labels and describes every operator", () => {
    for (const op of COST_FILTER_OPS) {
      expect(COST_FILTER_OP_LABELS[op]).toBeTruthy();
      expect(COST_FILTER_OP_DESCRIPTIONS[op]).toBeTruthy();
    }
  });
});

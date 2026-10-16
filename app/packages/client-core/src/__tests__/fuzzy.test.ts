import { describe, expect, it } from "vitest";
import { fuzzyFilter, fuzzyScore, fuzzyTokenScore } from "../fuzzy";

describe("fuzzyTokenScore", () => {
  it("ranks exact > prefix > word start > mid-word > subsequence", () => {
    const exact = fuzzyTokenScore("report", "report")!;
    const prefix = fuzzyTokenScore("report", "reports by team")!;
    const word = fuzzyTokenScore("report", "Monthly report")!;
    const mid = fuzzyTokenScore("port", "report")!;
    const subseq = fuzzyTokenScore("rpt", "report")!;
    expect(exact).toBeGreaterThan(prefix);
    expect(prefix).toBeGreaterThan(word);
    expect(word).toBeGreaterThan(mid);
    expect(mid).toBeGreaterThan(subseq);
    expect(subseq).toBeGreaterThan(0);
  });

  it("is case-insensitive", () => {
    expect(fuzzyTokenScore("PROD", "production")).toBe(fuzzyTokenScore("prod", "Production"));
  });

  it("treats camelCase humps as word starts", () => {
    expect(fuzzyTokenScore("report", "costReport")!).toBeGreaterThan(
      fuzzyTokenScore("eport", "costReport")!,
    );
  });

  it("returns null when the characters are not all present in order", () => {
    expect(fuzzyTokenScore("xyz", "report")).toBeNull();
    expect(fuzzyTokenScore("tr", "rt")).toBeNull();
    expect(fuzzyTokenScore("a", "")).toBeNull();
  });
});

describe("fuzzyScore", () => {
  it("requires every token to match some field", () => {
    expect(fuzzyScore("prod db", "db-primary", ["Production"])).not.toBeNull();
    expect(fuzzyScore("prod cache", "db-primary", ["Production"])).toBeNull();
  });

  it("weights a hit on the name above the same hit in a secondary field", () => {
    const onName = fuzzyScore("billing", "Billing", ["Dashboard"])!;
    const onSecondary = fuzzyScore("billing", "Overview", ["Billing"])!;
    expect(onName).toBeGreaterThan(onSecondary);
  });

  it("matches everything on an empty query", () => {
    expect(fuzzyScore("   ", "anything")).toBe(0);
  });

  it("ignores missing secondary fields", () => {
    expect(fuzzyScore("x", "y", [null, undefined, ""])).toBeNull();
  });
});

describe("fuzzyFilter", () => {
  const items = [
    { name: "Team spend", kind: "Cost report" },
    { name: "Spend by region", kind: "Cost report" },
    { name: "Production", kind: "Dashboard" },
    { name: "Weekly", kind: "Budget" },
  ];
  const fields = (i: (typeof items)[number]) => ({ primary: i.name, secondary: [i.kind] });

  it("ranks best first and drops non-matches", () => {
    expect(fuzzyFilter(items, "spend", fields).map((i) => i.name)).toEqual([
      "Spend by region",
      "Team spend",
    ]);
  });

  it("keeps the incoming order for an empty query", () => {
    expect(fuzzyFilter(items, "", fields)).toEqual(items);
  });

  it("matches on secondary labels", () => {
    expect(fuzzyFilter(items, "budget", fields).map((i) => i.name)).toEqual(["Weekly"]);
  });
});

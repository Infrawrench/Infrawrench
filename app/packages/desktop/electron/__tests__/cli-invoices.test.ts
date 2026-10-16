import { describe, expect, it } from "vitest";
import { tail4, unassignedQuery } from "../cli/commands/invoices";

describe("invoices CLI helpers", () => {
  it("masks account numbers to their last four characters", () => {
    expect(tail4("GB82 WEST 1234 5698 7654 32")).toBe("•••• 5432");
    expect(tail4("123")).toBe("••••");
    expect(tail4(null)).toBeNull();
  });

  it("takes both ends of the unassigned period or neither", () => {
    expect(unassignedQuery({})).toBe("");
    expect(unassignedQuery({ from: "2026-01-01", to: "2026-03-31" })).toBe(
      "?from=2026-01-01&to=2026-03-31",
    );
    expect(() => unassignedQuery({ from: "2026-01-01" })).toThrow(/both/);
    expect(() => unassignedQuery({ from: "January", to: "March" })).toThrow(/days/);
    expect(() => unassignedQuery({ from: "2026-03-01", to: "2026-01-01" })).toThrow(/before/);
  });
});

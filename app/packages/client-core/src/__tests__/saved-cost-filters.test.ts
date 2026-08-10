import { describe, expect, it } from "vitest";

import {
  describeSavedCostFilterReferents,
  resolveSavedCostFilterInput,
} from "../saved-cost-filters";
import { formatCostQuery, parseCostQuery, CostQueryParseError } from "../cost-query-language";
import type { CostFilter } from "../costs";

const prodOnly: CostFilter[] = [
  { dimension: "tag", op: "in", values: ["prod"], tagKey: "env" },
  { dimension: "provider", op: "not_in", values: ["docker"] },
];

describe("resolveSavedCostFilterInput", () => {
  it("accepts structured filters and returns them (minus empty rows)", () => {
    const resolved = resolveSavedCostFilterInput({
      name: "Prod only",
      filters: [...prodOnly, { dimension: "service", op: "in", values: [] }],
    });
    expect(resolved).toEqual(prodOnly);
  });

  it("compiles the query spelling to the identical structured filter", () => {
    // The round trip is the contract: whichever spelling a caller uses, the
    // stored object is the same bytes, so a filter saved from text and one
    // saved from rows can never mean different things.
    const resolved = resolveSavedCostFilterInput({
      name: "Prod only",
      filters: [],
      query: formatCostQuery(prodOnly),
    });
    expect(resolved).toEqual(prodOnly);
  });

  it("round-trips its result through the query language", () => {
    const resolved = resolveSavedCostFilterInput({ name: "Prod only", filters: prodOnly });
    expect(parseCostQuery(formatCostQuery(resolved))).toEqual(resolved);
  });

  it("rejects both spellings at once rather than picking a winner", () => {
    expect(() =>
      resolveSavedCostFilterInput({
        name: "x",
        filters: prodOnly,
        query: "provider = 'aws'",
      }),
    ).toThrow(/not both/);
  });

  it("rejects an empty filter — a named match-everything is a trap", () => {
    expect(() => resolveSavedCostFilterInput({ name: "x", filters: [] })).toThrow(
      /at least one term/,
    );
    // Rows with no values count as empty: that is a half-finished editor row.
    expect(() =>
      resolveSavedCostFilterInput({
        name: "x",
        filters: [{ dimension: "service", op: "in", values: [] }],
      }),
    ).toThrow(/at least one term/);
    expect(() => resolveSavedCostFilterInput({ name: "x", filters: [], query: "   " })).toThrow(
      /at least one term/,
    );
  });

  it("rejects a tag term with no key, so the stored filter always has a text form", () => {
    expect(() =>
      resolveSavedCostFilterInput({
        name: "x",
        filters: [{ dimension: "tag", op: "in", values: ["prod"] }],
      }),
    ).toThrow(/tag filter needs a key/);
  });

  it("propagates query parse errors with their offset intact", () => {
    try {
      resolveSavedCostFilterInput({ name: "x", filters: [], query: "provider == 'aws'" });
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(CostQueryParseError);
      expect((e as CostQueryParseError).offset).toBeGreaterThan(0);
    }
  });
});

describe("describeSavedCostFilterReferents", () => {
  it("names each referent with its kind, and widgets with their dashboard", () => {
    expect(
      describeSavedCostFilterReferents([
        { kind: "budget", id: "b1", name: "Prod spend" },
        { kind: "cost_report", id: "r1", name: "AWS by service" },
        {
          kind: "cost_graph_widget",
          id: "w1",
          name: "Spend",
          dashboardId: "d1",
          dashboardName: "Main",
        },
      ]),
    ).toBe('budget "Prod spend", report "AWS by service", dashboard graph "Spend" on Main');
  });
});

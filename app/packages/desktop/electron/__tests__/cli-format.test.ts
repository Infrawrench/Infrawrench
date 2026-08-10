import { beforeAll, describe, expect, it } from "vitest";

import {
  anomalyDeltaPercent,
  formatBillingRule,
  formatChangeTime,
  formatMetricAlertCondition,
  formatMetricAlertSelector,
  matchCostReport,
  renderTree,
  type TreeChild,
  formatUnitCostRatio,
  unitCostRatioLabel,
  formatInvoiceStatus,
  formatInvoiceTotal,
} from "../cli/format";
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

describe("formatMetricAlertCondition", () => {
  it("renders the one-line condition", () => {
    expect(
      formatMetricAlertCondition({
        metricKey: "CPU %",
        comparator: ">",
        threshold: 90,
        forMinutes: 15,
      }),
    ).toBe("CPU % > 90 for 15m");
  });
});

describe("formatMetricAlertSelector", () => {
  it("joins the set parts with a middle dot", () => {
    expect(
      formatMetricAlertSelector({
        pluginId: "aws",
        resourceTypeId: "ec2-instance",
        tagKey: "env",
        tagValue: "prod",
      }),
    ).toBe("aws · ec2-instance · env=prod");
  });

  it("renders a value-less tag as just the key", () => {
    expect(
      formatMetricAlertSelector({
        pluginId: null,
        resourceTypeId: null,
        tagKey: "env",
        tagValue: null,
      }),
    ).toBe("env");
  });

  it("says all resources for an empty selector", () => {
    expect(
      formatMetricAlertSelector({
        pluginId: null,
        resourceTypeId: null,
        tagKey: null,
        tagValue: null,
      }),
    ).toBe("all resources");
  });
});

describe("matchCostReport", () => {
  const reports = [
    { id: "id-1", name: "Monthly spend" },
    { id: "id-2", name: "Monthly spend by team" },
    { id: "id-3", name: "EC2 only" },
  ];

  it("matches an exact id", () => {
    expect(matchCostReport(reports, "id-2")).toEqual({ match: reports[1] });
  });

  it("prefers an exact name over a substring of a longer one", () => {
    // "Monthly spend" is also a substring of "Monthly spend by team"; without
    // the exact-name pass this query would be ambiguous and refuse to run.
    expect(matchCostReport(reports, "Monthly spend")).toEqual({ match: reports[0] });
  });

  it("is case- and whitespace-insensitive on names", () => {
    expect(matchCostReport(reports, "  ec2 ONLY ")).toEqual({ match: reports[2] });
  });

  it("matches a unique substring", () => {
    expect(matchCostReport(reports, "by team")).toEqual({ match: reports[1] });
  });

  it("refuses an ambiguous substring and names the candidates", () => {
    // Running the wrong cost report is a quiet, plausible-looking wrong answer,
    // so an ambiguous query must fail rather than pick the first row.
    const result = matchCostReport(reports, "Monthly");
    expect(result.match).toBeNull();
    expect(result.match === null && result.candidates).toHaveLength(2);
  });

  it("reports no candidates for a miss", () => {
    const result = matchCostReport(reports, "nothing like this");
    expect(result.match).toBeNull();
    expect(result.match === null && result.candidates).toHaveLength(0);
  });
});

describe("formatUnitCostRatio", () => {
  it("prints a gap as an em dash, never as zero", () => {
    // The single most important assertion in this file. A CLI that printed
    // "0.00" for a period nobody reported would be believed exactly as readily
    // as a chart that drew a zero — and it says the opposite of the truth.
    expect(formatUnitCostRatio(null, "unit_cost")).toBe("—");
    expect(formatUnitCostRatio(null, "margin")).toBe("—");
  });

  it("prints a genuine zero as zero", () => {
    // Distinct from a gap: no spend over a real denominator really is 0 per
    // unit, and collapsing the two would lose the distinction the API works to
    // preserve.
    expect(formatUnitCostRatio(0, "unit_cost")).toBe("0");
  });

  it("never prints a non-finite value", () => {
    expect(formatUnitCostRatio(Number.POSITIVE_INFINITY, "unit_cost")).toBe("—");
    expect(formatUnitCostRatio(Number.NaN, "unit_cost")).toBe("—");
  });

  it("keeps significant digits on a sub-cent unit cost", () => {
    // Cost per API request is routinely this small; rounding to 0.00 would
    // read as "free", which is the same lie by a different route.
    expect(formatUnitCostRatio(0.0000123, "unit_cost")).toBe("0.0000123");
    expect(formatUnitCostRatio(0.0125, "unit_cost")).toBe("0.0125");
  });

  it("renders margin as a percentage, including a negative one", () => {
    expect(formatUnitCostRatio(0.6, "margin")).toBe("60.0%");
    expect(formatUnitCostRatio(-0.5, "margin")).toBe("-50.0%");
  });
});

describe("unitCostRatioLabel", () => {
  it("names the currency and the unit", () => {
    expect(unitCostRatioLabel("unit_cost", "USD", "customer")).toBe("USD/customer");
  });

  it("says margin rather than a currency for the margin mode", () => {
    expect(unitCostRatioLabel("margin", "USD", "customer")).toBe("margin");
  });

  it("falls back to a generic unit rather than printing a bare slash", () => {
    expect(unitCostRatioLabel("unit_cost", "EUR", "")).toBe("EUR/unit");
  });
});

describe("formatBillingRule", () => {
  it("renders a markup with a sign and its scope", () => {
    expect(
      formatBillingRule({
        match: { tagKey: "team", tagValue: "platform" },
        adjustment: { kind: "percentage", percent: 15 },
      }),
    ).toBe("+15% on tag team=platform");
  });

  it("renders a discount without inventing a plus sign", () => {
    expect(formatBillingRule({ match: {}, adjustment: { kind: "percentage", percent: -8 } })).toBe(
      "-8% on all spend",
    );
  });

  it("says 'all spend' for a catch-all rather than leaving the scope blank", () => {
    // A rule that matches everything is the most consequential kind there is,
    // so an empty scope must read as "everything", never as nothing.
    expect(formatBillingRule({ match: {}, adjustment: { kind: "percentage", percent: 3 } })).toBe(
      "+3% on all spend",
    );
  });

  it("renders a fixed charge with its period and where it is booked", () => {
    expect(
      formatBillingRule({
        match: { pluginId: "aws" },
        adjustment: {
          kind: "fixed",
          amount: 3000,
          currency: "USD",
          period: "monthly",
          targetKind: "cost_centre",
          targetId: "cc-eng",
        },
      }),
    ).toBe("3000 USD/month → cost centre cc-eng on provider aws");
  });

  it("renders a reallocation as a move", () => {
    expect(
      formatBillingRule({
        match: { service: "AmazonEKS" },
        adjustment: { kind: "reallocation", targetKind: "account", targetId: "acct-shared" },
      }),
    ).toBe("move to account acct-shared on service AmazonEKS");
  });

  it("ANDs every set match field, charge type included", () => {
    expect(
      formatBillingRule({
        match: { tagKey: "env", accountId: "acct-a", service: "AmazonS3", chargeType: "usage" },
        adjustment: { kind: "percentage", percent: 5 },
      }),
    ).toBe("+5% on has tag env and account acct-a and service AmazonS3 and charge type usage");
  });
});

describe("formatInvoiceStatus", () => {
  it("says a draft recomputes, because that is the whole difference", () => {
    expect(formatInvoiceStatus({ status: "draft" })).toBe("draft (recomputes)");
  });

  it("dates an issued invoice from the transition that produced it", () => {
    expect(formatInvoiceStatus({ status: "approved", issuedAt: "2026-02-03T09:14:00.000Z" })).toBe(
      "approved 2026-02-03",
    );
    expect(formatInvoiceStatus({ status: "sent", sentAt: "2026-02-04T11:00:00.000Z" })).toBe(
      "sent 2026-02-04",
    );
    expect(formatInvoiceStatus({ status: "void", voidedAt: "2026-02-09T08:00:00.000Z" })).toBe(
      "void 2026-02-09",
    );
  });

  it("degrades to the bare status when the timestamp is missing", () => {
    expect(formatInvoiceStatus({ status: "approved" })).toBe("approved");
  });
});

describe("formatInvoiceTotal", () => {
  it("never prints 0.00 for an uncomputed draft", () => {
    // The list endpoint returns null totals for drafts on purpose; falling back
    // to a zero would be a number somebody quotes to a customer.
    expect(formatInvoiceTotal(null, "GBP")).toBe("not computed");
    expect(formatInvoiceTotal(undefined, "GBP")).toBe("not computed");
  });

  it("prints the invoice currency first when an amount could not be converted", () => {
    expect(formatInvoiceTotal({ billed: { SEK: 4000, GBP: 1200.5 } }, "GBP")).toBe(
      "1200.50 GBP + 4000.00 SEK",
    );
  });

  it("prints a zero total in the invoice currency rather than nothing", () => {
    expect(formatInvoiceTotal({ billed: {} }, "USD")).toBe("0.00 USD");
  });
});

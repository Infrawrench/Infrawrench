import { describe, expect, it, vi } from "vitest";
import type { PrCheckChange, PrCheckReport } from "@infrawrench/client-core";

// analyze.ts pulls in the database and plugin loader; only its pure
// `totalsOf` is under test here.
vi.mock("../../db/client.js", () => ({ db: {} }));

const { renderAnnotations, renderComment, renderReportMarkdown, GITHUB_SUMMARY_LIMIT } =
  await import("../render.js");
const { totalsOf } = await import("../analyze.js");

function change(overrides: Partial<PrCheckChange>): PrCheckChange {
  return {
    address: "aws_instance.web",
    terraformType: "aws_instance",
    action: "update",
    path: "main.tf",
    line: 3,
    resourceId: null,
    displayName: null,
    pluginId: "aws",
    resourceTypeId: "ec2-instance",
    changedAttributes: ["instance_type"],
    count: 1,
    before: null,
    after: null,
    monthlyDelta: null,
    currency: null,
    unpricedReason: null,
    blastRadius: null,
    warnings: [],
    ...overrides,
  };
}

function report(changes: PrCheckChange[]): PrCheckReport {
  return {
    generatedAt: "2026-10-07T00:00:00.000Z",
    files: [{ path: "main.tf", kind: "terraform", status: "modified", analysed: true, note: null }],
    changes,
    totals: totalsOf(changes),
    blast: { touchedResources: 0, dependants: 0, highestSeverity: null },
    notes: [],
    truncated: false,
  };
}

const links = {
  iacUrl: "https://app.example.com/org/o1/settings/pr-checks",
  resourceUrl: () => "https://app.example.com/r",
};

describe("totalsOf", () => {
  it("sums priced deltas and never turns an unpriced change into zero", () => {
    const t = totalsOf([
      change({ monthlyDelta: 60.5, currency: "USD" }),
      change({ monthlyDelta: -10, currency: "USD" }),
      change({ unpricedReason: "no rate" }),
    ]);
    expect(t).toEqual({
      monthlyDelta: 50.5,
      currency: "USD",
      partial: true,
      pricedChanges: 2,
      unpricedChanges: 1,
      otherCurrencyChanges: 0,
    });
  });

  it("is null, not zero, when nothing priced", () => {
    expect(totalsOf([change({ unpricedReason: "x" })]).monthlyDelta).toBeNull();
  });
});

describe("renderReportMarkdown", () => {
  it("renders the headline, the table, warnings and the link", () => {
    const md = renderReportMarkdown(
      report([
        change({
          resourceId: "aws:acct:i-1",
          displayName: "web-1",
          before: { monthlyAmount: 60, currency: "USD", partial: false },
          after: { monthlyAmount: 120, currency: "USD", partial: false },
          monthlyDelta: 60,
          currency: "USD",
          blastRadius: {
            directDependants: 5,
            transitiveDependants: 2,
            references: 1,
            severity: "high",
            headline: "5 resources depend directly on this.",
            topDependants: ["lb | main"],
            unchecked: 0,
          },
          warnings: [{ kind: "rightsizing", severity: "warning", message: "Oversized." }],
        }),
        change({ address: "aws_s3_bucket.x", action: "create", unpricedReason: "no rate" }),
      ]),
      links,
    );
    expect(md).toContain("Estimated monthly cost change: **at least +$60**");
    expect(md).toContain(
      "| `aws_instance.web` ([web-1](https://app.example.com/r)) | change | $60 | $120 | **+$60** |",
    );
    expect(md).toContain("high: 7 dependants, 1 reference");
    expect(md).toContain("lb \\| main");
    expect(md).toContain("`aws_instance.web`: Oversized.");
    expect(md).toContain("`aws_s3_bucket.x`: no rate");
    expect(md).toContain(
      "[Open in Infrawrench](https://app.example.com/org/o1/settings/pr-checks)",
    );
  });

  it("says plainly when no infrastructure changed", () => {
    const md = renderReportMarkdown({ ...report([]), files: [] }, links);
    expect(md.startsWith("This pull request changes no infrastructure files.")).toBe(true);
  });

  it("stays under GitHub's summary limit", () => {
    const many = Array.from({ length: 3000 }, (_, i) =>
      change({ address: `a_b.n${i}`, unpricedReason: "x".repeat(200) }),
    );
    expect(renderReportMarkdown(report(many), links).length).toBeLessThanOrEqual(
      GITHUB_SUMMARY_LIMIT,
    );
  });
});

describe("renderAnnotations and renderComment", () => {
  it("annotates priced or warned blocks, at most 50", () => {
    const many = Array.from({ length: 80 }, (_, i) =>
      change({ address: `a_b.n${i}`, monthlyDelta: 1, currency: "USD" }),
    );
    const annotations = renderAnnotations(report(many));
    expect(annotations).toHaveLength(50);
    expect(annotations[0]).toMatchObject({
      path: "main.tf",
      start_line: 3,
      annotation_level: "notice",
    });
  });

  it("carries the hidden marker so a lost comment id is recoverable", () => {
    const body = renderComment(report([]), "failure", links, "abcdef1234");
    expect(body.startsWith("<!-- infrawrench-pr-check -->")).toBe(true);
    expect(body).toContain("above this repository's threshold");
    expect(body).toContain("abcdef1");
  });
});

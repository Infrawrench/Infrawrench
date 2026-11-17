import { describe, expect, it } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { buildCommitmentReport, emptyCommitmentReportTotals } from "@infrawrench/client-core";

import { CommitmentReportView } from "../commitment-reports/CommitmentReportView.js";

const cell = (groupKey: string, covered: number) => ({
  bucket: "2026-10-01",
  groupKey,
  currency: "USD",
  ...emptyCommitmentReportTotals(),
  covered,
  coveredAll: covered,
  uncovered: 50,
});

function grouped() {
  return buildCommitmentReport([cell("aws", 40), cell("azure", 20)], {
    from: "2026-10-01",
    to: "2026-10-01",
    granularity: "daily",
    groupBy: "provider",
    labels: new Map([
      ["aws", "AWS"],
      ["azure", "Azure"],
    ]),
  });
}

describe("CommitmentReportView legend", () => {
  it("names every drawn series and toggles one off and on", () => {
    render(<CommitmentReportView result={grouped()} initialMetric="coverage" />);
    const legend = screen.getByRole("list", { name: "Series" });
    const aws = within(legend).getByRole("button", { name: "AWS" });
    expect(within(legend).getByRole("button", { name: "Azure" })).toBeInTheDocument();
    expect(aws).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(aws);
    expect(aws).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(aws);
    expect(aws).toHaveAttribute("aria-pressed", "true");
  });

  it("has no legend for a single, ungrouped series", () => {
    const result = buildCommitmentReport([cell("", 40)], {
      from: "2026-10-01",
      to: "2026-10-01",
      granularity: "daily",
      groupBy: "none",
    });
    render(<CommitmentReportView result={result} initialMetric="coverage" />);
    expect(screen.queryByRole("list", { name: "Series" })).toBeNull();
  });
});

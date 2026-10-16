import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import {
  buildCommitmentReport,
  emptyCommitmentReportTotals,
  DEFAULT_COMMITMENT_REPORT_CONFIG,
  type CommitmentReport,
  type CommitmentReportOptions,
} from "@infrawrench/client-core";

import { CommitmentReportsSection } from "../commitment-reports/CommitmentReportsSection.js";
import type { CommitmentReportsClient } from "../commitment-reports/types.js";

const report: CommitmentReport = {
  id: "r1",
  name: "Savings plan coverage",
  description: null,
  config: { ...DEFAULT_COMMITMENT_REPORT_CONFIG, granularity: "daily", groupBy: "none" },
  folderId: null,
  createdByUserId: "u1",
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
};

const options: CommitmentReportOptions = {
  providers: [{ pluginId: "aws", displayName: "AWS", status: "measured" }],
  accounts: [],
  services: [],
  regions: [],
  commitments: [],
};

function client(overrides: Partial<CommitmentReportsClient> = {}): CommitmentReportsClient {
  const result = buildCommitmentReport(
    [
      {
        bucket: "2026-10-01",
        groupKey: "",
        currency: "USD",
        ...emptyCommitmentReportTotals(),
        covered: 30,
        coveredAll: 30,
        uncovered: 70,
      },
    ],
    { from: "2026-10-01", to: "2026-10-02", granularity: "daily", groupBy: "none" },
  );
  return {
    listReports: vi.fn(async () => [report]),
    runReport: vi.fn(async () => ({ ...result, reportId: report.id, name: report.name })),
    getOptions: vi.fn(async () => options),
    listFolders: vi.fn(async () => []),
    ...overrides,
  };
}

describe("CommitmentReportsSection", () => {
  it("renders nothing for an org with no commitment provider and no reports", async () => {
    const c = client({
      listReports: vi.fn(async () => []),
      getOptions: vi.fn(async () => ({ ...options, providers: [] })),
    });
    const { container } = render(<CommitmentReportsSection client={c} />);
    await waitFor(() => expect(c.getOptions).toHaveBeenCalled());
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  it("opens a report and prints a dash, never 0%, for a bucket with nothing to measure", async () => {
    const c = client();
    render(<CommitmentReportsSection client={c} />);
    fireEvent.click(await screen.findByText("Savings plan coverage"));
    const table = await screen.findByRole("table");
    expect(c.runReport).toHaveBeenCalledWith("r1");
    const rows = within(table).getAllByRole("row");
    // Header, two days, total.
    expect(rows).toHaveLength(4);
    expect(within(rows[1]!).getAllByText("30.0%").length).toBeGreaterThan(0);
    expect(within(rows[2]!).getAllByText("—").length).toBeGreaterThan(0);
  });

  it("hides the write actions when the host does not wire them", async () => {
    render(<CommitmentReportsSection client={client()} />);
    await screen.findByText("Savings plan coverage");
    expect(screen.queryByText("New report")).toBeNull();
  });

  it("offers New report when creating is wired", async () => {
    render(<CommitmentReportsSection client={client({ createReport: vi.fn() })} />);
    expect(await screen.findByText("New report")).toBeInTheDocument();
  });
});

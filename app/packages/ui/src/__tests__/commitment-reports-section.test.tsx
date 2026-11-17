import { beforeAll, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";

beforeAll(() => {
  // jsdom doesn't implement <dialog> showModal/close: stub them, as the other
  // section tests do. The editor renders through Modal.
  if (!HTMLDialogElement.prototype.showModal) {
    HTMLDialogElement.prototype.showModal = function () {
      this.open = true;
    };
  }
  if (!HTMLDialogElement.prototype.close) {
    HTMLDialogElement.prototype.close = function () {
      this.open = false;
    };
  }
});
import {
  buildCommitmentReport,
  emptyCommitmentReportTotals,
  DEFAULT_COMMITMENT_REPORT_CONFIG,
  type CommitmentReport,
  type CommitmentReportInput,
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

  it("offers New report when creating is wired, with a picker behind every filter", async () => {
    render(<CommitmentReportsSection client={client({ createReport: vi.fn() })} />);
    fireEvent.click(await screen.findByText("New report"));
    expect(
      await screen.findByText("New commitment report", { selector: "h2" }),
    ).toBeInTheDocument();
    for (const label of [
      "Providers",
      "Commitment types",
      "Accounts",
      "Services",
      "Regions",
      "Commitments",
    ]) {
      // Filters wait behind their "add" pill; adding one shows its picker.
      expect(screen.queryByLabelText(label)).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: label }));
      expect(screen.getAllByLabelText(label).length).toBeGreaterThan(0);
    }
  });

  it("saves the canonical input the request schema accepts", async () => {
    const createReport = vi.fn(async (input: CommitmentReportInput) => ({
      ...report,
      id: "r2",
      name: input.name,
      config: input.config,
    }));
    render(<CommitmentReportsSection client={client({ createReport })} />);
    fireEvent.click(await screen.findByText("New report"));
    fireEvent.change(await screen.findByLabelText("Name"), {
      target: { value: "  Coverage by account  " },
    });
    fireEvent.click(screen.getByText("Create report"));
    await waitFor(() => expect(createReport).toHaveBeenCalled());
    // Trimmed, with no empty filter lists and no blank description.
    expect(createReport.mock.calls[0]![0]).toEqual({
      name: "Coverage by account",
      description: null,
      config: DEFAULT_COMMITMENT_REPORT_CONFIG,
      folderId: null,
    });
  });

  it("refuses a blank name with the schema's message and sends nothing", async () => {
    const createReport = vi.fn();
    render(<CommitmentReportsSection client={client({ createReport })} />);
    fireEvent.click(await screen.findByText("New report"));
    fireEvent.click(await screen.findByText("Create report"));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(createReport).not.toHaveBeenCalled();
  });
});

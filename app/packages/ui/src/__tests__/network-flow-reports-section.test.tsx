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
  buildNetworkFlowReport,
  emptyNetworkFlowReportTotals,
  DEFAULT_NETWORK_FLOW_REPORT_CONFIG,
  NETWORK_FLOW_PAIR_SEPARATOR,
  type NetworkFlowReport,
  type NetworkFlowReportOptions,
} from "@infrawrench/client-core";

import { NetworkFlowReportsSection } from "../network-flow-reports/NetworkFlowReportsSection.js";
import type { NetworkFlowReportsClient } from "../network-flow-reports/types.js";

const report: NetworkFlowReport = {
  id: "r1",
  name: "Cross-zone by pair",
  description: null,
  config: { ...DEFAULT_NETWORK_FLOW_REPORT_CONFIG, groupBy: "pair", metric: "both" },
  folderId: null,
  createdByUserId: "u1",
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
};

const options: NetworkFlowReportOptions = {
  accounts: [{ id: "a1", name: "Prod", pluginId: "aws", recut: false }],
  networks: ["vpc-1"],
  regions: ["us-east-1"],
  zones: ["use1-az1", "use1-az2"],
  services: [],
  resourceTypes: [],
  endpoints: [],
  trafficClasses: ["cross_zone"],
};

const pairKey = `i-web${NETWORK_FLOW_PAIR_SEPARATOR}i-db`;

function client(overrides: Partial<NetworkFlowReportsClient> = {}): NetworkFlowReportsClient {
  const totals = (bytes: number, estimatedCost: number, sampledBytes = 0) => ({
    ...emptyNetworkFlowReportTotals(),
    bytes,
    estimatedCost,
    sampledBytes,
  });
  const result = buildNetworkFlowReport({
    from: "2026-10-01",
    to: "2026-10-02",
    granularity: "daily",
    groupBy: "pair",
    metric: "both",
    overallCells: [
      { bucket: "2026-10-01", groupKey: "", currency: "USD", ...totals(4e9, 0.04, 1e9) },
    ],
    seriesCells: [
      { bucket: "2026-10-01", groupKey: pairKey, currency: "USD", ...totals(4e9, 0.04, 1e9) },
    ],
    groups: [
      {
        groupKey: pairKey,
        label: "web → db",
        currency: "USD",
        pairCount: 1,
        ...totals(4e9, 0.04, 1e9),
      },
    ],
    topTalkers: [],
    topN: 25,
  });
  return {
    listReports: vi.fn(async () => [report]),
    runReport: vi.fn(async () => ({ ...result, reportId: report.id, name: report.name })),
    getOptions: vi.fn(async () => options),
    listFolders: vi.fn(async () => []),
    ...overrides,
  };
}

describe("NetworkFlowReportsSection", () => {
  it("renders nothing for an org with no flow-capable account and no reports", async () => {
    const c = client({
      listReports: vi.fn(async () => []),
      getOptions: vi.fn(async () => ({ ...options, accounts: [] })),
    });
    const { container } = render(<NetworkFlowReportsSection client={c} />);
    await waitFor(() => expect(c.getOptions).toHaveBeenCalled());
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  it("opens a report with bytes, cost, a sampling mark and the pair's labels", async () => {
    const c = client();
    render(<NetworkFlowReportsSection client={c} />);
    fireEvent.click(await screen.findByText("Cross-zone by pair"));
    const table = await screen.findByRole("table");
    expect(c.runReport).toHaveBeenCalledWith("r1");
    const rows = within(table).getAllByRole("row");
    // Header plus the one pair.
    expect(rows).toHaveLength(2);
    expect(within(rows[1]!).getByText(/web → db/)).toBeInTheDocument();
    expect(within(rows[1]!).getByText("4.0 GB")).toBeInTheDocument();
    expect(within(rows[1]!).getByText("25% sampled")).toBeInTheDocument();
    expect(screen.getByText("Export pairs CSV")).toBeInTheDocument();
    // The sampling notice is raised from the data.
    expect(screen.getByText(/flow source that samples traffic/)).toBeInTheDocument();
  });

  it("hides the write actions when the host does not wire them", async () => {
    render(<NetworkFlowReportsSection client={client()} />);
    await screen.findByText("Cross-zone by pair");
    expect(screen.queryByText("New report")).toBeNull();
  });

  it("offers New report when creating is wired, with pickers for every filter", async () => {
    render(<NetworkFlowReportsSection client={client({ createReport: vi.fn() })} />);
    fireEvent.click(await screen.findByText("New report"));
    expect(
      await screen.findByText("New network flow report", { selector: "h2" }),
    ).toBeInTheDocument();
    for (const label of [
      "Accounts",
      "Traffic classes",
      "Direction",
      "VPCs / networks",
      "Regions",
      "Availability zones",
      "Sources",
      "Destinations",
      "Peer services",
      "Peer resource types",
    ]) {
      expect(screen.getAllByLabelText(label).length).toBeGreaterThan(0);
    }
  });
});

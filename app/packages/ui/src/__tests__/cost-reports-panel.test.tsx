import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { CostReportsPanel } from "../cost-reports/CostReportsPanel.js";
import type { CostReportsClient } from "../cost-reports/types.js";
import {
  DEFAULT_COST_GRAPH_CONFIG,
  costReportInputSchema,
  costReportWidgetConfigSchema,
  widgetConfigSchemaFor,
  type CostReport,
} from "../cost/config.js";

function report(overrides: Partial<CostReport> = {}): CostReport {
  return {
    id: "r1",
    name: "Monthly spend",
    description: null,
    config: DEFAULT_COST_GRAPH_CONFIG,
    folderId: null,
    createdByUserId: "u1",
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    placements: [],
    ...overrides,
  };
}

function makeClient(
  rows: CostReport[],
  overrides: Partial<CostReportsClient> = {},
): CostReportsClient {
  return {
    queryCosts: vi.fn(async () => ({ series: [], currencies: [], totals: {} })),
    loadDimensionValues: vi.fn(async () => []),
    loadCostStatus: vi.fn(async () => []),
    listReports: vi.fn(async () => rows),
    getReport: vi.fn(async () => rows[0]!),
    ...overrides,
  } as unknown as CostReportsClient;
}

describe("cost report schemas", () => {
  it("registers cost_report in the widget-config map", () => {
    // `widgetConfigSchemaFor` is `satisfies`-checked against the kind union, so
    // this only fails if the kind was added without its schema.
    expect(widgetConfigSchemaFor("cost_report")).toBe(costReportWidgetConfigSchema);
  });

  it("requires a reportId on a cost_report widget config", () => {
    expect(costReportWidgetConfigSchema.safeParse({ version: 1, reportId: "r1" }).success).toBe(
      true,
    );
    expect(costReportWidgetConfigSchema.safeParse({ version: 1 }).success).toBe(false);
    expect(costReportWidgetConfigSchema.safeParse({ version: 1, reportId: "" }).success).toBe(
      false,
    );
  });

  it("accepts a null folderId so a report can be moved out of a folder", () => {
    const parsed = costReportInputSchema.safeParse({
      name: "Spend",
      config: DEFAULT_COST_GRAPH_CONFIG,
      folderId: null,
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects a blank name and a malformed config", () => {
    expect(
      costReportInputSchema.safeParse({ name: "", config: DEFAULT_COST_GRAPH_CONFIG }).success,
    ).toBe(false);
    expect(costReportInputSchema.safeParse({ name: "Spend", config: { version: 1 } }).success).toBe(
      false,
    );
  });
});

describe("CostReportsPanel", () => {
  beforeEach(() => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    vi.spyOn(window, "prompt").mockReturnValue("Renamed");
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("lists the org's reports", async () => {
    render(<CostReportsPanel client={makeClient([report()])} />);
    expect(await screen.findByText("Monthly spend")).toBeTruthy();
  });

  it("says a report is on no dashboard rather than showing nothing", async () => {
    render(<CostReportsPanel client={makeClient([report()])} />);
    expect(await screen.findByText("On no dashboard")).toBeTruthy();
  });

  it("names the dashboard when there is exactly one placement", async () => {
    render(
      <CostReportsPanel
        client={makeClient([
          report({ placements: [{ widgetId: "w1", dashboardId: "d1", dashboardName: "Prod" }] }),
        ])}
      />,
    );
    expect(await screen.findByText("On Prod")).toBeTruthy();
  });

  it("hides every mutating control when the host can't write", async () => {
    // A viewer without costs:write gets a client with no mutating half; the
    // panel must render read-only rather than offer controls that 403.
    render(<CostReportsPanel client={makeClient([report()])} />);
    await screen.findByText("Monthly spend");
    expect(screen.queryByText("New report")).toBeNull();
    expect(screen.queryByText("Delete")).toBeNull();
    expect(screen.queryByText("Duplicate")).toBeNull();
  });

  it("offers create/rename/duplicate/delete when the host can write", async () => {
    const client = makeClient([report()], {
      createReport: vi.fn(async () => report({ id: "r2" })),
      updateReport: vi.fn(async () => report()),
      deleteReport: vi.fn(async () => {}),
    });
    render(<CostReportsPanel client={client} />);
    await screen.findByText("Monthly spend");
    expect(screen.getByText("New report")).toBeTruthy();
    expect(screen.getByText("Rename")).toBeTruthy();
    expect(screen.getByText("Duplicate")).toBeTruthy();
    expect(screen.getByText("Delete")).toBeTruthy();
  });

  it("duplicates under a non-colliding name and opens the copy", async () => {
    const createReport = vi.fn(async () => report({ id: "r2", name: "Copy of Monthly spend" }));
    const onSelectReport = vi.fn();
    render(
      <CostReportsPanel
        client={makeClient([report(), report({ id: "rx", name: "Copy of Monthly spend" })], {
          createReport,
          updateReport: vi.fn(),
          deleteReport: vi.fn(),
        })}
        onSelectReport={onSelectReport}
      />,
    );
    await screen.findByText("Monthly spend");
    fireEvent.click(screen.getAllByText("Duplicate")[0]!);
    await waitFor(() =>
      expect(createReport).toHaveBeenCalledWith(
        expect.objectContaining({ name: "Copy of Monthly spend (2)" }),
      ),
    );
    await waitFor(() => expect(onSelectReport).toHaveBeenCalledWith("r2"));
  });

  it("warns which dashboards lose their card before deleting", async () => {
    const deleteReport = vi.fn(async () => {});
    render(
      <CostReportsPanel
        client={makeClient(
          [report({ placements: [{ widgetId: "w1", dashboardId: "d1", dashboardName: "Prod" }] })],
          { createReport: vi.fn(), updateReport: vi.fn(), deleteReport },
        )}
      />,
    );
    await screen.findByText("Monthly spend");
    fireEvent.click(screen.getByText("Delete"));
    await waitFor(() => expect(deleteReport).toHaveBeenCalledWith("r1"));
    expect(vi.mocked(window.confirm).mock.calls[0]?.[0]).toContain("Prod");
  });

  it("renders the detail view for the selected report", async () => {
    render(<CostReportsPanel client={makeClient([report()])} reportId="r1" />);
    expect(await screen.findByText("← All reports")).toBeTruthy();
  });

  it("surfaces a failed list rather than looking empty", async () => {
    const client = makeClient([], {
      listReports: vi.fn(async () => {
        throw new Error("boom");
      }),
    });
    render(<CostReportsPanel client={client} />);
    expect(await screen.findByRole("alert")).toBeTruthy();
  });
});

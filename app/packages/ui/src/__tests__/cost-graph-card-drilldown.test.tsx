import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { CostGraphCard } from "../cost/CostGraphCard.js";
import type { CostGraphConfig, CostQueryRequest, CostQueryResponse } from "../cost/config.js";
import type { CostApi } from "../cost/types.js";

/**
 * The dimension X axis, the comparison columns and drill-down on the card:
 * a table on a dimension axis lists one row per value, comparing adds the
 * previous, change and change % columns, and drilling narrows the query
 * without touching the saved config.
 */

const CONFIG: CostGraphConfig = {
  version: 1,
  chartType: "table",
  binning: "monthly",
  dateRange: { kind: "absolute", from: "2026-07-01", to: "2026-07-31" },
  groupBy: "provider",
  filters: [],
  topN: 5,
  comparePreviousPeriod: false,
  showForecast: false,
};

function makeApi(respond: (req: CostQueryRequest) => CostQueryResponse) {
  const queryCosts = vi.fn(async (req: CostQueryRequest) => respond(req));
  const api = {
    queryCosts,
    loadDimensionValues: vi.fn(async () => []),
    loadCostStatus: vi.fn(async () => []),
  } as unknown as CostApi;
  return { api, queryCosts };
}

const BY_PROVIDER: CostQueryResponse = {
  series: [
    { key: "aws", label: "AWS", currency: "USD", points: [{ bucket: "2026-07-01", amount: 120 }] },
    { key: "gcp", label: "GCP", currency: "USD", points: [{ bucket: "2026-07-01", amount: 30 }] },
  ],
  currencies: ["USD"],
  totals: { USD: 150 },
};

describe("CostGraphCard dimension axis", () => {
  it("lists one table row per value with previous, change and change % columns", async () => {
    const { api } = makeApi(() => ({
      series: [
        {
          key: "",
          label: "Total",
          currency: "USD",
          points: [
            { bucket: "ec2", amount: 120 },
            { bucket: "s3", amount: 30 },
          ],
        },
      ],
      comparison: [
        {
          key: "",
          label: "Total",
          currency: "USD",
          points: [
            { bucket: "ec2", amount: 100 },
            { bucket: "s3", amount: 40 },
          ],
        },
      ],
      currencies: ["USD"],
      totals: { USD: 150 },
      previousTotals: { USD: 140 },
      xAxis: {
        dimension: "service",
        segment: "none",
        values: [
          { key: "ec2", label: "EC2" },
          { key: "s3", label: "S3" },
        ],
      },
    }));
    render(
      <CostGraphCard
        title="Spend"
        config={{ ...CONFIG, xAxis: "service", groupBy: "none", comparePreviousPeriod: true }}
        api={api}
      />,
    );

    const table = await screen.findByRole("table");
    expect(within(table).getByRole("columnheader", { name: "Service" })).toBeInTheDocument();
    expect(within(table).getByRole("columnheader", { name: "Change %" })).toBeInTheDocument();
    const rows = within(table).getAllByRole("row");
    expect(rows).toHaveLength(3);
    expect(within(rows[1]!).getByRole("rowheader")).toHaveTextContent("EC2");
    expect(rows[1]!.textContent).toContain("+20.0%");
    expect(rows[2]!.textContent).toContain("−25.0%");
  });
});

describe("CostGraphCard drill-down", () => {
  it("drills from provider to service without changing the saved config", async () => {
    const { api, queryCosts } = makeApi(() => BY_PROVIDER);
    const config = { ...CONFIG };
    render(<CostGraphCard title="Spend" config={config} api={api} />);

    const table = await screen.findByRole("table");
    fireEvent.click(within(table).getByRole("button", { name: "AWS" }));

    await waitFor(() => expect(queryCosts).toHaveBeenCalledTimes(2));
    const drilled = queryCosts.mock.calls[1]![0];
    expect(drilled.groupBy).toBe("service");
    expect(drilled.filters).toEqual([{ dimension: "provider", op: "in", values: ["aws"] }]);
    expect(config.groupBy).toBe("provider");

    // The path bar shows where the view sits, and "All" steps back up.
    const nav = screen.getByRole("navigation", { name: "Drill-down path" });
    expect(within(nav).getByText("AWS")).toHaveAttribute("aria-current", "page");
    fireEvent.click(within(nav).getByRole("button", { name: "All" }));
    await waitFor(() => expect(queryCosts).toHaveBeenCalledTimes(3));
    expect(queryCosts.mock.calls[2]![0].groupBy).toBe("provider");
  });

  it("drills from the keyboard select and asks where to go next for a tag", async () => {
    const { api, queryCosts } = makeApi(() => ({
      ...BY_PROVIDER,
      series: [
        {
          key: "web",
          label: "web",
          currency: "USD",
          points: [{ bucket: "2026-07-01", amount: 5 }],
        },
      ],
    }));
    render(
      <CostGraphCard
        title="Spend"
        config={{ ...CONFIG, groupBy: "tag", groupByTagKey: "team" }}
        api={api}
      />,
    );

    const select = await screen.findByRole("combobox", { name: "Drill into a value" });
    fireEvent.change(select, { target: { value: "web" } });

    const choices = await screen.findByRole("group", { name: "Break web down by:" });
    // Focus lands on the first choice so a keyboard drill carries on.
    expect(within(choices).getByRole("button", { name: "Provider" })).toHaveFocus();
    const service = within(choices).getByRole("button", { name: "Service" });
    fireEvent.click(service);

    await waitFor(() => expect(queryCosts).toHaveBeenCalledTimes(2));
    const drilled = queryCosts.mock.calls[1]![0];
    expect(drilled.groupBy).toBe("service");
    expect(drilled.filters).toEqual([
      { dimension: "tag", op: "in", values: ["web"], tagKey: "team" },
    ]);
  });

  it("saves the drilled view as a new report under the path's name", async () => {
    const { api } = makeApi(() => BY_PROVIDER);
    const onSaveAsReport = vi.fn(async () => {});
    render(
      <CostGraphCard title="Spend" config={CONFIG} api={api} onSaveAsReport={onSaveAsReport} />,
    );

    const table = await screen.findByRole("table");
    fireEvent.click(within(table).getByRole("button", { name: "GCP" }));
    fireEvent.click(await screen.findByRole("button", { name: "Save as new report" }));

    await waitFor(() => expect(onSaveAsReport).toHaveBeenCalledTimes(1));
    const [saved, name] = onSaveAsReport.mock.calls[0] as unknown as [CostGraphConfig, string];
    expect(name).toBe("Spend › GCP");
    expect(saved.groupBy).toBe("service");
    expect(saved.filters).toEqual([{ dimension: "provider", op: "in", values: ["gcp"] }]);
    expect(await screen.findByText("Saved as a new report.")).toBeInTheDocument();
  });

  it("offers no drill on an ungrouped chart", async () => {
    const { api } = makeApi(() => ({
      series: [
        { key: "", label: "Total", currency: "USD", points: [{ bucket: "2026-07-01", amount: 1 }] },
      ],
      currencies: ["USD"],
      totals: { USD: 1 },
    }));
    render(<CostGraphCard title="Spend" config={{ ...CONFIG, groupBy: "none" }} api={api} />);
    await screen.findByRole("table");
    expect(screen.queryByRole("combobox", { name: "Drill into a value" })).toBeNull();
  });
});

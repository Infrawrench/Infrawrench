import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { CostGraphCard } from "../cost/CostGraphCard.js";
import type { CostAnnotation, CostGraphConfig, CostQueryResponse } from "../cost/config.js";
import type { CostApi } from "../cost/types.js";

const CONFIG: CostGraphConfig = {
  version: 1,
  chartType: "stacked_bar",
  binning: "daily",
  dateRange: { kind: "absolute", from: "2026-07-13", to: "2026-07-15" },
  groupBy: "provider",
  filters: [],
  topN: 5,
  comparePreviousPeriod: false,
  showForecast: false,
};

const RESPONSE: CostQueryResponse = {
  series: [
    {
      key: "aws",
      label: "AWS",
      currency: "USD",
      points: [
        { bucket: "2026-07-13", amount: 100 },
        { bucket: "2026-07-14", amount: 200 },
        { bucket: "2026-07-15", amount: 300 },
      ],
    },
  ],
  currencies: ["USD"],
  totals: { USD: 600 },
};

function annotation(over: Partial<CostAnnotation> & { id: string }): CostAnnotation {
  return {
    startDate: "2026-07-14",
    endDate: null,
    text: "Migrated to Graviton",
    costReportId: null,
    createdByUserId: null,
    createdAt: "2026-07-14T00:00:00.000Z",
    updatedAt: "2026-07-14T00:00:00.000Z",
    ...over,
  };
}

function makeApi(annotations: CostAnnotation[], writable = false): CostApi {
  return {
    queryCosts: vi.fn(async () => RESPONSE),
    loadDimensionValues: vi.fn(async () => []),
    loadCostStatus: vi.fn(async () => []),
    listCostAnnotations: vi.fn(async () => annotations),
    ...(writable
      ? {
          createCostAnnotation: vi.fn(),
          updateCostAnnotation: vi.fn(),
          deleteCostAnnotation: vi.fn(),
        }
      : {}),
  } as unknown as CostApi;
}

describe("CostGraphCard annotations", () => {
  it("renders a keyboard-reachable marker per annotated bucket", async () => {
    render(
      <CostGraphCard title="Spend" config={CONFIG} api={makeApi([annotation({ id: "a" })])} />,
    );

    // A real <button>, named with its date and text — not a hover-only tooltip.
    const marker = await screen.findByRole("button", {
      name: /Annotation 1.*Migrated to Graviton/,
    });
    expect(marker.tagName).toBe("BUTTON");
  });

  it("collapses several notes on one bucket into one marker", async () => {
    render(
      <CostGraphCard
        title="Spend"
        config={CONFIG}
        api={makeApi([
          annotation({ id: "a", text: "Migrated to Graviton" }),
          annotation({ id: "b", text: "Turned on the new cache" }),
        ])}
      />,
    );

    const markers = await screen.findAllByRole("button", { name: /^Annotation \d/ });
    expect(markers).toHaveLength(1);
    expect(markers[0]!.getAttribute("aria-label")).toMatch(/and 1 more/);
  });

  it("says when a note came from explaining a detected anomaly", async () => {
    // Provenance where the note is read: a marker created by acknowledging an
    // anomaly can be checked against the finding it closed rather than taken
    // on trust. A hand-written note says nothing extra.
    render(
      <CostGraphCard
        title="Spend"
        config={CONFIG}
        api={makeApi([annotation({ id: "a", costAnomalyId: "anom-1" })])}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: /^Annotation 1/ }));
    expect(await screen.findByText(/Explains a detected anomaly/)).toBeTruthy();
  });

  it("says nothing extra for a note somebody wrote by hand", async () => {
    render(
      <CostGraphCard title="Spend" config={CONFIG} api={makeApi([annotation({ id: "a" })])} />,
    );

    fireEvent.click(await screen.findByRole("button", { name: /^Annotation 1/ }));
    // The popover is open — its scope line is there — and says nothing about
    // an anomaly, because nothing linked this note to one.
    expect(await screen.findByText(/Org-wide/)).toBeTruthy();
    expect(screen.queryByText(/Explains a detected anomaly/)).toBeNull();
  });

  it("draws nothing for a note outside the chart's window", async () => {
    render(
      <CostGraphCard
        title="Spend"
        config={CONFIG}
        api={makeApi([annotation({ id: "old", startDate: "2020-01-01" })])}
      />,
    );

    await screen.findByText("Spend");
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /^Annotation \d/ })).toBeNull(),
    );
  });

  it("leaves the headline total untouched by annotations", async () => {
    const { unmount } = render(<CostGraphCard title="Spend" config={CONFIG} api={makeApi([])} />);
    const bare = (await screen.findByText(/\$600/)).textContent;
    unmount();

    render(
      <CostGraphCard
        title="Spend"
        config={CONFIG}
        api={makeApi([annotation({ id: "a" }), annotation({ id: "b", startDate: "2026-07-15" })])}
      />,
    );
    expect((await screen.findByText(/\$600/)).textContent).toBe(bare);
  });

  it("offers no writing controls to a host without the mutating calls", async () => {
    render(
      <CostGraphCard title="Spend" config={CONFIG} api={makeApi([annotation({ id: "a" })])} />,
    );

    await screen.findByRole("button", { name: /^Annotation 1/ });
    expect(screen.queryByRole("button", { name: "+ Annotate" })).toBeNull();
  });

  it("offers an annotate control once the host can write", async () => {
    render(<CostGraphCard title="Spend" config={CONFIG} api={makeApi([], true)} />);
    expect(await screen.findByRole("button", { name: "+ Annotate" })).toBeTruthy();
  });

  it("renders exactly as before when the host has no annotation reads at all", async () => {
    const api = {
      queryCosts: vi.fn(async () => RESPONSE),
      loadDimensionValues: vi.fn(async () => []),
      loadCostStatus: vi.fn(async () => []),
    } as unknown as CostApi;

    render(<CostGraphCard title="Spend" config={CONFIG} api={api} />);
    await screen.findByText(/\$600/);
    expect(screen.queryByRole("button", { name: /^Annotation \d/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "+ Annotate" })).toBeNull();
  });
});

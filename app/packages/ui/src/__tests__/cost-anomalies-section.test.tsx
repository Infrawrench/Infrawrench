import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { CostAnomaliesSection } from "../cost/CostAnomaliesSection.js";
import type { CostAnomaly, CostAnomalySettings, CostsClient } from "../cost/types.js";

function anomaly(overrides: Partial<CostAnomaly> = {}): CostAnomaly {
  return {
    id: "a1",
    day: "2026-07-30",
    kind: "spike",
    dimension: "service",
    dimensionKey: "Amazon EC2",
    currency: "USD",
    actualCents: 27_300,
    baselineCents: 10_000,
    thresholdCents: 15_000,
    detectedAt: "2026-07-31T02:00:00.000Z",
    notifiedAt: null,
    ...overrides,
  };
}

const DEFAULTS: CostAnomalySettings = {
  sigmas: 3,
  minDeltaCents: 1000,
  newSourceMinCents: 2500,
};

function makeClient(rows: CostAnomaly[], overrides: Partial<CostsClient> = {}): CostsClient {
  return {
    queryCosts: vi.fn(),
    loadDimensionValues: vi.fn(async () => []),
    loadCostStatus: vi.fn(async () => []),
    listBudgets: vi.fn(async () => []),
    listDashboards: vi.fn(async () => []),
    listAnomalies: vi.fn(async () => rows),
    ...overrides,
  } as unknown as CostsClient;
}

describe("CostAnomaliesSection", () => {
  it("shows the percentage change for a spike", async () => {
    render(<CostAnomaliesSection client={makeClient([anomaly()])} />);
    expect(await screen.findByText("+173%")).toBeTruthy();
  });

  it("renders a new spend source as new rather than an infinite jump", async () => {
    render(
      <CostAnomaliesSection
        client={makeClient([
          anomaly({ kind: "new_source", baselineCents: 0, thresholdCents: 2500 }),
        ])}
      />,
    );
    expect(await screen.findByText("New source")).toBeTruthy();
    expect(screen.getByText("new")).toBeTruthy();
    // No baseline is reported as an absence, not as $0.00.
    expect(screen.getByText("none")).toBeTruthy();
    expect(screen.queryByText(/Infinity|NaN|%/)).toBeNull();
  });

  it("never prints a percentage for a new source whose baseline rounded to a cent", async () => {
    render(
      <CostAnomaliesSection
        client={makeClient([anomaly({ kind: "new_source", baselineCents: 1 })])}
      />,
    );
    expect(await screen.findByText("new")).toBeTruthy();
    expect(screen.queryByText(/%/)).toBeNull();
  });

  it("hides the tuning controls when the host can't read settings", async () => {
    render(<CostAnomaliesSection client={makeClient([anomaly()])} />);
    await screen.findByText("+173%");
    expect(screen.queryByText("Tune detection")).toBeNull();
  });

  it("saves edited thresholds through the host client", async () => {
    const updateAnomalySettings = vi.fn(async (s: CostAnomalySettings) => s);
    const client = makeClient([anomaly()], {
      getAnomalySettings: vi.fn(async () => DEFAULTS),
      updateAnomalySettings,
    });

    render(<CostAnomaliesSection client={client} />);
    fireEvent.click(await screen.findByText("Tune detection"));

    const sigmas = (await screen.findByLabelText(/Sensitivity/)) as HTMLInputElement;
    fireEvent.change(sigmas, { target: { value: "2" } });
    fireEvent.click(screen.getByText("Save"));

    await waitFor(() =>
      expect(updateAnomalySettings).toHaveBeenCalledWith({ ...DEFAULTS, sigmas: 2 }),
    );
  });

  it("edits the new-source floor in dollars and sends cents", async () => {
    const updateAnomalySettings = vi.fn(async (s: CostAnomalySettings) => s);
    const client = makeClient([], {
      getAnomalySettings: vi.fn(async () => DEFAULTS),
      updateAnomalySettings,
    });

    render(<CostAnomaliesSection client={client} />);
    fireEvent.click(await screen.findByText("Tune detection"));

    const floor = (await screen.findByLabelText(/New-source floor/)) as HTMLInputElement;
    expect(floor.value).toBe("25");
    fireEvent.change(floor, { target: { value: "100" } });
    fireEvent.click(screen.getByText("Save"));

    await waitFor(() =>
      expect(updateAnomalySettings).toHaveBeenCalledWith({
        ...DEFAULTS,
        newSourceMinCents: 10_000,
      }),
    );
  });

  it("renders the tuning panel read-only without a save call", async () => {
    const client = makeClient([], { getAnomalySettings: vi.fn(async () => DEFAULTS) });
    render(<CostAnomaliesSection client={client} />);
    fireEvent.click(await screen.findByText("Tune detection"));

    const sigmas = (await screen.findByLabelText(/Sensitivity/)) as HTMLInputElement;
    expect(sigmas.disabled).toBe(true);
    expect(screen.queryByText("Save")).toBeNull();
  });

  it("refuses to save a sigma outside the bounds the API enforces", async () => {
    const updateAnomalySettings = vi.fn(async (s: CostAnomalySettings) => s);
    const client = makeClient([], {
      getAnomalySettings: vi.fn(async () => DEFAULTS),
      updateAnomalySettings,
    });

    render(<CostAnomaliesSection client={client} />);
    fireEvent.click(await screen.findByText("Tune detection"));

    const sigmas = (await screen.findByLabelText(/Sensitivity/)) as HTMLInputElement;
    fireEvent.change(sigmas, { target: { value: "0" } });
    fireEvent.click(screen.getByText("Save"));

    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(updateAnomalySettings).not.toHaveBeenCalled();
  });
});

import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { CostAnomaliesSection } from "../cost/CostAnomaliesSection.js";
import type { CostAnomalySettings, CostAnomalySettingsView } from "../cost/config.js";
import type { CostAnomaly, CostsClient } from "../cost/types.js";

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
  smsAlerts: "off",
};

/** What the settings endpoint answers with: the stored fields plus the derived one. */
const VIEW: CostAnomalySettingsView = { ...DEFAULTS, smsConfigured: true };

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

  it("renders root-cause hints under the anomaly, when the server sent any", async () => {
    render(
      <CostAnomaliesSection
        client={makeClient([
          anomaly({
            hints: ["12 gce-instance resources appeared", 'Astrid ran workflow "Nightly rebuild"'],
          }),
        ])}
      />,
    );
    expect(await screen.findByText(/12 gce-instance resources appeared/)).toBeTruthy();
    expect(screen.getByText(/ran workflow "Nightly rebuild"/)).toBeTruthy();
  });

  it("renders a row from an older server that sent no hints field at all", async () => {
    // `hints` is optional on the wire — a desktop build a release ahead of its
    // cloud server must not crash the section.
    render(<CostAnomaliesSection client={makeClient([anomaly()])} />);
    expect(await screen.findByText("+173%")).toBeTruthy();
  });

  it("hides the tuning controls when the host can't read settings", async () => {
    render(<CostAnomaliesSection client={makeClient([anomaly()])} />);
    await screen.findByText("+173%");
    expect(screen.queryByText("Tune detection")).toBeNull();
  });

  it("saves edited thresholds through the host client", async () => {
    const updateAnomalySettings = vi.fn(async (s: CostAnomalySettings) => ({
      ...s,
      smsConfigured: true,
    }));
    const client = makeClient([anomaly()], {
      getAnomalySettings: vi.fn(async () => VIEW),
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
    const updateAnomalySettings = vi.fn(async (s: CostAnomalySettings) => ({
      ...s,
      smsConfigured: true,
    }));
    const client = makeClient([], {
      getAnomalySettings: vi.fn(async () => VIEW),
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
    const client = makeClient([], { getAnomalySettings: vi.fn(async () => VIEW) });
    render(<CostAnomaliesSection client={client} />);
    fireEvent.click(await screen.findByText("Tune detection"));

    const sigmas = (await screen.findByLabelText(/Sensitivity/)) as HTMLInputElement;
    expect(sigmas.disabled).toBe(true);
    expect(screen.queryByText("Save")).toBeNull();
  });

  it("defaults the SMS control to off and saves the chosen mode", async () => {
    const updateAnomalySettings = vi.fn(async (s: CostAnomalySettings) => ({
      ...s,
      smsConfigured: true,
    }));
    const client = makeClient([], {
      getAnomalySettings: vi.fn(async () => VIEW),
      updateAnomalySettings,
    });

    render(<CostAnomaliesSection client={client} />);
    fireEvent.click(await screen.findByText("Tune detection"));

    const sms = (await screen.findByLabelText(/Text the on-call list/)) as HTMLSelectElement;
    expect(sms.value).toBe("off");
    fireEvent.change(sms, { target: { value: "new_source" } });
    fireEvent.click(screen.getByText("Save"));

    await waitFor(() =>
      // `smsConfigured` is derived server-side and must not be echoed back.
      expect(updateAnomalySettings).toHaveBeenCalledWith({ ...DEFAULTS, smsAlerts: "new_source" }),
    );
  });

  it("says so when the org can't actually receive an SMS", async () => {
    const client = makeClient([], {
      getAnomalySettings: vi.fn(async () => ({ ...VIEW, smsConfigured: false })),
      updateAnomalySettings: vi.fn(async (s: CostAnomalySettings) => ({
        ...s,
        smsConfigured: false,
      })),
    });

    render(<CostAnomaliesSection client={client} />);
    fireEvent.click(await screen.findByText("Tune detection"));

    const sms = (await screen.findByLabelText(/Text the on-call list/)) as HTMLSelectElement;
    // Nothing is wrong until the org asks for texts it cannot receive.
    expect(screen.queryByText(/can.t receive SMS/)).toBeNull();

    fireEvent.change(sms, { target: { value: "all" } });
    expect(await screen.findByText(/can.t receive SMS/)).toBeTruthy();
  });

  it("refuses to save a sigma outside the bounds the API enforces", async () => {
    const updateAnomalySettings = vi.fn(async (s: CostAnomalySettings) => ({
      ...s,
      smsConfigured: true,
    }));
    const client = makeClient([], {
      getAnomalySettings: vi.fn(async () => VIEW),
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

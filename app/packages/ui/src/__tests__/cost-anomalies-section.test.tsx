import { beforeAll, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

beforeAll(() => {
  // jsdom doesn't implement <dialog> showModal/close — stub them, the way
  // issue-filing.test.tsx does. The explain composer renders through Modal.
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

/** An anomaly somebody has already explained. */
function explained(overrides: Partial<CostAnomaly> = {}): CostAnomaly {
  return anomaly({
    acknowledgement: {
      explanation: "Migrated the API fleet to Graviton",
      acknowledgedAt: "2026-08-01T09:00:00.000Z",
      acknowledgedByUserId: "user-1",
      annotationId: "ann-1",
    },
    ...overrides,
  });
}

describe("CostAnomaliesSection — explaining a finding", () => {
  it("offers nothing when the host can't acknowledge", async () => {
    render(<CostAnomaliesSection client={makeClient([anomaly()])} />);
    await screen.findByText("+173%");
    expect(screen.queryByText("Explain")).toBeNull();
  });

  it("opens a composer prefilled with what the row already knows", async () => {
    const client = makeClient([anomaly()], { acknowledgeAnomaly: vi.fn() });
    render(<CostAnomaliesSection client={client} />);

    fireEvent.click(await screen.findByText("Explain"));

    const box = (await screen.findByLabelText("What happened")) as HTMLTextAreaElement;
    // A sentence to finish, not a blank page.
    expect(box.value).toBe("Amazon EC2 spend +173% — ");
    // …and the facts, so nobody has to hold the row in their head: the row
    // itself names the service, and so now does the composer.
    expect(screen.getAllByText("Amazon EC2")).toHaveLength(2);
    expect(screen.getByText(/against .*\/day/)).toBeTruthy();
    // No date or scope control: both are derived from the anomaly.
    expect(screen.queryByText("Every cost chart")).toBeNull();
  });

  it("fills the cause from a hint in one click", async () => {
    const client = makeClient([anomaly({ hints: ["12 gce-instance resources appeared"] })], {
      acknowledgeAnomaly: vi.fn(),
    });
    render(<CostAnomaliesSection client={client} />);
    fireEvent.click(await screen.findByText("Explain"));

    fireEvent.click(await screen.findByRole("button", { name: /12 gce-instance resources/ }));
    const box = (await screen.findByLabelText("What happened")) as HTMLTextAreaElement;
    expect(box.value).toBe("Amazon EC2 spend +173% — 12 gce-instance resources appeared");
  });

  it("sends the sentence and shows it on the row without a refetch", async () => {
    const listAnomalies = vi.fn(async () => [anomaly()]);
    const acknowledgeAnomaly = vi.fn(async (_id: string, explanation: string) =>
      explained({
        acknowledgement: {
          explanation,
          acknowledgedAt: "2026-08-01T09:00:00.000Z",
          acknowledgedByUserId: "user-1",
          annotationId: "ann-1",
        },
      }),
    );
    const client = makeClient([], { listAnomalies, acknowledgeAnomaly });

    render(<CostAnomaliesSection client={client} />);
    fireEvent.click(await screen.findByText("Explain"));
    fireEvent.change(await screen.findByLabelText("What happened"), {
      target: { value: "Migrated the API fleet to Graviton" },
    });
    fireEvent.click(screen.getByText("Explain", { selector: "button.bg-blue-600" }));

    await waitFor(() =>
      expect(acknowledgeAnomaly).toHaveBeenCalledWith("a1", "Migrated the API fleet to Graviton"),
    );
    // The answer is the response, not a second listing.
    expect(await screen.findByText(/Migrated the API fleet to Graviton/)).toBeTruthy();
    expect(listAnomalies).toHaveBeenCalledTimes(1);
  });

  it("marks an explained row and counts only the open ones", async () => {
    const client = makeClient([explained(), anomaly({ id: "a2", dimensionKey: "Amazon S3" })], {
      acknowledgeAnomaly: vi.fn(),
    });
    render(<CostAnomaliesSection client={client} />);

    expect(await screen.findByText("Explained")).toBeTruthy();
    expect(screen.getByText("1 unexplained")).toBeTruthy();
    // Marked, never hidden: the detection record is the point.
    expect(screen.getByText("Amazon EC2")).toBeTruthy();
    expect(screen.getByText(/Migrated the API fleet/)).toBeTruthy();
  });

  it("stays explained, and says the marker is gone, after the note is deleted", async () => {
    const client = makeClient(
      [
        explained({
          acknowledgement: {
            explanation: "Migrated the API fleet to Graviton",
            acknowledgedAt: "2026-08-01T09:00:00.000Z",
            acknowledgedByUserId: "user-1",
            annotationId: null,
          },
        }),
      ],
      { acknowledgeAnomaly: vi.fn() },
    );
    render(<CostAnomaliesSection client={client} />);

    expect(await screen.findByText("Explained")).toBeTruthy();
    expect(screen.getByText("all explained")).toBeTruthy();
    expect(screen.getByText(/note removed from charts/)).toBeTruthy();
  });

  it("rewords the existing note rather than promising a second one", async () => {
    const client = makeClient([explained()], { acknowledgeAnomaly: vi.fn() });
    render(<CostAnomaliesSection client={client} />);

    fireEvent.click(await screen.findByText("Edit explanation"));
    const box = (await screen.findByLabelText("What happened")) as HTMLTextAreaElement;
    // Opens on what was said, not on the prefill.
    expect(box.value).toBe("Migrated the API fleet to Graviton");
    expect(screen.getByText(/rewords the note already on the charts/)).toBeTruthy();
  });

  it("refuses an empty explanation locally, the way the API would", async () => {
    const acknowledgeAnomaly = vi.fn();
    const client = makeClient([anomaly()], { acknowledgeAnomaly });
    render(<CostAnomaliesSection client={client} />);
    fireEvent.click(await screen.findByText("Explain"));

    fireEvent.change(await screen.findByLabelText("What happened"), { target: { value: "   " } });
    const submit = screen.getByText("Explain", { selector: "button.bg-blue-600" });
    fireEvent.click(submit);
    expect(acknowledgeAnomaly).not.toHaveBeenCalled();
  });
});

import { beforeAll, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

beforeAll(() => {
  // jsdom doesn't implement <dialog> showModal/close — stub them, the way
  // issue-filing.test.tsx does. The editor renders through Modal.
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

import { ScenarioModelsSection } from "../cost/ScenarioModelsSection.js";
import type { CostScenarioAdjustment, CostScenarioModel } from "../cost/config.js";
import type { CostsClient } from "../cost/types.js";

/**
 * Scenario amounts and percentages are numbers a person types, and the two
 * states an `<input type="number">` produces mid-edit — cleared, and half-typed
 * — are exactly the two that must never be stored. `Number("")` is `0`, so a
 * field cleared to be retyped would silently persist "adjust spend by nothing";
 * `Number("-")` is `NaN`, which travels into the request body. Both mean "keep
 * what is there and wait for the rest of the keystrokes"; a deliberately typed
 * `0` is a different thing and must reach the model.
 */

const AMOUNT_ADJUSTMENT: CostScenarioAdjustment = {
  id: "adj-1",
  label: "Licence",
  kind: "one_off",
  startDate: "2026-09-01",
  endDate: null,
  amountCents: 5000,
  currency: "USD",
  period: null,
  percent: null,
  scope: [],
};

function model(over: Partial<CostScenarioModel> = {}): CostScenarioModel {
  return {
    id: "model-1",
    name: "Q4 plan",
    description: null,
    currency: "USD",
    adjustments: [AMOUNT_ADJUSTMENT],
    createdByUserId: null,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    ...over,
  };
}

function makeClient(models: CostScenarioModel[]) {
  const updateScenarioModel = vi.fn(async () => models[0]!);
  const client = {
    loadDimensionValues: vi.fn(async () => []),
    loadCostStatus: vi.fn(async () => []),
    listScenarioModels: vi.fn(async () => models),
    getScenarioModelReferents: vi.fn(async () => []),
    createScenarioModel: vi.fn(async () => models[0]!),
    updateScenarioModel,
    deleteScenarioModel: vi.fn(async () => {}),
  } as unknown as CostsClient;
  return { client, updateScenarioModel };
}

async function openEditor(client: CostsClient) {
  render(<ScenarioModelsSection client={client} />);
  fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
  return await screen.findByRole("button", { name: "Save" });
}

/** The adjustments the last save posted. */
function savedAdjustments(mock: ReturnType<typeof vi.fn>): CostScenarioAdjustment[] {
  const [, input] = mock.mock.calls[0] as [string, { adjustments: CostScenarioAdjustment[] }];
  return input.adjustments;
}

describe("ScenarioModelEditModal numeric fields", () => {
  it("keeps the stored amount when the field is cleared or half-typed", async () => {
    const { client, updateScenarioModel } = makeClient([model()]);
    const save = await openEditor(client);

    const amount = screen.getByLabelText("Amount (USD)") as HTMLInputElement;
    expect(amount.value).toBe("50");

    fireEvent.change(amount, { target: { value: "" } });
    fireEvent.change(amount, { target: { value: "-" } });
    // Still the stored amount: neither state wrote a number nobody chose.
    expect(amount.value).toBe("50");

    fireEvent.click(save);
    await waitFor(() => expect(updateScenarioModel).toHaveBeenCalled());
    expect(savedAdjustments(updateScenarioModel)[0]?.amountCents).toBe(5000);
  });

  it("stores a typed amount, including a deliberate zero", async () => {
    const { client, updateScenarioModel } = makeClient([model()]);
    const save = await openEditor(client);

    const amount = screen.getByLabelText("Amount (USD)") as HTMLInputElement;
    fireEvent.change(amount, { target: { value: "12.34" } });
    fireEvent.click(save);

    await waitFor(() => expect(updateScenarioModel).toHaveBeenCalled());
    expect(savedAdjustments(updateScenarioModel)[0]?.amountCents).toBe(1234);
  });

  it("lets a typed zero reach the model, where the shared validator refuses it", async () => {
    const { client, updateScenarioModel } = makeClient([model()]);
    const save = await openEditor(client);

    const amount = screen.getByLabelText("Amount (USD)") as HTMLInputElement;
    fireEvent.change(amount, { target: { value: "0" } });
    expect(amount.value).toBe("0");

    fireEvent.click(save);

    // The zero was stored, not swallowed — which is why the form can say what
    // is wrong with it instead of saving an adjustment that does nothing.
    expect(await screen.findByText(/is for nothing/)).toBeInTheDocument();
    expect(updateScenarioModel).not.toHaveBeenCalled();
  });

  it("keeps the stored percent when a rate change's field is cleared", async () => {
    const { client, updateScenarioModel } = makeClient([
      model({
        adjustments: [
          {
            ...AMOUNT_ADJUSTMENT,
            kind: "rate_change",
            label: "Graviton migration",
            amountCents: null,
            currency: null,
            percent: -20,
          },
        ],
      }),
    ]);
    const save = await openEditor(client);

    const percent = screen.getByLabelText("Percent") as HTMLInputElement;
    expect(percent.value).toBe("-20");

    fireEvent.change(percent, { target: { value: "" } });
    expect(percent.value).toBe("-20");

    fireEvent.click(save);
    await waitFor(() => expect(updateScenarioModel).toHaveBeenCalled());
    expect(savedAdjustments(updateScenarioModel)[0]?.percent).toBe(-20);
  });
});

import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import { BudgetCard } from "../cost/BudgetCard.js";
import type { BudgetWithStatus } from "../cost/types.js";

function budget(events: BudgetWithStatus["currentMonthEvents"]): BudgetWithStatus {
  return {
    id: "b1",
    name: "Prod",
    amountCents: 1_000_000,
    currency: "USD",
    filters: [],
    thresholds: [{ type: "actual", percent: 80 }],
    costBasis: "cash",
    savedFilterId: null,
    scenarioModelId: null,
    scenarioModelName: null,
    useAdjustedSpend: false,
    rawActualCents: null,
    month: "2026-10",
    actualCents: 850_000,
    forecastCents: null,
    currentMonthEvents: events,
    placements: [],
  } as BudgetWithStatus;
}

const fired = {
  id: "e1",
  thresholdType: "actual" as const,
  thresholdPercent: 80,
  triggeredAt: "2026-10-03T14:05:00.000Z",
};

describe("BudgetCard notes", () => {
  it("shows a firing's note with its author", () => {
    render(
      <BudgetCard
        budget={budget([
          {
            ...fired,
            note: {
              text: "Q3 load test",
              notedAt: "2026-10-03T15:00:00.000Z",
              notedByUserId: "u1",
              notedByName: "Astrid",
              annotationId: "a1",
            },
          },
        ])}
      />,
    );
    expect(screen.getByText("Q3 load test")).toBeTruthy();
    expect(screen.getByText(/Astrid/)).toBeTruthy();
  });

  it("offers Explain on an unexplained firing when the host can write notes", () => {
    const onExplain = vi.fn();
    render(<BudgetCard budget={budget([{ ...fired, note: null }])} onExplain={onExplain} />);
    fireEvent.click(screen.getByText("Explain"));
    expect(onExplain).toHaveBeenCalledWith(expect.objectContaining({ id: "e1" }));
  });

  it("shows no firing list on a read-only host with nothing noted", () => {
    render(<BudgetCard budget={budget([{ ...fired, note: null }])} />);
    expect(screen.queryByText("Explain")).toBeNull();
  });
});

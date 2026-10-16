import { beforeAll, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

beforeAll(() => {
  // jsdom doesn't implement <dialog> showModal/close: stub them, the way
  // cost-scenario-models.test.tsx does. The editor renders through Modal.
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
import { CostGraphConfigModal } from "../../cost/CostGraphConfigModal.js";
import type { CostGraphConfig } from "../../cost/config.js";
import type { CostApi } from "../../cost/types.js";

/**
 * The editor's axis options: putting a dimension on X clears what needs a
 * date axis, the group-by becomes a segment (with a date-bin choice), and the
 * comparison style is offered for bar charts and saved only when it says
 * something.
 */

const CONFIG: CostGraphConfig = {
  version: 1,
  chartType: "stacked_bar",
  binning: "daily",
  dateRange: { kind: "relative", preset: "30d" },
  groupBy: "service",
  filters: [],
  topN: 5,
  comparePreviousPeriod: true,
  showForecast: true,
  cumulative: true,
};

function api(): CostApi {
  return {
    queryCosts: vi.fn(),
    loadDimensionValues: vi.fn(async () => []),
    loadCostStatus: vi.fn(async () => []),
  } as unknown as CostApi;
}

describe("CostGraphConfigModal X axis", () => {
  it("puts a dimension on X, segments by date bin, and saves paired bars", async () => {
    const onSave = vi.fn();
    render(
      <CostGraphConfigModal
        initialConfig={CONFIG}
        initialTitle="Spend"
        api={api()}
        onSave={onSave}
        onClose={() => {}}
      />,
    );

    fireEvent.change(screen.getByLabelText("X axis"), { target: { value: "service" } });
    // Same dimension on both is cleared, and what needs dates goes with them.
    const segment = screen.getByLabelText("Segment by");
    expect(segment).toHaveValue("none");
    expect(screen.getByRole("checkbox", { name: "Forecast" })).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: "Cumulative" })).toBeDisabled();

    fireEvent.change(segment, { target: { value: "__date__" } });
    fireEvent.change(screen.getByLabelText("Show the previous period as"), {
      target: { value: "bars" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    const saved = onSave.mock.calls[0]![1] as CostGraphConfig;
    expect(saved).toMatchObject({
      xAxis: "service",
      groupBy: "none",
      segmentByDate: true,
      comparisonStyle: "bars",
      showForecast: false,
    });
    expect(saved.cumulative).toBeUndefined();
  });

  it("asks for a key when a tag goes on X", async () => {
    const onSave = vi.fn();
    render(
      <CostGraphConfigModal
        initialConfig={{ ...CONFIG, showForecast: false, cumulative: undefined }}
        initialTitle="Spend"
        api={api()}
        onSave={onSave}
        onClose={() => {}}
      />,
    );
    fireEvent.change(screen.getByLabelText("X axis"), { target: { value: "tag" } });
    expect(await screen.findByLabelText("X axis tag key")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(
      await screen.findByText("Pick which key's values go on the X axis."),
    ).toBeInTheDocument();
    expect(onSave).not.toHaveBeenCalled();
  });

  it("puts the date axis back", async () => {
    const onSave = vi.fn();
    render(
      <CostGraphConfigModal
        initialConfig={{
          ...CONFIG,
          showForecast: false,
          cumulative: undefined,
          xAxis: "region",
          segmentByDate: true,
          groupBy: "none",
        }}
        initialTitle="Spend"
        api={api()}
        onSave={onSave}
        onClose={() => {}}
      />,
    );
    fireEvent.change(screen.getByLabelText("X axis"), { target: { value: "date" } });
    expect(screen.getByLabelText("Group by")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    const saved = onSave.mock.calls[0]![1] as CostGraphConfig;
    expect(saved.xAxis).toBeUndefined();
    expect(saved.segmentByDate).toBeUndefined();
  });
});

import { beforeAll, describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

beforeAll(() => {
  // jsdom has no <dialog> showModal/close; the modal opens one.
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
import type { BusinessMetricSourceDeclaration } from "@infrawrench/plugin-base";
import type { BusinessMetric } from "../../cost/config.js";
import { BusinessMetricImporterModal } from "../../cost/BusinessMetricImporterModal.js";
import type { CostsClient } from "../../cost/types.js";

const USD = "2714e483-4ff1-48e4-9e25-ac732e8f24f2";

/** The shape of Metronome's source: a currency that only applies to one measure. */
const SOURCE: BusinessMetricSourceDeclaration = {
  label: "Usage or revenue",
  kind: "metric",
  fields: [
    {
      key: "measure",
      label: "Measure",
      type: "select",
      required: true,
      defaultValue: "usage",
      options: [
        { id: "usage", label: "Billable metric usage" },
        { id: "revenue", label: "Invoiced revenue" },
      ],
    },
    {
      key: "creditType",
      label: "Currency or pricing unit",
      type: "select",
      dependsOn: ["measure"],
      defaultValue: USD,
    },
    { key: "customer", label: "Customer", type: "select", defaultValue: "" },
  ],
};

function client(): CostsClient {
  return {
    listBusinessMetricSources: vi.fn(async () => [
      {
        accountId: "acc-1",
        accountName: "Billing",
        pluginId: "metronome",
        pluginName: "Metronome",
        source: SOURCE,
      },
    ]),
    getBusinessMetricImporter: vi.fn(async () => null),
    listBusinessMetricSourceOptions: vi.fn(
      async ({ fieldKey, params }: { fieldKey: string; params: Record<string, string> }) => {
        if (fieldKey === "creditType") {
          return params["measure"] === "revenue"
            ? [
                { id: USD, label: "USD" },
                { id: "eur", label: "EUR" },
              ]
            : [{ id: "", label: "Not used for usage" }];
        }
        return [
          { id: "", label: "All customers" },
          { id: "c1", label: "Acme" },
        ];
      },
    ),
  } as unknown as CostsClient;
}

const METRIC = { id: "m1", key: "api_calls", name: "API calls" } as BusinessMetric;

function renderModal() {
  return render(
    <BusinessMetricImporterModal
      metric={METRIC}
      client={client()}
      onClose={vi.fn()}
      onChanged={vi.fn(async () => {})}
    />,
  );
}

function selectedText(label: string): string {
  const select = screen.getByLabelText(label) as HTMLSelectElement;
  return select.options[select.selectedIndex]?.textContent ?? "";
}

/** The modal loads sources, then each picker's choices; give it room under a busy suite. */
const SLOW = { timeout: 5000 };

describe("BusinessMetricImporterModal", () => {
  it("shows a choice whose id is empty instead of the placeholder", async () => {
    renderModal();
    await waitFor(() => expect(selectedText("Customer")).toBe("All customers"), SLOW);
    const customer = screen.getByLabelText("Customer") as HTMLSelectElement;
    expect([...customer.options].map((o) => o.textContent)).not.toContain("Choose…");
  });

  it("drops a default the dependent field cannot offer, and restores it when it can", async () => {
    renderModal();
    await waitFor(
      () => expect(selectedText("Currency or pricing unit")).toBe("Not used for usage"),
      SLOW,
    );
    expect(screen.queryByRole("option", { name: USD })).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/^Measure/), { target: { value: "revenue" } });
    await waitFor(() => expect(selectedText("Currency or pricing unit")).toBe("USD"), SLOW);
  });
});

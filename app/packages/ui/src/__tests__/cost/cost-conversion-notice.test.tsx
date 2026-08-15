import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import type { CostConversion } from "@infrawrench/client-core";
import { CostConversionNotice } from "../../cost/CostConversionNotice.js";

function conversion(over: Partial<CostConversion> = {}): CostConversion {
  return {
    displayCurrency: "USD",
    converted: [{ currency: "EUR", rates: [{ effectiveFrom: "2026-01-01", rate: 1.085 }] }],
    unconverted: [],
    ...over,
  };
}

/**
 * The notice is what the Costs panel renders above its figures. It exists
 * alongside the one-line `describeCostConversion` footnote the cards carry, and
 * earns its place by saying the two things the footnote has no room for: the
 * rate that produced each converted figure, and the date it took effect.
 */
describe("CostConversionNotice", () => {
  it("renders nothing for an org that converted nothing", () => {
    const { container } = render(<CostConversionNotice />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing when a conversion block describes no currencies", () => {
    const { container } = render(
      <CostConversionNotice conversion={conversion({ converted: [], unconverted: [] })} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("names each rate and the date it took effect", () => {
    render(<CostConversionNotice conversion={conversion()} />);
    expect(screen.getByText(/Amounts are converted to USD/)).toBeTruthy();
    expect(screen.getByText(/1\.085 from 2026-01-01/)).toBeTruthy();
  });

  it("says out loud when a range spans a rate change", () => {
    render(
      <CostConversionNotice
        conversion={conversion({
          converted: [
            {
              currency: "EUR",
              rates: [
                { effectiveFrom: "2026-02-01", rate: 1.1 },
                { effectiveFrom: "2026-01-01", rate: 1.085 },
              ],
            },
          ],
        })}
      />,
    );
    expect(screen.getByText(/rate changed mid-period/)).toBeTruthy();
  });

  it("names a currency that is missing from the headline figure", () => {
    render(<CostConversionNotice conversion={conversion({ unconverted: ["SEK"] })} />);
    expect(screen.getByText(/Spend in SEK is not included in the USD figure/)).toBeTruthy();
  });

  it("counts rather than names when several currencies are excluded", () => {
    render(<CostConversionNotice conversion={conversion({ unconverted: ["SEK", "NOK"] })} />);
    expect(
      screen.getByText(/Spend in 2 currencies is not included in the USD figure/),
    ).toBeTruthy();
    // The count is a summary, so the list still has to be readable.
    expect(screen.getByText("SEK")).toBeTruthy();
    expect(screen.getByText("NOK")).toBeTruthy();
  });

  it("shows the excluded-currency warning even when nothing was converted", () => {
    // The failure this guards is the worst one the feature can produce: a
    // headline total that silently omits spend.
    render(
      <CostConversionNotice conversion={conversion({ converted: [], unconverted: ["SEK"] })} />,
    );
    expect(screen.getByText(/Spend in SEK is not included in the USD figure/)).toBeTruthy();
  });
});

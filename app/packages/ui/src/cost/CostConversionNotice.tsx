import { T, Var, useGT } from "gt-react";
import { summarizeConversionRates, type CostConversion } from "@infrawrench/client-core";

export interface CostConversionNoticeProps {
  /**
   * The `conversion` block from a cost response. Undefined means nothing was
   * converted: the component renders nothing, which is what every org that has
   * not opted in sees.
   */
  conversion?: CostConversion | undefined;
}

/**
 * Labels a converted figure as converted, wherever one is shown.
 *
 * Sibling of `CostCollectionNotice`, and the same argument: a number that looks
 * like a collected total but is not one has to say so on the page, not in a
 * tooltip and not in the docs. Two things need saying, and they fail in
 * opposite directions:
 *
 *  - **What was converted, and at what.** Each rate is either the org's own
 *    (stated by someone on the team with an effective date) or the automatic
 *    ECB reference rate (named with its publication dates). A reader
 *    reconciling against an invoice needs to see which rates produced the
 *    number, and needs to know a range spanning a rate change is a blend.
 *  - **What could not be.** A currency with no configured rate is shown in its
 *    own currency rather than folded in, so the headline figure is not the
 *    whole spend. Saying nothing here would understate the total silently,
 *    which is the worst outcome this feature could produce.
 *
 * Renders nothing when there was no conversion to describe.
 */
export function CostConversionNotice({ conversion }: CostConversionNoticeProps) {
  const gt = useGT();
  if (!conversion) return null;
  const { displayCurrency, converted, unconverted } = conversion;
  if (converted.length === 0 && unconverted.length === 0) return null;
  const usedFeed = converted.some((c) => c.rates.some((r) => r.source === "ecb"));
  const usedManual = converted.some((c) =>
    c.rates.some((r) => (r.source ?? "manual") === "manual"),
  );

  return (
    <>
      {converted.length > 0 && (
        <div
          role="status"
          className="mb-4 rounded-xl border border-border bg-surface-overlay px-4 py-3 text-sm"
        >
          <p className="font-medium text-on-surface">
            {gt("Amounts are converted to {currency}", { currency: displayCurrency })}
          </p>
          <ul className="mt-1 space-y-1.5">
            {converted.map((entry) => (
              <li key={entry.currency} className="text-on-surface-secondary">
                <span className="text-on-surface-muted">
                  {entry.currency} → {displayCurrency}
                </span>{" "}
                {summarizeConversionRates(entry.rates)
                  .map((summary) => {
                    if (summary.source === "ecb") {
                      return summary.count === 1
                        ? gt("{rate} (ECB reference rate, {date})", {
                            rate: summary.minRate,
                            date: summary.firstRateDate,
                          })
                        : gt("{min} to {max} (ECB reference rates, {first} to {last})", {
                            min: summary.minRate,
                            max: summary.maxRate,
                            first: summary.firstRateDate,
                            last: summary.lastRateDate,
                          });
                    }
                    return entry.rates
                      .filter((r) => (r.source ?? "manual") === "manual")
                      .map((r) =>
                        gt("{rate} from {from} (your rate)", {
                          rate: r.rate,
                          from: r.effectiveFrom,
                        }),
                      )
                      .join(", ");
                  })
                  .join("; ")}
                {entry.rates.length > 1 && (
                  <span className="text-on-surface-muted"> {gt("(rate changed mid-period)")}</span>
                )}
              </li>
            ))}
          </ul>
          {usedManual && (
            <T>
              <p className="mt-1.5 text-xs text-on-surface-faint">
                &ldquo;Your rate&rdquo; is set in Settings → Currency and overrides automatic rates.
              </p>
            </T>
          )}
          {usedFeed && (
            <T>
              <p className="mt-1.5 text-xs text-on-surface-faint">
                Automatic rates are the European Central Bank&apos;s euro reference rates. Weekends
                and holidays use the last published rate.
              </p>
            </T>
          )}
          <T>
            <p className="mt-1.5 text-xs text-on-surface-faint">
              Spend already in <Var>{displayCurrency}</Var> is not converted.
            </p>
          </T>
        </div>
      )}

      {unconverted.length > 0 && (
        <div
          role="status"
          className="mb-4 rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm"
        >
          <p className="font-medium text-warning">
            {unconverted.length === 1
              ? gt("Spend in {currency} is not included in the {display} figure", {
                  currency: unconverted[0],
                  display: displayCurrency,
                })
              : gt("Spend in {count} currencies is not included in the {display} figure", {
                  count: unconverted.length,
                  display: displayCurrency,
                })}
          </p>
          {unconverted.length > 1 && (
            <ul className="mt-1 space-y-1.5">
              {unconverted.map((currency) => (
                <li key={currency} className="text-on-surface-secondary">
                  {currency}
                </li>
              ))}
            </ul>
          )}
          <T>
            <p className="mt-1.5 text-xs text-on-surface-faint">
              No exchange rate covers this whole range for{" "}
              <Var>{unconverted.length === 1 ? gt("it") : gt("them")}</Var>, so they are shown
              separately. Add a rate in Settings → Currency to include{" "}
              <Var>{unconverted.length === 1 ? gt("it") : gt("them")}</Var>.
            </p>
          </T>
        </div>
      )}
    </>
  );
}

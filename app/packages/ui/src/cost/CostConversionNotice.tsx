import type { CostConversion } from "@infrawrench/client-core";

export interface CostConversionNoticeProps {
  /**
   * The `conversion` block from a cost response. Undefined means nothing was
   * converted — the component renders nothing, which is what every org that has
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
 *  - **What was converted, and at what.** The rate is the org's own, stated by
 *    someone on the team with an effective date. A reader reconciling against
 *    an invoice needs to see which rate produced the number, and needs to know
 *    a range spanning a rate change is a blend of two.
 *  - **What could not be.** A currency with no configured rate is shown in its
 *    own currency rather than folded in, so the headline figure is not the
 *    whole spend. Saying nothing here would understate the total silently,
 *    which is the worst outcome this feature could produce.
 *
 * Renders nothing when there was no conversion to describe.
 */
export function CostConversionNotice({ conversion }: CostConversionNoticeProps) {
  if (!conversion) return null;
  const { displayCurrency, converted, unconverted } = conversion;
  if (converted.length === 0 && unconverted.length === 0) return null;

  return (
    <>
      {converted.length > 0 && (
        <div
          role="status"
          className="mb-4 rounded-xl border border-border bg-surface-overlay px-4 py-3 text-sm"
        >
          <p className="font-medium text-on-surface">Amounts are converted to {displayCurrency}</p>
          <ul className="mt-1 space-y-1.5">
            {converted.map((entry) => (
              <li key={entry.currency} className="text-on-surface-secondary">
                <span className="text-on-surface-muted">
                  {entry.currency} → {displayCurrency}
                </span>{" "}
                {entry.rates.map((r) => `${r.rate} from ${r.effectiveFrom}`).join(", ")}
                {entry.rates.length > 1 && (
                  <span className="text-on-surface-muted"> (rate changed mid-period)</span>
                )}
              </li>
            ))}
          </ul>
          <p className="mt-1.5 text-xs text-on-surface-faint">
            These are your organization&apos;s own rates, set in Settings → Currency. Infrawrench
            does not fetch live exchange rates, so a converted figure reconciles against the rate
            your finance team stated rather than today&apos;s market price. Spend already in{" "}
            {displayCurrency} is not converted.
          </p>
        </div>
      )}

      {unconverted.length > 0 && (
        <div
          role="status"
          className="mb-4 rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm"
        >
          <p className="font-medium text-amber-300">
            {unconverted.length === 1
              ? `Spend in ${unconverted[0]} is not included in the ${displayCurrency} figure`
              : `Spend in ${unconverted.length} currencies is not included in the ${displayCurrency} figure`}
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
          <p className="mt-1.5 text-xs text-on-surface-faint">
            No exchange rate is configured for {unconverted.length === 1 ? "it" : "them"}, or none
            covers every day in this range, so the amounts are shown separately in their own
            currency rather than folded in or dropped. Add a rate in Settings → Currency to include{" "}
            {unconverted.length === 1 ? "it" : "them"}.
          </p>
        </div>
      )}
    </>
  );
}

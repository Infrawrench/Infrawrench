import { T, useGT } from "gt-react";
import {
  changeCostImpactReasonLabel,
  changeImpactMonthly,
  CHANGE_IMPACT_CONFIDENCE_LABELS,
  costBasisLabel,
  formatMonthlyEstimate,
  formatSignedPercent,
  formatSignedPerDay,
  type ChangeCostImpact,
} from "@infrawrench/client-core";
import { useDataString } from "../i18n/data-strings.js";

/**
 * The one-line cost verdict on a change or a deploy.
 *
 * Everything on the line is there because leaving it off would make the number
 * unreadable: the **basis** (cash and amortized are different questions), the
 * **window** (a 2-day comparison is not a 7-day one), and the **confidence**,
 * which is the honest word for "other things were happening too".
 *
 * A resource we hold no cost for renders nothing at all in `compact` mode
 * rather than a row of "unknown" beside every security group. In the detail
 * views (`compact={false}`) it says *why*, because there the reader asked.
 */
export function ChangeCostImpactLine({
  impact,
  compact = false,
}: {
  impact: ChangeCostImpact;
  compact?: boolean;
}) {
  const gt = useGT();
  const gtData = useDataString();

  if (impact.status !== "measured") {
    if (compact) return null;
    const why = impact.reasons.map((r) => gtData(changeCostImpactReasonLabel(r))).join("; ");
    return (
      <p className="text-xs text-on-surface-faint">
        {why ? gt("Cost impact unknown — {why}.", { why }) : gt("Cost impact unknown.")}
      </p>
    );
  }

  // Same red-up / green-down pairing the cost graph's period-delta badge uses,
  // so "spend went up" is one colour across the product.
  const tone = (delta: number) =>
    delta > 0 ? "text-danger" : delta < 0 ? "text-success" : "text-on-surface-muted";

  const confidenceLabel = gtData(CHANGE_IMPACT_CONFIDENCE_LABELS[impact.confidence]).toLowerCase();

  return (
    <span className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-xs">
      {impact.series.map((s) => (
        <span key={s.currency} className={`font-medium ${tone(s.deltaPerDay)}`}>
          {formatSignedPerDay(s.deltaPerDay, s.currency)}
          {s.deltaPercent === null ? "" : ` (${formatSignedPercent(s.deltaPercent)})`}
          {!compact && (
            <span className="text-on-surface-faint font-normal">
              {" "}
              ≈ {formatMonthlyEstimate(changeImpactMonthly(s.deltaPerDay), s.currency)}/mo
            </span>
          )}
        </span>
      ))}
      <span
        className="text-on-surface-faint"
        title={
          impact.before && impact.after
            ? gt("{beforeFrom}–{beforeTo} vs {afterFrom}–{afterTo}", {
                beforeFrom: impact.before.from,
                beforeTo: impact.before.to,
                afterFrom: impact.after.from,
                afterTo: impact.after.to,
              })
            : undefined
        }
      >
        {gt("{basis}, {days}d before/after", {
          basis: gtData(costBasisLabel(impact.costBasis)),
          days: impact.effectiveWindowDays,
        })}
      </span>
      <span
        className="text-on-surface-faint"
        title={
          impact.overlappingChanges > 0
            ? impact.overlappingChanges === 1
              ? gt(
                  "{count} other change touched this resource inside the window — this delta is correlation, not proof.",
                  { count: impact.overlappingChanges },
                )
              : gt(
                  "{count} other changes touched this resource inside the window — this delta is correlation, not proof.",
                  { count: impact.overlappingChanges },
                )
            : undefined
        }
      >
        {impact.overlappingChanges > 0
          ? gt("· {confidence} (contested)", { confidence: confidenceLabel })
          : gt("· {confidence}", { confidence: confidenceLabel })}
      </span>
    </span>
  );
}

/**
 * The monthly-equivalent caveat, spelled out once. Rendered under a detail
 * view rather than repeated on every row.
 */
export function ChangeCostImpactFootnote() {
  return (
    <T>
      <p className="text-xs text-on-surface-faint mt-2">
        Measured from collected provider spend either side of the change, and recomputed on every
        view — the figure moves as late-arriving cost lands. A delta is correlation, not proof of
        cause; monthly equivalents are the daily rate × 30.
      </p>
    </T>
  );
}

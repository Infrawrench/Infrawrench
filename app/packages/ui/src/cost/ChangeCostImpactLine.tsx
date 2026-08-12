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
  if (impact.status !== "measured") {
    if (compact) return null;
    const why = impact.reasons.map(changeCostImpactReasonLabel).join("; ");
    return (
      <p className="text-xs text-on-surface-faint">Cost impact unknown{why ? ` — ${why}` : ""}.</p>
    );
  }

  // Same red-up / green-down pairing the cost graph's period-delta badge uses,
  // so "spend went up" is one colour across the product.
  const tone = (delta: number) =>
    delta > 0 ? "text-danger" : delta < 0 ? "text-success" : "text-on-surface-muted";

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
            ? `${impact.before.from}–${impact.before.to} vs ${impact.after.from}–${impact.after.to}`
            : undefined
        }
      >
        {costBasisLabel(impact.costBasis)}, {impact.effectiveWindowDays}d before/after
      </span>
      <span
        className="text-on-surface-faint"
        title={
          impact.overlappingChanges > 0
            ? `${impact.overlappingChanges} other change${
                impact.overlappingChanges === 1 ? "" : "s"
              } touched this resource inside the window — this delta is correlation, not proof.`
            : undefined
        }
      >
        · {CHANGE_IMPACT_CONFIDENCE_LABELS[impact.confidence].toLowerCase()}
        {impact.overlappingChanges > 0 ? " (contested)" : ""}
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
    <p className="text-xs text-on-surface-faint mt-2">
      Measured from collected provider spend either side of the change, and recomputed on every view
      — the figure moves as late-arriving cost lands. A delta is correlation, not proof of cause;
      monthly equivalents are the daily rate × 30.
    </p>
  );
}

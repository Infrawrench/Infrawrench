import { useId, useState } from "react";
import type { CostEstimate } from "@infrawrench/plugin-base";
import { formatMonthlyEstimate } from "@infrawrench/client-core";

/**
 * The estimated-cost badge, shared by every surface that quotes a monthly
 * figure: the create form's header, the resource detail page's header, and
 * the edit modal's footer.
 *
 * The badge is a disclosure rather than a bare number. A single total invites
 * "where did that come from" and the answer has to be in the UI, not in the
 * provider's calculator — so the line items the plugin returned are one click
 * away, and a partial estimate says "at least" instead of quietly quoting a
 * floor as if it were the whole bill.
 */

export interface CostEstimateBreakdownProps {
  estimate: CostEstimate;
}

/** The line items and notes behind a total. */
export function CostEstimateBreakdown({ estimate }: CostEstimateBreakdownProps) {
  return (
    <div className="space-y-2">
      <ul className="space-y-1">
        {estimate.lineItems.map((item) => (
          <li
            key={`${item.label}|${item.detail ?? ""}|${item.monthlyAmount}`}
            className="flex items-baseline justify-between gap-4"
          >
            <span className="min-w-0">
              <span className="block text-on-surface-secondary truncate">{item.label}</span>
              {item.detail && <span className="block text-on-surface-faint">{item.detail}</span>}
            </span>
            <span className="flex-shrink-0 tabular-nums text-on-surface">
              {formatMonthlyEstimate(item.monthlyAmount, estimate.currency)}
            </span>
          </li>
        ))}
      </ul>
      <div className="flex items-baseline justify-between gap-4 border-t border-border pt-2 font-medium">
        <span className="text-on-surface-secondary">{estimate.partial ? "At least" : "Total"}</span>
        <span className="tabular-nums text-on-surface">
          {formatMonthlyEstimate(estimate.monthlyAmount, estimate.currency)}/mo
        </span>
      </div>
      {estimate.notes?.map((note) => (
        <p key={note} className="text-on-surface-faint leading-relaxed">
          {note}
        </p>
      ))}
    </div>
  );
}

export interface CostEstimateChipProps {
  /**
   * The formatted total to show on the face of the chip. Hosts pass their own
   * label because the create form can quote a size-picker price when the
   * plugin has no `estimateCost` — a number with no breakdown behind it.
   */
  label: string;
  /** The itemized estimate, when the plugin supplied one. */
  estimate?: CostEstimate | null | undefined;
  /** Overrides the "Estimated cost" caption (e.g. "Estimated cost now"). */
  caption?: string;
}

export function CostEstimateChip({ label, estimate, caption }: CostEstimateChipProps) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const expandable = !!estimate && estimate.lineItems.length > 0;
  const heading = (
    <>
      <p className="text-[10px] uppercase tracking-wide text-success">
        {caption ?? "Estimated cost"}
      </p>
      <p className="text-sm font-semibold text-success">
        {estimate?.partial && <span className="font-normal">at least </span>}
        {label}/mo
      </p>
    </>
  );

  if (!expandable) {
    return (
      <div className="text-right px-3 py-1.5 rounded-lg border border-emerald-500/30 bg-emerald-500/10">
        {heading}
      </div>
    );
  }

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={panelId}
        className="text-right px-3 py-1.5 rounded-lg border border-emerald-500/30 bg-emerald-500/10 hover:bg-emerald-500/20 transition-colors"
      >
        {heading}
      </button>
      {open && (
        <div
          id={panelId}
          className="absolute right-0 top-full z-20 mt-1 w-80 rounded-lg border border-border-strong bg-surface-raised p-3 text-xs shadow-2xl"
        >
          <CostEstimateBreakdown estimate={estimate} />
        </div>
      )}
    </div>
  );
}

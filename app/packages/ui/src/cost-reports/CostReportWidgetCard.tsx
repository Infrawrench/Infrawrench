import { useGT } from "gt-react";
import type { CostReport, CostReportWidgetConfig } from "../cost/config.js";
import { CostGraphCard } from "../cost/CostGraphCard.js";
import type { CostApi } from "../cost/types.js";

export interface CostReportWidgetCardProps {
  /**
   * The report this card points at, resolved by the host from the org's report
   * list. Undefined while the list is still loading, or when the report is
   * genuinely gone — the card says so rather than drawing an empty chart.
   */
  report: CostReport | undefined;
  config: CostReportWidgetConfig;
  api: CostApi;
  /** Open the report's own page. Omitted where there is nowhere to go. */
  onOpenReport?: ((reportId: string) => void) | undefined;
  onRemove?: (() => void) | undefined;
}

/**
 * A dashboard card that renders a saved cost report.
 *
 * Deliberately not editable in place: the report is shared, so a "quick tweak"
 * here would silently change every other dashboard showing it. The card links
 * to the report's page, which is where the edit belongs and where the list of
 * everywhere else it appears is visible.
 *
 * A missing report should be impossible — deleting one soft-deletes its cards
 * (services/cost-reports.ts) — so the unavailable state is a genuine
 * inconsistency and is worded as one rather than as a normal empty state.
 */
export function CostReportWidgetCard({
  report,
  config,
  api,
  onOpenReport,
  onRemove,
}: CostReportWidgetCardProps) {
  const gt = useGT();
  if (!report) {
    return (
      <div className="group relative rounded-2xl border border-border bg-surface-raised flex flex-col overflow-hidden min-h-[18rem]">
        {onRemove && (
          <button
            type="button"
            onClick={onRemove}
            title={gt("Remove from dashboard")}
            aria-label={gt("Remove from dashboard")}
            className="absolute top-2 right-2 size-5 rounded-full text-on-surface-faint hover:text-on-surface-secondary hover:bg-surface-sunken text-xs flex items-center justify-center opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-all z-10"
          >
            ✕
          </button>
        )}
        <div className="flex-1 flex items-center justify-center px-6 text-center text-sm text-on-surface-faint">
          {gt(
            "This report is unavailable — it may still be loading, or it was removed outside this dashboard.",
          )}
        </div>
      </div>
    );
  }

  return (
    <CostGraphCard
      title={report.name}
      config={report.config}
      api={api}
      onEdit={onOpenReport ? () => onOpenReport(config.reportId) : undefined}
      onRemove={onRemove}
    />
  );
}

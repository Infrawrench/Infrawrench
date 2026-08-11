import { useEffect, useState } from "react";

import { Modal } from "../components/Modal.js";
import { COST_DIMENSION_LABELS, type CostReport } from "../cost/config.js";

export interface CostReportPickerModalProps {
  /** Every report in the org; those already on this dashboard are filtered out. */
  loadReports: () => Promise<CostReport[]>;
  /** Report ids already carried by this dashboard. */
  excludeIds: string[];
  onPick: (report: CostReport) => Promise<void> | void;
  onClose: () => void;
}

/** "Stacked bar · by Service" — enough to tell two saved reports apart. */
function describe(report: CostReport): string {
  const groupBy =
    report.config.groupBy === "none"
      ? "ungrouped"
      : `by ${COST_DIMENSION_LABELS[report.config.groupBy]}`;
  return groupBy;
}

/**
 * Pick an existing cost report to show on this dashboard.
 *
 * The counterpart to the ad-hoc "Cost graph" entry in the same "+" menu: a
 * report is an org object any number of dashboards can show, so adding a card
 * must not mean re-authoring the same chart a second time.
 */
export function CostReportPickerModal({
  loadReports,
  excludeIds,
  onPick,
  onClose,
}: CostReportPickerModalProps) {
  const [reports, setReports] = useState<CostReport[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    loadReports()
      .then(setReports)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [loadReports]);

  const excluded = new Set(excludeIds);
  const available = (reports ?? []).filter((r) => !excluded.has(r.id));

  async function pick(report: CostReport) {
    setBusy(true);
    setError(null);
    try {
      await onPick(report);
      onClose();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  return (
    <Modal onClose={onClose} ariaLabel="Add a saved cost report">
      <div className="bg-surface-raised border border-border-strong rounded-xl shadow-2xl w-[420px] p-6">
        <h2 className="text-base font-semibold text-on-surface mb-1">Add a saved report</h2>
        <p className="text-xs text-on-surface-faint mb-4">
          Shows a card for a report you already have. Editing the report later updates every
          dashboard showing it; removing this card leaves the report alone.
        </p>

        {error !== null && (
          <div role="alert" className="mb-3 text-sm text-danger">
            {error}
          </div>
        )}

        {reports === null && error === null && (
          <p role="status" className="text-sm text-on-surface-faint">
            Loading reports…
          </p>
        )}

        {reports !== null && available.length === 0 && (
          <p className="text-sm text-on-surface-faint">
            {reports.length === 0
              ? "This org has no saved reports yet. Add a cost graph instead, or save one from the Reports page."
              : "Every report is already on this dashboard."}
          </p>
        )}

        <ul className="flex flex-col gap-1 max-h-80 overflow-y-auto">
          {available.map((r) => (
            <li key={r.id}>
              <button
                type="button"
                disabled={busy}
                onClick={() => void pick(r)}
                className="w-full text-left rounded-lg px-3 py-2 hover:bg-surface-sunken disabled:opacity-50 flex items-center justify-between gap-3"
              >
                <span className="truncate text-sm text-on-surface">{r.name}</span>
                <span className="shrink-0 text-xs text-on-surface-faint">{describe(r)}</span>
              </button>
            </li>
          ))}
        </ul>

        <div className="mt-5 flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-border px-3 py-1.5 text-sm text-on-surface hover:border-border-strong"
          >
            Cancel
          </button>
        </div>
      </div>
    </Modal>
  );
}

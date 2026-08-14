import { useEffect } from "react";
import { useGT } from "gt-react";

/**
 * The dashboard's "+ Add" popover menu — one entry per card kind. Web and
 * desktop render it identically (they carried byte-identical copies before it
 * moved here); each host wires the callbacks to its own pickers and modals.
 */
export function DashboardAddMenu({
  onPickResource,
  onPickCostGraph,
  onPickSavedReport,
  onPickBudget,
  onPickExistingBudget,
  onPickCustomGraph,
  onClose,
}: {
  onPickResource: () => void;
  onPickCostGraph: () => void;
  onPickSavedReport: () => void;
  onPickBudget: () => void;
  onPickExistingBudget: () => void;
  onPickCustomGraph: () => void;
  onClose: () => void;
}) {
  const gt = useGT();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const itemClass =
    "w-full text-left px-3 py-2 text-sm text-on-surface-secondary hover:text-on-surface hover:bg-surface-sunken transition-colors flex items-center gap-2";

  return (
    <>
      {/* Mouse-only click-away backdrop; keyboard users close the menu with Escape (handled above). */}
      <div aria-hidden="true" className="fixed inset-0 z-20" onClick={onClose} />
      <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-30 w-52 rounded-xl border border-border bg-surface-raised shadow-xl overflow-hidden py-1">
        <button type="button" onClick={onPickResource} className={itemClass}>
          <span className="text-on-surface-faint">▣</span> {gt("Pin a resource")}
        </button>
        {/*
          Two entries on purpose: "Cost graph" is a one-off card owned by this
          dashboard, "Saved report" is a view onto a shared object. Collapsing
          them would force anyone wanting one chart to name and file a report.
        */}
        <button type="button" onClick={onPickCostGraph} className={itemClass}>
          <span className="text-on-surface-faint">▤</span> {gt("Cost graph")}
        </button>
        <button type="button" onClick={onPickSavedReport} className={itemClass}>
          <span className="text-on-surface-faint">▥</span> {gt("Saved report")}
        </button>
        <button type="button" onClick={onPickBudget} className={itemClass}>
          <span className="text-on-surface-faint">◔</span> {gt("New budget")}
        </button>
        <button type="button" onClick={onPickExistingBudget} className={itemClass}>
          <span className="text-on-surface-faint">◕</span> {gt("Existing budget")}
        </button>
        <button type="button" onClick={onPickCustomGraph} className={itemClass}>
          <span className="text-on-surface-faint">◈</span> {gt("Custom graph")}
        </button>
      </div>
    </>
  );
}

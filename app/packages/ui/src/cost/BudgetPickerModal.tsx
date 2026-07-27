import { useEffect, useState } from "react";

import { Modal } from "../components/Modal.js";
import { formatMoney } from "./transform.js";
import type { BudgetWithStatus } from "./types.js";

export interface BudgetPickerModalProps {
  /** Every budget in the org; those already on this dashboard are filtered out. */
  loadBudgets: () => Promise<BudgetWithStatus[]>;
  /** Budget ids already carried by this dashboard. */
  excludeIds: string[];
  onPick: (budget: BudgetWithStatus) => Promise<void> | void;
  onClose: () => void;
}

/**
 * Pick an existing budget to show on this dashboard.
 *
 * The counterpart to creating one from the same "+" menu: a budget is an org
 * object that any number of dashboards can show, so adding a card must not
 * require making a second budget that tracks the same spend.
 */
export function BudgetPickerModal({
  loadBudgets,
  excludeIds,
  onPick,
  onClose,
}: BudgetPickerModalProps) {
  const [budgets, setBudgets] = useState<BudgetWithStatus[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    loadBudgets()
      .then(setBudgets)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [loadBudgets]);

  const excluded = new Set(excludeIds);
  const available = (budgets ?? []).filter((b) => !excluded.has(b.id));

  async function pick(budget: BudgetWithStatus) {
    setBusy(true);
    setError(null);
    try {
      await onPick(budget);
      onClose();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  return (
    <Modal onClose={onClose} ariaLabel="Add an existing budget" className="max-w-md">
      <h2 className="text-base font-semibold text-on-surface mb-1">Add an existing budget</h2>
      <p className="text-xs text-on-surface-faint mb-4">
        Shows a card for a budget you already have. The budget itself is unchanged, and removing the
        card later leaves it alone.
      </p>

      {error !== null && (
        <div role="alert" className="mb-3 text-sm text-red-500">
          {error}
        </div>
      )}

      {budgets === null && error === null && (
        <p role="status" className="text-sm text-on-surface-faint">
          Loading budgets…
        </p>
      )}

      {budgets !== null && available.length === 0 && (
        <p className="text-sm text-on-surface-faint">
          {budgets.length === 0
            ? "This org has no budgets yet. Create one instead."
            : "Every budget is already on this dashboard."}
        </p>
      )}

      <ul className="flex flex-col gap-1 max-h-80 overflow-y-auto">
        {available.map((b) => (
          <li key={b.id}>
            <button
              type="button"
              disabled={busy}
              onClick={() => void pick(b)}
              className="w-full text-left rounded-lg px-3 py-2 hover:bg-surface-sunken disabled:opacity-50 flex items-center justify-between gap-3"
            >
              <span className="truncate text-sm text-on-surface">{b.name}</span>
              <span className="shrink-0 text-xs text-on-surface-faint">
                {formatMoney(b.actualCents / 100, b.currency)} /{" "}
                {formatMoney(b.amountCents / 100, b.currency)}
              </span>
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
    </Modal>
  );
}

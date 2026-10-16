import { useCallback, useEffect, useMemo, useState } from "react";
import { useGT } from "gt-react";
import {
  lastFullMonth,
  type ManagedAccount,
  type UnassignedSpendReport,
  type UnassignedSpendRow,
} from "@infrawrench/client-core";
import type { BulkAssignInitial } from "./BulkAssignModal.js";
import { BTN, FIELD, amountsText } from "./shared.js";

/** One row's key in the selection: `kind:id`. */
function rowKey(row: Pick<UnassignedSpendRow, "kind" | "id">): string {
  return `${row.kind}:${row.id ?? ""}`;
}

/**
 * Spend in the period that no customer is billed for, by cost centre and
 * cloud account, with a way to assign it on the spot.
 *
 * This is the MSP's leak detector: an account connected last week and never
 * put on a customer is money spent on someone's behalf that no invoice will
 * ever ask for. The rows are resolved the way an invoice resolves them, so
 * assigning a row moves exactly the amount it shows.
 */
export function UnassignedSpend({
  load,
  customers,
  canAssign,
  onAssign,
}: {
  load: (period: { from: string; to: string }) => Promise<UnassignedSpendReport>;
  customers: ManagedAccount[];
  canAssign: boolean;
  /** Open the assignment preview with these items (and target) chosen. */
  onAssign: (initial: BulkAssignInitial) => void;
}) {
  const gt = useGT();
  const defaults = useMemo(lastFullMonth, []);
  const [from, setFrom] = useState(defaults.from);
  const [to, setTo] = useState(defaults.to);
  const [report, setReport] = useState<UnassignedSpendReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());

  const refresh = useCallback(async () => {
    if (!from || !to || to < from) return;
    setLoading(true);
    try {
      setReport(await load({ from, to }));
      setError(null);
      setSelected(new Set());
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [load, from, to]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const assignable = report?.rows.filter((r) => r.kind !== "unallocated") ?? [];
  const selection = (rows: UnassignedSpendRow[]): BulkAssignInitial => ({
    costCentreIds: rows.filter((r) => r.kind === "cost_centre").map((r) => r.id!),
    accountIds: rows.filter((r) => r.kind === "account").map((r) => r.id!),
    period: { from, to },
  });
  const toggleRow = (row: UnassignedSpendRow) =>
    setSelected((prev) => {
      const next = new Set(prev);
      const key = rowKey(row);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const total = report ? amountsText(report.totals.unassigned) : "";
  const all = report ? amountsText(report.totals.all) : "";

  return (
    <section className="flex flex-col gap-3">
      <div>
        <h2 className="text-base font-semibold text-on-surface">{gt("Unassigned spend")}</h2>
        <p className="text-xs text-on-surface-faint">
          {gt(
            "Spend in the period that no customer is billed for, by cost centre and cloud account. Amortized, before billing rules.",
          )}
        </p>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-xs text-on-surface-faint">
          {gt("From")}
          <input
            type="date"
            className={FIELD}
            value={from}
            onChange={(e) => setFrom(e.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-on-surface-faint">
          {gt("To")}
          <input type="date" className={FIELD} value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
        <button type="button" className={BTN} disabled={loading} onClick={() => void refresh()}>
          {loading ? gt("Loading…") : gt("Refresh")}
        </button>
        {canAssign && selected.size > 0 && (
          <button
            type="button"
            className={BTN}
            onClick={() => onAssign(selection(assignable.filter((r) => selected.has(rowKey(r)))))}
          >
            {gt("Assign {count} selected…", { count: selected.size })}
          </button>
        )}
      </div>

      {error !== null && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}

      {report === null ? (
        !error && <p className="text-sm text-on-surface-faint">{gt("Loading…")}</p>
      ) : report.rows.length === 0 ? (
        <p className="text-sm text-success">
          {all
            ? gt("Every cost in this period is billed to a customer.")
            : gt("No spend in this period.")}
        </p>
      ) : (
        <>
          <p className="text-sm text-on-surface">
            {gt("{amount} unassigned, of {all} in total.", { amount: total, all })}
          </p>
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs uppercase tracking-wide text-on-surface-faint">
                  {canAssign && (
                    <th scope="col" className="w-8 px-3 py-2">
                      <input
                        type="checkbox"
                        aria-label={gt("Select every row")}
                        checked={assignable.length > 0 && selected.size === assignable.length}
                        onChange={(e) =>
                          setSelected(
                            e.target.checked ? new Set(assignable.map(rowKey)) : new Set(),
                          )
                        }
                      />
                    </th>
                  )}
                  <th scope="col" className="px-3 py-2 text-left font-normal">
                    {gt("Cost centre or account")}
                  </th>
                  <th scope="col" className="px-3 py-2 text-right font-normal">
                    {gt("Spend")}
                  </th>
                  {canAssign && (
                    <th scope="col" className="px-3 py-2 text-right font-normal">
                      {gt("Assign")}
                    </th>
                  )}
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {report.rows.map((row) => (
                  <tr key={rowKey(row)}>
                    {canAssign && (
                      <td className="px-3 py-2">
                        {row.kind !== "unallocated" && (
                          <input
                            type="checkbox"
                            aria-label={gt("Select {name}", { name: row.name })}
                            checked={selected.has(rowKey(row))}
                            onChange={() => toggleRow(row)}
                          />
                        )}
                      </td>
                    )}
                    <td className="px-3 py-2 text-on-surface">
                      {row.kind === "unallocated" ? (
                        <span
                          title={gt(
                            "Spend from accounts that are no longer connected, or uploaded costs with no account. It can't be assigned to a customer.",
                          )}
                        >
                          {gt("Not attributable to a connected account")}
                        </span>
                      ) : (
                        row.name
                      )}
                      <span className="ml-2 text-xs text-on-surface-faint">
                        {row.kind === "cost_centre"
                          ? gt("cost centre")
                          : row.kind === "account"
                            ? row.pluginId
                            : null}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-on-surface">
                      {amountsText(row.amounts)}
                    </td>
                    {canAssign && (
                      <td className="px-3 py-2 text-right">
                        {row.kind !== "unallocated" && customers.length > 0 && (
                          <select
                            className={FIELD}
                            aria-label={gt("Assign {name} to a customer", { name: row.name })}
                            value=""
                            onChange={(e) => {
                              if (!e.target.value) return;
                              onAssign({ ...selection([row]), managedAccountId: e.target.value });
                            }}
                          >
                            <option value="">{gt("Assign to…")}</option>
                            {customers.map((c) => (
                              <option key={c.id} value={c.id}>
                                {c.name}
                              </option>
                            ))}
                          </select>
                        )}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}

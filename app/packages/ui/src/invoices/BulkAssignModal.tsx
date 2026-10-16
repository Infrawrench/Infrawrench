import { useEffect, useMemo, useState } from "react";
import { useGT } from "gt-react";
import {
  costCentrePaths,
  lastFullMonth,
  type CostCentre,
  type ManagedAccount,
  type ManagedAccountAssignmentInput,
  type ManagedAccountAssignmentPreview,
} from "@infrawrench/client-core";
import { Modal } from "../components/Modal.js";
import type { InvoiceScopeAccount } from "./types.js";
import { BTN, FIELD, amountsText, toggle } from "./shared.js";

/** What the modal opens with: a selection made elsewhere, or nothing. */
export interface BulkAssignInitial {
  managedAccountId?: string | null | undefined;
  costCentreIds?: string[] | undefined;
  accountIds?: string[] | undefined;
  period?: { from: string; to: string } | undefined;
}

/** `""` in the target picker: take the items off every customer. */
const UNASSIGN = "";

/**
 * Move many cost centres and accounts onto one customer (or off every
 * customer) in one act, with the spend that moves shown before anything is
 * written.
 *
 * The preview is the point. Reassigning an account changes what next month's
 * invoices say for two customers at once; the person doing it should see
 * which customer loses how much before they confirm, not find out from a
 * draft.
 */
export function BulkAssignModal({
  customers,
  centres,
  cloudAccounts,
  initial,
  onPreview,
  onAssign,
  onClose,
}: {
  customers: ManagedAccount[];
  centres: CostCentre[];
  cloudAccounts: InvoiceScopeAccount[];
  initial?: BulkAssignInitial | undefined;
  onPreview?:
    | ((
        input: ManagedAccountAssignmentInput & { periodFrom: string; periodTo: string },
      ) => Promise<ManagedAccountAssignmentPreview>)
    | undefined;
  onAssign: (input: ManagedAccountAssignmentInput) => Promise<void>;
  onClose: () => void;
}) {
  const gt = useGT();
  const defaults = useMemo(() => initial?.period ?? lastFullMonth(), [initial?.period]);
  const [target, setTarget] = useState<string>(
    initial?.managedAccountId === undefined
      ? (customers[0]?.id ?? UNASSIGN)
      : (initial.managedAccountId ?? UNASSIGN),
  );
  const [centreIds, setCentreIds] = useState<string[]>(initial?.costCentreIds ?? []);
  const [accountIds, setAccountIds] = useState<string[]>(initial?.accountIds ?? []);
  const [from, setFrom] = useState(defaults.from);
  const [to, setTo] = useState(defaults.to);
  const [filter, setFilter] = useState("");
  const [preview, setPreview] = useState<ManagedAccountAssignmentPreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const paths = useMemo(() => costCentrePaths(centres), [centres]);
  // Who holds each item today, so the picker can say "currently Northwind".
  const centreOwner = useMemo(() => {
    const out = new Map<string, string>();
    for (const c of customers) for (const id of c.costCentreIds) out.set(id, c.name);
    return out;
  }, [customers]);
  const accountOwner = useMemo(() => {
    const out = new Map<string, string>();
    for (const c of customers) for (const id of c.accountIds) out.set(id, c.name);
    return out;
  }, [customers]);
  const centreSet = useMemo(() => new Set(centreIds), [centreIds]);
  const accountSet = useMemo(() => new Set(accountIds), [accountIds]);

  const needle = filter.trim().toLowerCase();
  const visibleCentres = needle
    ? paths.filter((row) => row.path.toLowerCase().includes(needle))
    : paths;
  const visibleAccounts = needle
    ? cloudAccounts.filter(
        (a) =>
          a.displayName.toLowerCase().includes(needle) || a.pluginId.toLowerCase().includes(needle),
      )
    : cloudAccounts;

  const selected = centreIds.length + accountIds.length;
  const assignment: ManagedAccountAssignmentInput = useMemo(
    () => ({
      managedAccountId: target === UNASSIGN ? null : target,
      costCentreIds: centreIds,
      accountIds,
    }),
    [target, centreIds, accountIds],
  );

  // Re-preview whenever the question changes, after the typing settles.
  useEffect(() => {
    if (!onPreview || selected === 0 || !from || !to || to < from) {
      setPreview(null);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      onPreview({ ...assignment, periodFrom: from, periodTo: to })
        .then((result) => {
          if (cancelled) return;
          setPreview(result);
          setPreviewError(null);
        })
        .catch((e: unknown) => {
          if (cancelled) return;
          setPreview(null);
          setPreviewError(e instanceof Error ? e.message : String(e));
        });
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [onPreview, assignment, from, to, selected]);

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      await onAssign(assignment);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const targetName =
    target === UNASSIGN ? null : (customers.find((c) => c.id === target)?.name ?? null);
  const changing = preview ? preview.items.filter((i) => !i.unchanged).length : selected;

  return (
    <Modal ariaLabel={gt("Assign cost centres and accounts")} onClose={onClose}>
      <div className="bg-surface-raised border border-border-strong rounded-xl shadow-2xl w-[760px] max-w-[94vw] max-h-[88vh] overflow-y-auto p-6">
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1">
            <h2 className="text-base font-semibold text-on-surface">
              {gt("Assign cost centres and accounts")}
            </h2>
            <p className="text-xs text-on-surface-faint">
              {gt(
                "Each item is taken off whichever customer has it and given to the one you choose. Only draft invoices change; approved invoices keep their own copy of the scope.",
              )}
            </p>
          </div>

          <label className="flex flex-col gap-1 text-xs text-on-surface-faint">
            {gt("Assign to")}
            <select className={FIELD} value={target} onChange={(e) => setTarget(e.target.value)}>
              {customers.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
              <option value={UNASSIGN}>{gt("No customer (unassign)")}</option>
            </select>
          </label>

          <div className="flex flex-col gap-2">
            <input
              className={FIELD}
              value={filter}
              placeholder={gt("Filter cost centres and accounts")}
              aria-label={gt("Filter cost centres and accounts")}
              onChange={(e) => setFilter(e.target.value)}
            />
            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1">
                <span className="text-xs text-on-surface-faint">
                  {gt("Cost centres ({count} selected)", { count: centreIds.length })}
                </span>
                <div className="h-48 overflow-y-auto rounded-lg border border-border bg-surface-sunken p-2">
                  {visibleCentres.length === 0 ? (
                    <p className="text-xs text-on-surface-faint">{gt("No cost centres match.")}</p>
                  ) : (
                    visibleCentres.map((row) => (
                      <label
                        key={row.id}
                        className="flex items-center gap-2 py-0.5 text-sm text-on-surface"
                        style={{ paddingLeft: needle ? 0 : `${row.depth * 12}px` }}
                        title={row.path}
                      >
                        <input
                          type="checkbox"
                          checked={centreSet.has(row.id)}
                          onChange={() => setCentreIds((ids) => toggle(ids, row.id))}
                        />
                        <span className="truncate">{needle ? row.path : row.name}</span>
                        {centreOwner.has(row.id) && (
                          <span className="ml-auto shrink-0 text-xs text-on-surface-faint">
                            {centreOwner.get(row.id)}
                          </span>
                        )}
                      </label>
                    ))
                  )}
                </div>
              </div>
              <div className="flex flex-col gap-1">
                <span className="text-xs text-on-surface-faint">
                  {gt("Cloud accounts ({count} selected)", { count: accountIds.length })}
                </span>
                <div className="h-48 overflow-y-auto rounded-lg border border-border bg-surface-sunken p-2">
                  {visibleAccounts.length === 0 ? (
                    <p className="text-xs text-on-surface-faint">{gt("No accounts match.")}</p>
                  ) : (
                    visibleAccounts.map((a) => (
                      <label
                        key={a.id}
                        className="flex items-center gap-2 py-0.5 text-sm text-on-surface"
                      >
                        <input
                          type="checkbox"
                          checked={accountSet.has(a.id)}
                          onChange={() => setAccountIds((ids) => toggle(ids, a.id))}
                        />
                        <span className="truncate">{a.displayName}</span>
                        <span className="text-xs text-on-surface-faint">{a.pluginId}</span>
                        {accountOwner.has(a.id) && (
                          <span className="ml-auto shrink-0 text-xs text-on-surface-faint">
                            {accountOwner.get(a.id)}
                          </span>
                        )}
                      </label>
                    ))
                  )}
                </div>
              </div>
            </div>
          </div>

          {onPreview && (
            <div className="flex flex-col gap-2 rounded-lg border border-border bg-surface-sunken p-3">
              <div className="flex flex-wrap items-end gap-3">
                <span className="text-xs font-medium text-on-surface">
                  {gt("Spend that moves")}
                </span>
                <label className="flex items-center gap-1 text-xs text-on-surface-faint">
                  {gt("From")}
                  <input
                    type="date"
                    className={FIELD}
                    value={from}
                    onChange={(e) => setFrom(e.target.value)}
                  />
                </label>
                <label className="flex items-center gap-1 text-xs text-on-surface-faint">
                  {gt("To")}
                  <input
                    type="date"
                    className={FIELD}
                    value={to}
                    onChange={(e) => setTo(e.target.value)}
                  />
                </label>
              </div>
              {selected === 0 ? (
                <p className="text-xs text-on-surface-faint">
                  {gt("Select cost centres or accounts to see what moves.")}
                </p>
              ) : previewError !== null ? (
                <p className="text-xs text-danger">{previewError}</p>
              ) : !preview ? (
                <p className="text-xs text-on-surface-faint">{gt("Working it out…")}</p>
              ) : (
                <AssignmentPreview preview={preview} targetName={targetName} />
              )}
            </div>
          )}

          {error !== null && (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          )}

          <div className="flex justify-end gap-2">
            <button type="button" className={BTN} onClick={onClose}>
              {gt("Cancel")}
            </button>
            <button
              type="button"
              className={BTN}
              disabled={busy || selected === 0 || changing === 0}
              onClick={() => void confirm()}
            >
              {busy
                ? gt("Assigning…")
                : targetName
                  ? gt("Assign {count} to {name}", { count: changing, name: targetName })
                  : gt("Unassign {count}", { count: changing })}
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}

function AssignmentPreview({
  preview,
  targetName,
}: {
  preview: ManagedAccountAssignmentPreview;
  targetName: string | null;
}) {
  const gt = useGT();
  return (
    <div className="flex flex-col gap-2 text-sm">
      <table className="w-full text-xs">
        <thead>
          <tr className="text-on-surface-faint">
            <th scope="col" className="py-1 text-left font-normal">
              {gt("Item")}
            </th>
            <th scope="col" className="py-1 text-left font-normal">
              {gt("Billed to now")}
            </th>
            <th scope="col" className="py-1 text-right font-normal">
              {gt("Spend in period")}
            </th>
          </tr>
        </thead>
        <tbody>
          {preview.items.map((item) => (
            <tr key={`${item.kind}:${item.id}`} className={item.unchanged ? "opacity-50" : ""}>
              <td className="py-0.5 text-on-surface">
                {item.name}
                <span className="ml-2 text-on-surface-faint">
                  {item.kind === "cost_centre" ? gt("cost centre") : gt("account")}
                </span>
              </td>
              <td className="py-0.5 text-on-surface-faint">
                {item.unchanged
                  ? gt("already there")
                  : (item.fromManagedAccountName ?? gt("no customer"))}
              </td>
              <td className="py-0.5 text-right tabular-nums text-on-surface">
                {amountsText(item.amounts) || "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <ul className="flex flex-col gap-0.5 text-xs text-on-surface-secondary">
        {preview.moves.map((move) => (
          <li key={move.fromManagedAccountId ?? "none"}>
            {targetName
              ? move.fromManagedAccountName
                ? gt("{amount} moves from {from} to {to}", {
                    amount: amountsText(move.amounts) || "0",
                    from: move.fromManagedAccountName,
                    to: targetName,
                  })
                : gt("{amount} of unassigned spend becomes billed to {to}", {
                    amount: amountsText(move.amounts) || "0",
                    to: targetName,
                  })
              : gt("{amount} stops being billed to {from}", {
                  amount: amountsText(move.amounts) || "0",
                  from: move.fromManagedAccountName ?? "",
                })}
          </li>
        ))}
      </ul>
      {preview.affectedDrafts > 0 && (
        <p className="text-xs text-warning">
          {preview.affectedDrafts === 1
            ? gt("1 draft invoice will change.")
            : gt("{count} draft invoices will change.", { count: preview.affectedDrafts })}
        </p>
      )}
      {preview.warnings.map((w) => (
        <p key={w} className="text-xs text-warning">
          {w}
        </p>
      ))}
    </div>
  );
}

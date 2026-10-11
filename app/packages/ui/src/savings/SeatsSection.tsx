import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { T, Var, useGT } from "gt-react";
import {
  MAX_SEAT_INACTIVE_DAYS,
  MIN_SEAT_INACTIVE_DAYS,
  formatMoney,
  seatFindingKey,
  seatHolderLabel,
  type SeatActivityBasis,
  type SeatFinding,
  type SeatListResponse,
  type SeatStatus,
  type SeatTotal,
  type SeatView,
} from "@infrawrench/client-core";
import { RemediateToggle, RemediationPanel } from "./RemediationPanel.js";
import type { SeatsClient } from "./types.js";

export interface SeatsSectionProps {
  /** Org-scoped data access; the hosting panel remounts per org. */
  client: SeatsClient;
}

function totalsText(totals: SeatTotal[]): string {
  return totals.map((t) => formatMoney(t.monthly, t.currency)).join(" + ");
}

const STATUS_TONE: Record<SeatStatus, string> = {
  inactive: "border-warning/40 text-warning",
  active: "border-border text-on-surface-tertiary",
  new: "border-border text-on-surface-tertiary",
  unknown: "border-border text-on-surface-faint",
  "pending-removal": "border-border text-on-surface-faint",
};

/**
 * "Seats" section of the Savings tab: paid SaaS seats (Copilot, Cursor,
 * GitLab, Okta...) beside the cloud findings, because an idle seat is the same
 * question as an idle volume. Findings first (inactive for the org's
 * threshold, the same person paying for two tools, a cheaper tier), then the
 * full inventory behind a disclosure, so "nothing to act on" never hides what
 * was checked. Activity the provider cannot evidence is shown as unknown and
 * never flagged.
 */
export function SeatsSection({ client }: SeatsSectionProps) {
  const gt = useGT();
  const [data, setData] = useState<SeatListResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openRemediation, setOpenRemediation] = useState<ReadonlySet<string>>(new Set());
  const [rowError, setRowError] = useState<Record<string, string>>({});
  const [rowNotice, setRowNotice] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [refreshNote, setRefreshNote] = useState<string | null>(null);
  const [daysDraft, setDaysDraft] = useState("");
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const requestSeq = useRef(0);

  const load = useCallback(async () => {
    const seq = ++requestSeq.current;
    setError(null);
    try {
      const next = await client.listSeats();
      if (seq !== requestSeq.current) return;
      setData(next);
      setDaysDraft(String(next.inactiveDays));
    } catch (e) {
      if (seq === requestSeq.current) setError(e instanceof Error ? e.message : String(e));
    }
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  const seatById = useMemo(() => new Map((data?.seats ?? []).map((s) => [s.id, s])), [data]);

  const toggleRemediation = useCallback((key: string) => {
    setOpenRemediation((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const statusLabel = (status: SeatStatus): string => {
    switch (status) {
      case "active":
        return gt("Active");
      case "inactive":
        return gt("Inactive");
      case "new":
        return gt("New");
      case "unknown":
        return gt("Activity unknown");
      case "pending-removal":
        return gt("Being removed");
    }
  };

  const basisLabel = (basis: SeatActivityBasis): string => {
    switch (basis) {
      case "last-activity":
        return gt("last use");
      case "last-login":
        return gt("last sign-in");
      case "usage-window":
        return gt("daily usage");
      case "none":
        return gt("not reported");
    }
  };

  const activityLine = (seat: SeatView): string => {
    if (seat.activityBasis === "none") return gt("The provider reports no activity for this seat");
    if (seat.status === "unknown" && seat.activityBasis === "usage-window") {
      return gt("No usage in the {days} days the provider reports", {
        days: seat.activityWindowDays ?? 0,
      });
    }
    if (seat.neverActive) {
      return seat.daysInactive !== null
        ? gt("Never used ({days} days since assigned)", { days: seat.daysInactive })
        : gt("Never used");
    }
    if (seat.lastActiveAt) {
      return gt("Last active {date} ({days} days ago)", {
        date: seat.lastActiveAt.slice(0, 10),
        days: seat.daysInactive ?? 0,
      });
    }
    return gt("No activity on record");
  };

  const findingLine = (finding: SeatFinding, seat: SeatView): string => {
    switch (finding.kind) {
      case "inactive":
        return gt("No use in {days}+ days", { days: data?.inactiveDays ?? 0 });
      case "duplicate":
        return gt("Also has {product} on {account}, used more recently", {
          product: finding.duplicate?.keptProduct ?? "",
          account: finding.duplicate?.keptAccountName ?? "",
        });
      case "downgrade":
        return gt("Could move from {from} to {to}", {
          from: seat.seatType,
          to: finding.targetSeatType ?? "",
        });
    }
  };

  const priceLabel = (seat: SeatView): string | null => {
    switch (seat.priceSource) {
      case "billing":
        return gt("billed");
      case "catalog":
        return gt("provider price");
      case "configured":
        return gt("your price");
      case "list-price":
        return gt("list price");
      default:
        return null;
    }
  };

  const remove = async (seat: SeatView) => {
    const message = gt("Remove the {product} seat for {holder} on {account}? {note}", {
      product: seat.product,
      holder: seatHolderLabel(seat),
      account: seat.accountName,
      note: seat.removalNote ?? "",
    });
    if (!window.confirm(message.trim())) return;
    setBusy(seat.id);
    setRowError((prev) => ({ ...prev, [seat.id]: "" }));
    try {
      const result = await client.removeSeat(seat.id);
      setRowNotice((prev) => ({
        ...prev,
        [seat.id]:
          result.message ??
          (result.effective === "end-of-cycle"
            ? gt("Removed. The provider bills it until the end of the cycle.")
            : gt("Removed.")),
      }));
      await load();
    } catch (e) {
      setRowError((prev) => ({ ...prev, [seat.id]: e instanceof Error ? e.message : String(e) }));
    } finally {
      setBusy(null);
    }
  };

  const requestRefresh = async () => {
    setRefreshNote(null);
    try {
      const { queued } = await client.refreshSeats();
      setRefreshNote(
        queued > 0
          ? gt("Collecting seats again; this takes a few minutes.")
          : gt("Seats are collected for new accounts within minutes."),
      );
    } catch (e) {
      setRefreshNote(e instanceof Error ? e.message : String(e));
    }
  };

  const saveDays = async () => {
    const value = Number(daysDraft);
    setSettingsError(null);
    try {
      await client.updateSeatSettings?.({ inactiveDays: value });
      await load();
    } catch (e) {
      setSettingsError(e instanceof Error ? e.message : String(e));
    }
  };

  const findings = data?.findings ?? [];
  const failed = data?.accounts.filter((a) => a.lastError) ?? [];
  const pendingFirstRead =
    data?.accounts.filter((a) => a.lastPolledAt === null && !a.lastError) ?? [];

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-on-surface">{gt("Seats")}</h2>
          <T>
            <p className="mt-1 text-xs text-on-surface-secondary">
              Paid SaaS seats nobody used in <Var>{data?.inactiveDays ?? 30}</Var> days, people
              paying for two tools that do the same job, and seats on a dearer tier than their usage
              needs.
            </p>
          </T>
        </div>
        <button
          type="button"
          onClick={() => void requestRefresh()}
          className="shrink-0 rounded-lg border border-border bg-surface-raised px-3 py-1.5 text-sm text-on-surface hover:border-border-strong"
        >
          {gt("Refresh")}
        </button>
      </div>

      {refreshNote && (
        <p role="status" className="text-xs text-on-surface-secondary">
          {refreshNote}
        </p>
      )}
      {error !== null && (
        <div role="alert" className="text-sm text-danger">
          {gt("Couldn't load seats:")} {error}{" "}
          <button type="button" onClick={() => void load()} className="underline">
            {gt("Retry")}
          </button>
        </div>
      )}
      {data === null && error === null && (
        <p role="status" className="text-sm text-on-surface-faint">
          {gt("Loading seats…")}
        </p>
      )}

      {data !== null && data.accounts.length === 0 && (
        <p className="text-sm text-on-surface-faint">
          {gt(
            "No connected account reports seats yet. Connect GitHub (Copilot), Cursor, GitLab, Okta, Claude Enterprise, Docker Hub or Tailscale to see them here.",
          )}
        </p>
      )}

      {data !== null && data.accounts.length > 0 && (
        <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
          {data.savingsMonthly.length > 0 && (
            <span className="text-on-surface">
              {gt("To save: {amount}/mo", { amount: totalsText(data.savingsMonthly) })}
            </span>
          )}
          {data.spendMonthly.length > 0 && (
            <span className="text-on-surface-secondary">
              {gt("Seats cost {amount}/mo", { amount: totalsText(data.spendMonthly) })}
            </span>
          )}
          <span className="text-on-surface-secondary">
            {gt("{count} seats", { count: data.counts.seats })}
          </span>
          {data.counts.unknownActivity > 0 && (
            <span className="text-on-surface-faint">
              {gt("{count} with activity the provider does not report", {
                count: data.counts.unknownActivity,
              })}
            </span>
          )}
        </div>
      )}

      {data !== null && data.accounts.length > 0 && findings.length === 0 && (
        <p className="text-sm text-on-surface-faint">
          {gt("No seat is inactive, duplicated or on a dearer tier than it needs.")}
        </p>
      )}

      {findings.length > 0 && (
        <div className="border border-border rounded-xl overflow-x-auto">
          <table className="w-full text-sm">
            <tbody>
              {findings.map((f) => {
                const seat = seatById.get(f.seatId);
                if (!seat) return null;
                const key = seatFindingKey(f);
                const open = openRemediation.has(key);
                return (
                  <FindingRows
                    key={key}
                    open={open}
                    seat={seat}
                    finding={f}
                    line={findingLine(f, seat)}
                    activity={`${activityLine(seat)} · ${basisLabel(seat.activityBasis)}`}
                    activityTitle={seat.activitySource}
                    priceLabel={priceLabel(seat)}
                    busy={busy === seat.id}
                    error={rowError[seat.id] || null}
                    notice={rowNotice[seat.id] || null}
                    onRemove={() => void remove(seat)}
                    onToggle={() => toggleRemediation(key)}
                  />
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {data !== null && data.seats.length > 0 && (
        <div>
          <button
            type="button"
            aria-expanded={showAll}
            onClick={() => setShowAll((v) => !v)}
            className="text-xs font-medium text-info hover:text-info-strong"
          >
            {showAll
              ? gt("Hide all seats")
              : gt("Show all {count} seats", { count: data.seats.length })}
          </button>
          {showAll && (
            <div className="mt-2 border border-border rounded-xl overflow-x-auto">
              <table className="w-full text-sm">
                <tbody>
                  {data.seats.map((seat) => (
                    <tr key={seat.id} className="border-b border-border last:border-b-0 align-top">
                      <td className="px-4 py-2 whitespace-nowrap text-on-surface">
                        {seatHolderLabel(seat)}
                        {seat.email && seat.name && (
                          <div className="text-xs text-on-surface-tertiary">{seat.email}</div>
                        )}
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap text-on-surface-secondary">
                        {seat.product} · {seat.seatType}
                        <div className="text-xs text-on-surface-tertiary">{seat.accountName}</div>
                      </td>
                      <td className="px-3 py-2 w-full text-xs text-on-surface-secondary">
                        <span
                          className={`mr-2 rounded-full border px-2 py-0.5 ${STATUS_TONE[seat.status]}`}
                        >
                          {statusLabel(seat.status)}
                        </span>
                        <span title={seat.activitySource}>{activityLine(seat)}</span>
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap text-right text-on-surface">
                        {seat.monthlyPrice !== null && seat.currency ? (
                          <>
                            {formatMoney(seat.monthlyPrice, seat.currency)}
                            <span className="ml-1 text-xs text-on-surface-faint">/mo</span>
                          </>
                        ) : (
                          <span className="text-xs text-on-surface-faint">{gt("not priced")}</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {failed.length > 0 && (
        <div role="status" className="text-xs text-warning">
          {failed.map((a) => (
            <p key={a.accountId}>
              {gt("Couldn't read seats from {account}: {error}", {
                account: a.accountName,
                error: a.lastError ?? "",
              })}
            </p>
          ))}
        </div>
      )}
      {pendingFirstRead.length > 0 && (
        <p role="status" className="text-xs text-on-surface-faint">
          {gt("Waiting for the first seat read from {accounts}.", {
            accounts: pendingFirstRead.map((a) => a.accountName).join(", "),
          })}
        </p>
      )}

      {data !== null && client.updateSeatSettings && (
        <div className="flex flex-wrap items-center gap-2 text-xs text-on-surface-secondary">
          <label htmlFor="seat-inactive-days">{gt("Flag seats unused for")}</label>
          <input
            id="seat-inactive-days"
            type="number"
            min={MIN_SEAT_INACTIVE_DAYS}
            max={MAX_SEAT_INACTIVE_DAYS}
            value={daysDraft}
            onChange={(e) => setDaysDraft(e.target.value)}
            className="w-20 rounded-md border border-border bg-surface px-2 py-1 text-on-surface"
          />
          <span>{gt("days")}</span>
          {daysDraft !== String(data.inactiveDays) && (
            <button
              type="button"
              onClick={() => void saveDays()}
              className="rounded-md border border-border px-2 py-1 text-on-surface hover:border-border-strong"
            >
              {gt("Save")}
            </button>
          )}
          {settingsError && (
            <span role="alert" className="text-danger">
              {settingsError}
            </span>
          )}
        </div>
      )}

      {findings.length > 0 && (
        <p className="text-xs text-on-surface-faint">
          {gt(
            "Prices are the provider's bill or price list where it reports one, otherwise the published list price or the price set on the account (hover a figure). Removals respect change freezes, are audited and count toward realized savings.",
          )}
        </p>
      )}
    </section>
  );
}

interface FindingRowsProps {
  seat: SeatView;
  finding: SeatFinding;
  line: string;
  activity: string;
  activityTitle: string;
  priceLabel: string | null;
  open: boolean;
  busy: boolean;
  error: string | null;
  notice: string | null;
  onRemove: () => void;
  onToggle: () => void;
}

function FindingRows({
  seat,
  finding,
  line,
  activity,
  activityTitle,
  priceLabel,
  open,
  busy,
  error,
  notice,
  onRemove,
  onToggle,
}: FindingRowsProps) {
  const gt = useGT();
  const canRemove = finding.kind !== "downgrade" && seat.removable && !notice;
  return (
    <>
      <tr className={`border-border align-top ${open ? "" : "border-b last:border-b-0"}`}>
        <td className="px-4 py-2.5 whitespace-nowrap font-medium text-on-surface">
          {seatHolderLabel(seat)}
          <div className="text-xs font-normal text-on-surface-tertiary">
            {seat.product} · {seat.seatType} · {seat.accountName}
          </div>
        </td>
        <td className="px-3 py-2.5 w-full text-on-surface-secondary">
          <div className="text-sm text-on-surface">{line}</div>
          <div className="mt-0.5 text-xs" title={activityTitle}>
            {activity}
          </div>
          {finding.reason && (
            <div className="mt-0.5 text-xs text-on-surface-faint">{finding.reason}</div>
          )}
          {error && (
            <div role="alert" className="mt-1 text-xs text-danger">
              {error}
            </div>
          )}
          {notice && (
            <div role="status" className="mt-1 text-xs text-success">
              {notice}
            </div>
          )}
        </td>
        <td className="px-3 py-2.5 whitespace-nowrap text-right text-on-surface">
          {finding.monthlySaving !== null && finding.currency ? (
            <>
              {formatMoney(finding.monthlySaving, finding.currency)}
              <span className="ml-1 text-xs text-on-surface-faint">/mo</span>
              {priceLabel && (
                <div className="text-xs text-on-surface-faint" title={seat.priceNote ?? undefined}>
                  {priceLabel}
                </div>
              )}
            </>
          ) : (
            <span className="text-xs text-on-surface-faint">{gt("not priced")}</span>
          )}
        </td>
        <td className="px-3 py-2.5 whitespace-nowrap text-right">
          <div className="flex items-center justify-end gap-3">
            <RemediateToggle remediation={finding.remediation} open={open} onToggle={onToggle} />
            {canRemove && (
              <button
                type="button"
                disabled={busy}
                onClick={onRemove}
                className="text-xs font-medium text-danger hover:underline disabled:opacity-50"
              >
                {busy ? gt("Removing…") : gt("Remove seat")}
              </button>
            )}
          </div>
        </td>
      </tr>
      {open && finding.remediation && (
        <tr className="border-b border-border last:border-b-0">
          <td colSpan={4} className="px-4 pb-3">
            <RemediationPanel
              remediation={finding.remediation}
              {...(canRemove ? { oneClickLabel: gt("Remove seat") } : {})}
            />
          </td>
        </tr>
      )}
    </>
  );
}

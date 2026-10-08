import { useCallback, useEffect, useMemo, useState } from "react";
import { useGT } from "gt-react";
import type { MetricSeries } from "@infrawrench/plugin-base";
import {
  SLO_BURN_POLICIES,
  SLO_BURN_WINDOWS,
  SLO_FREEZE_DURATIONS_HOURS,
  buildSloHistory,
  compareSloStatus,
  formatBudgetDuration,
  formatBurnRate,
  formatSloPercent,
  formatSloTarget,
  sloBurnRateThreshold,
  type Slo,
  type SloDetailResponse,
  type SloStatus,
} from "@infrawrench/client-core";
import { MetricChart } from "../components/charts/MetricChart.js";
import { IssueIndicator } from "../components/IssueIndicator.js";
import { Modal } from "../components/Modal.js";
import { SloEditorModal } from "./SloEditorModal.js";
import type { SlosClient } from "./types.js";

export interface SlosPanelProps {
  client: SlosClient;
  /** The SLO whose detail is open; undefined shows the list. */
  sloId?: string | undefined;
  /** Open an SLO (or go back to the list with null). Hosts mirror it into the URL. */
  onSloChange: (sloId: string | null) => void;
}

type Gt = ReturnType<typeof useGT>;

export function sloStatusLabel(status: SloStatus, gt: Gt): string {
  switch (status) {
    case "exhausted":
      return gt("Budget exhausted");
    case "fast_burn":
      return gt("Fast burn");
    case "slow_burn":
      return gt("Slow burn");
    case "ok":
      return gt("Within budget");
    case "unknown":
      return gt("No data");
  }
}

function statusClass(status: SloStatus): string {
  switch (status) {
    case "exhausted":
    case "fast_burn":
      return "text-danger";
    case "slow_burn":
      return "text-warning";
    case "ok":
      return "text-success";
    case "unknown":
      return "text-on-surface-faint";
  }
}

/** The source in words, translated; `describeSloSource` is the English copy for the CLI. */
export function useSloSourceText(slo: Slo): string {
  const gt = useGT();
  switch (slo.sliKind) {
    case "probe_availability":
      return slo.probeName
        ? gt("Availability of probe {name}", { name: slo.probeName })
        : gt("Availability of a deleted probe");
    case "probe_latency":
      return slo.probeName
        ? gt("Probe {name} answering within {ms} ms", {
            name: slo.probeName,
            ms: slo.latencyThresholdMs ?? 0,
          })
        : gt("Latency of a deleted probe");
    case "metric_threshold":
      return gt("{metric} {comparator} {threshold} on {resource}", {
        metric: slo.metricKey ?? "",
        comparator: slo.comparator ?? "",
        threshold: slo.threshold ?? 0,
        resource: slo.resourceName ?? gt("a deleted resource"),
      });
  }
}

function BudgetBar({ remaining }: { remaining: number | null }) {
  const pct = remaining === null ? 0 : Math.max(0, Math.min(1, remaining)) * 100;
  const tone =
    remaining === null
      ? "bg-on-surface-faint/30"
      : remaining <= 0
        ? "bg-danger"
        : remaining < 0.25
          ? "bg-warning"
          : "bg-on-surface-secondary/60";
  return (
    <div className="h-1.5 w-full rounded-full bg-surface-sunken overflow-hidden" aria-hidden="true">
      <div className={`h-full ${tone}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

function BudgetText({ slo }: { slo: Slo }) {
  const gt = useGT();
  if (slo.budgetRemaining === null || slo.budgetRemainingMinutes === null) {
    return <span className="text-on-surface-faint">{gt("No data yet")}</span>;
  }
  if (slo.budgetRemaining <= 0) {
    return (
      <span className="text-danger">
        {gt("Overspent by {duration}", {
          duration: formatBudgetDuration(slo.budgetRemainingMinutes),
        })}
      </span>
    );
  }
  return (
    <span>
      {gt("{pct} left ({duration})", {
        pct: `${Number((slo.budgetRemaining * 100).toFixed(1))}%`,
        duration: formatBudgetDuration(slo.budgetRemainingMinutes),
      })}
    </span>
  );
}

function SloRow({ slo, onOpen }: { slo: Slo; onOpen: () => void }) {
  const gt = useGT();
  const source = useSloSourceText(slo);
  const burn1h = slo.burnRates["1h"];
  return (
    <li className="rounded-xl border border-border bg-surface-raised">
      <button type="button" onClick={onOpen} className="w-full text-left px-4 py-3">
        <div className="flex items-center gap-2">
          {(slo.status === "exhausted" || slo.status === "fast_burn") && (
            <IssueIndicator tone="danger" reason={sloStatusLabel(slo.status, gt)} />
          )}
          {slo.status === "slow_burn" && (
            <IssueIndicator tone="warning" reason={sloStatusLabel(slo.status, gt)} />
          )}
          <span className="font-medium text-sm text-on-surface truncate">{slo.name}</span>
          <span className={`text-xs ${statusClass(slo.status)}`}>
            {slo.enabled ? sloStatusLabel(slo.status, gt) : gt("Disabled")}
          </span>
          <span className="ml-auto text-xs text-on-surface-secondary tabular-nums">
            {slo.sli === null ? "-" : formatSloPercent(slo.sli)}
            {" / "}
            {formatSloTarget(slo.targetPercent)}
          </span>
        </div>
        <p className="mt-0.5 text-xs text-on-surface-faint truncate">
          {source} · {gt("{days} day window", { days: slo.windowDays })}
        </p>
        <div className="mt-2 flex items-center gap-3">
          <div className="flex-1">
            <BudgetBar remaining={slo.budgetRemaining} />
          </div>
          <span className="text-xs text-on-surface-secondary tabular-nums shrink-0">
            <BudgetText slo={slo} />
          </span>
          {burn1h !== null && burn1h !== undefined && (
            <span className="text-xs text-on-surface-faint tabular-nums shrink-0">
              {gt("1h burn {rate}", { rate: formatBurnRate(burn1h) })}
            </span>
          )}
        </div>
      </button>
    </li>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string | undefined }) {
  return (
    <div className="rounded-xl border border-border bg-surface-raised px-3 py-2">
      <div className="text-[11px] uppercase tracking-wide text-on-surface-faint">{label}</div>
      <div className="text-lg font-semibold text-on-surface tabular-nums">{value}</div>
      {hint && <div className="text-xs text-on-surface-faint">{hint}</div>}
    </div>
  );
}

function FreezeModal({
  slo,
  client,
  onClose,
  onStarted,
}: {
  slo: Slo;
  client: SlosClient;
  onClose: () => void;
  onStarted: () => void;
}) {
  const gt = useGT();
  const [duration, setDuration] = useState<string>("24");
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const durationLabel = (hours: number | null) =>
    hours === null
      ? gt("Until ended")
      : hours === 24
        ? gt("24 hours")
        : hours === 72
          ? gt("3 days")
          : gt("7 days");

  const start = async () => {
    if (!client.startFreeze) return;
    setSaving(true);
    setError(null);
    try {
      await client.startFreeze(slo.id, {
        durationHours: duration === "none" ? null : Number(duration),
        ...(reason.trim() ? { reason: reason.trim() } : {}),
      });
      onStarted();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : gt("Failed to start the change freeze"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal onClose={() => (saving ? undefined : onClose())} ariaLabel={gt("Start a change freeze")}>
      <div className="w-[26rem] max-w-[90vw] rounded-2xl border border-border bg-surface p-5 shadow-xl">
        <h2 className="text-sm font-semibold text-on-surface">{gt("Start a change freeze")}</h2>
        <p className="mt-1 text-xs text-on-surface-secondary">
          {gt(
            "Blocks destructive changes org-wide until it ends. It is an ordinary freeze: it shows on the operations calendar and can be ended early in Settings.",
          )}
        </p>
        <div className="mt-4 flex flex-col gap-3">
          <div>
            <label
              className="block text-xs font-medium text-on-surface-secondary mb-1"
              htmlFor="slo-freeze-duration"
            >
              {gt("Duration")}
            </label>
            <select
              id="slo-freeze-duration"
              className="w-full rounded-lg border border-border bg-surface-sunken px-2.5 py-1.5 text-sm text-on-surface"
              value={duration}
              onChange={(e) => setDuration(e.target.value)}
            >
              {SLO_FREEZE_DURATIONS_HOURS.map((h) => (
                <option key={String(h)} value={h === null ? "none" : String(h)}>
                  {durationLabel(h)}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label
              className="block text-xs font-medium text-on-surface-secondary mb-1"
              htmlFor="slo-freeze-reason"
            >
              {gt("Reason (optional)")}
            </label>
            <input
              id="slo-freeze-reason"
              type="text"
              className="w-full rounded-lg border border-border bg-surface-sunken px-2.5 py-1.5 text-sm text-on-surface"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder={gt("Error budget exhausted")}
            />
          </div>
          {error && (
            <div role="alert" className="text-sm text-danger">
              {error}
            </div>
          )}
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={saving}
              className="rounded-lg border border-border bg-surface-raised px-3 py-1.5 text-sm text-on-surface disabled:opacity-50"
            >
              {gt("Cancel")}
            </button>
            <button
              type="button"
              onClick={() => void start()}
              disabled={saving}
              className="rounded-lg bg-blue-600 hover:bg-blue-500 px-3 py-1.5 text-sm text-white disabled:opacity-50"
            >
              {saving ? gt("Starting…") : gt("Start freeze")}
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}

function SloDetail({
  client,
  detail,
  canWrite,
  onBack,
  onEdit,
  onChanged,
}: {
  client: SlosClient;
  detail: SloDetailResponse;
  canWrite: boolean;
  onBack: () => void;
  onEdit: () => void;
  onChanged: () => void;
}) {
  const gt = useGT();
  const { slo, buckets, activeFreeze } = detail;
  const source = useSloSourceText(slo);
  const [freezing, setFreezing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const history = useMemo(() => buildSloHistory(buckets, slo.targetPercent), [buckets, slo]);

  const sliSeries: MetricSeries[] = useMemo(() => {
    if (history.dailySli.length === 0) return [];
    return [
      {
        label: gt("Daily SLI"),
        unit: "%",
        points: history.dailySli.map((p) => ({ timestamp: p.tsMs, value: p.value })),
      },
      {
        label: gt("Target"),
        unit: "%",
        points: history.dailySli.map((p) => ({ timestamp: p.tsMs, value: slo.targetPercent })),
      },
    ];
  }, [history, slo.targetPercent, gt]);

  const burndownSeries: MetricSeries[] = useMemo(
    () =>
      history.budgetBurndown.length === 0
        ? []
        : [
            {
              label: gt("Budget remaining"),
              unit: "%",
              points: history.budgetBurndown.map((p) => ({ timestamp: p.tsMs, value: p.value })),
            },
          ],
    [history, gt],
  );

  const suggestFreeze =
    slo.suggestFreeze && slo.status === "exhausted" && !activeFreeze && !!client.startFreeze;

  const toggleEnabled = async () => {
    try {
      await client.updateSlo?.(slo.id, { enabled: !slo.enabled });
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : gt("Failed to update the SLO"));
    }
  };

  const remove = async () => {
    if (!window.confirm(gt('Delete SLO "{name}"?', { name: slo.name }))) return;
    try {
      await client.deleteSlo?.(slo.id);
      onBack();
    } catch (e) {
      setError(e instanceof Error ? e.message : gt("Failed to delete the SLO"));
    }
  };

  return (
    <div className="space-y-5">
      <div>
        <button
          type="button"
          onClick={onBack}
          className="text-xs text-on-surface-secondary hover:text-on-surface"
        >
          {gt("← All SLOs")}
        </button>
        <div className="mt-1 flex items-start gap-3">
          <div className="flex-1 min-w-0">
            <h2 className="text-base font-semibold text-on-surface">{slo.name}</h2>
            <p className="text-xs text-on-surface-faint">
              {source} ·{" "}
              {gt("{target} over {days} days", {
                target: formatSloTarget(slo.targetPercent),
                days: slo.windowDays,
              })}
            </p>
            {slo.description && (
              <p className="mt-1 text-sm text-on-surface-secondary">{slo.description}</p>
            )}
          </div>
          {canWrite && (
            <div className="flex items-center gap-1.5 shrink-0">
              <button
                type="button"
                onClick={() => void toggleEnabled()}
                className="px-2 py-1 rounded-lg text-xs text-on-surface-secondary hover:bg-surface-sunken"
              >
                {slo.enabled ? gt("Disable") : gt("Enable")}
              </button>
              <button
                type="button"
                onClick={onEdit}
                className="px-2 py-1 rounded-lg text-xs text-on-surface-secondary hover:bg-surface-sunken"
              >
                {gt("Edit")}
              </button>
              <button
                type="button"
                onClick={() => void remove()}
                className="px-2 py-1 rounded-lg text-xs text-danger hover:bg-surface-sunken"
              >
                {gt("Delete")}
              </button>
            </div>
          )}
        </div>
      </div>

      {error && <p className="text-sm text-danger">{error}</p>}
      {slo.lastError && (
        <p className="text-sm text-warning">
          {gt("Last evaluation could not measure this SLO: {error}", { error: slo.lastError })}
        </p>
      )}

      {suggestFreeze && (
        <div className="rounded-xl border border-danger-border bg-danger-surface px-4 py-3 flex items-center gap-3">
          <p className="flex-1 text-sm text-danger-on-surface">
            {gt(
              "The error budget is spent. Consider a change freeze until reliability recovers, so nothing else spends what is not there.",
            )}
          </p>
          <button
            type="button"
            onClick={() => setFreezing(true)}
            className="shrink-0 rounded-lg bg-blue-600 hover:bg-blue-500 px-3 py-1.5 text-sm text-white"
          >
            {gt("Start a change freeze")}
          </button>
        </div>
      )}
      {slo.status === "exhausted" && activeFreeze && (
        <p className="text-sm text-on-surface-secondary">
          {gt("Change freeze in effect: {name}", { name: activeFreeze.name })}
        </p>
      )}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
        <Stat
          label={gt("Status")}
          value={slo.enabled ? sloStatusLabel(slo.status, gt) : gt("Disabled")}
        />
        <Stat
          label={gt("Current SLI")}
          value={slo.sli === null ? "-" : formatSloPercent(slo.sli)}
          hint={gt("Target {target}", { target: formatSloTarget(slo.targetPercent) })}
        />
        <Stat
          label={gt("Budget remaining")}
          value={
            slo.budgetRemaining === null
              ? "-"
              : `${Number((slo.budgetRemaining * 100).toFixed(1))}%`
          }
          hint={
            slo.budgetRemainingMinutes === null
              ? undefined
              : slo.budgetRemainingMinutes >= 0
                ? gt("{duration} left", {
                    duration: formatBudgetDuration(slo.budgetRemainingMinutes),
                  })
                : gt("Overspent by {duration}", {
                    duration: formatBudgetDuration(slo.budgetRemainingMinutes),
                  })
          }
        />
        <Stat
          label={gt("Budget total")}
          value={formatBudgetDuration(slo.budgetTotalMinutes)}
          hint={gt("{count} minutes measured", { count: Math.round(slo.totalEvents) })}
        />
      </div>

      <section>
        <h3 className="text-sm font-semibold text-on-surface mb-1">{gt("Burn rates")}</h3>
        <p className="text-xs text-on-surface-faint mb-2">
          {gt(
            "1× spends exactly the budget over the window. Alerts need both the long and the short window over the threshold.",
          )}
        </p>
        <div className="grid grid-cols-5 gap-2">
          {SLO_BURN_WINDOWS.map((w) => {
            const rate = slo.burnRates[w];
            return (
              <div key={w} className="rounded-lg border border-border px-2 py-1.5 text-center">
                <div className="text-[11px] text-on-surface-faint">{w}</div>
                <div className="text-sm font-medium text-on-surface tabular-nums">
                  {rate === null || rate === undefined ? "-" : formatBurnRate(rate)}
                </div>
              </div>
            );
          })}
        </div>
        <ul className="mt-2 space-y-0.5 text-xs text-on-surface-secondary">
          {SLO_BURN_POLICIES.map((p) => (
            <li key={p.id}>
              {p.severity === "page"
                ? gt("Page when {long} and {short} both burn at {rate} or faster", {
                    long: p.longWindow,
                    short: p.shortWindow,
                    rate: formatBurnRate(sloBurnRateThreshold(p, slo.windowDays)),
                  })
                : gt("Ticket when {long} and {short} both burn at {rate} or faster", {
                    long: p.longWindow,
                    short: p.shortWindow,
                    rate: formatBurnRate(sloBurnRateThreshold(p, slo.windowDays)),
                  })}
            </li>
          ))}
        </ul>
        {!slo.alertsEnabled && (
          <p className="mt-1 text-xs text-on-surface-faint">
            {gt("Alerts are off for this SLO; the burn rates are still computed.")}
          </p>
        )}
      </section>

      <section className="space-y-4">
        {sliSeries.length > 0 ? (
          <MetricChart
            node={{
              kind: "metric-chart",
              title: gt("SLI per day"),
              series: sliSeries,
              timeRangeLabel: gt("Last {days} days", { days: slo.windowDays }),
            }}
          />
        ) : (
          <p className="text-sm text-on-surface-faint">
            {gt("No events in the window yet, so there is nothing to chart.")}
          </p>
        )}
        {burndownSeries.length > 0 && (
          <MetricChart
            node={{
              kind: "metric-chart",
              title: gt("Error budget burndown"),
              series: burndownSeries,
              timeRangeLabel: gt("Share of the window's budget left after each hour"),
            }}
          />
        )}
      </section>

      {freezing && (
        <FreezeModal
          slo={slo}
          client={client}
          onClose={() => setFreezing(false)}
          onStarted={onChanged}
        />
      )}
    </div>
  );
}

/**
 * Service-level objectives: the list, and one SLO's detail with its SLI and
 * budget-burndown charts. Shared between web and desktop; write actions are
 * gated on the client exposing the write methods (the `ProbesPanel`
 * convention). Which SLO is open is a prop the host mirrors into the URL.
 */
export function SlosPanel({ client, sloId, onSloChange }: SlosPanelProps) {
  const gt = useGT();
  const [slos, setSlos] = useState<Slo[] | null>(null);
  const [detail, setDetail] = useState<SloDetailResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ existing: Slo | null } | null>(null);
  const canWrite = Boolean(client.createSlo && client.updateSlo && client.deleteSlo);

  const reload = useCallback(() => {
    setError(null);
    if (sloId) {
      client
        .getSlo(sloId)
        .then(setDetail)
        .catch((e) => setError(e instanceof Error ? e.message : gt("Failed to load the SLO")));
    } else {
      client
        .listSlos()
        .then((list) =>
          setSlos(
            [...list].sort(
              (a, b) => compareSloStatus(a.status, b.status) || a.name.localeCompare(b.name),
            ),
          ),
        )
        .catch((e) => setError(e instanceof Error ? e.message : gt("Failed to load SLOs")));
    }
  }, [client, sloId, gt]);

  useEffect(() => {
    setDetail(null);
    reload();
  }, [reload]);

  return (
    <div className="space-y-6">
      {error && (
        <p className="text-sm text-danger">
          {error}{" "}
          <button type="button" onClick={reload} className="underline">
            {gt("Retry")}
          </button>
        </p>
      )}

      {sloId ? (
        detail ? (
          <SloDetail
            client={client}
            detail={detail}
            canWrite={canWrite}
            onBack={() => onSloChange(null)}
            onEdit={() => setEditing({ existing: detail.slo })}
            onChanged={reload}
          />
        ) : (
          !error && <p className="text-sm text-on-surface-faint">{gt("Loading SLO…")}</p>
        )
      ) : (
        <section>
          <div className="flex items-center justify-between mb-2">
            <div>
              <h2 className="text-base font-semibold text-on-surface">{gt("SLOs")}</h2>
              <p className="text-xs text-on-surface-faint">
                {gt(
                  "Service-level objectives measured from your probes and metrics, with error budgets and burn-rate alerts.",
                )}
              </p>
            </div>
            {canWrite && (
              <button
                type="button"
                onClick={() => setEditing({ existing: null })}
                className="px-3 py-1.5 rounded-lg text-sm bg-blue-600 hover:bg-blue-500 text-white transition-colors"
              >
                {gt("New SLO")}
              </button>
            )}
          </div>
          {slos === null && !error && (
            <p className="text-sm text-on-surface-faint">{gt("Loading SLOs…")}</p>
          )}
          {slos !== null && slos.length === 0 && (
            <p className="text-sm text-on-surface-faint">
              {gt(
                "No SLOs yet. Create one from a synthetic probe or a resource metric to start tracking an error budget.",
              )}
            </p>
          )}
          {slos !== null && slos.length > 0 && (
            <ul className="space-y-2">
              {slos.map((slo) => (
                <SloRow key={slo.id} slo={slo} onOpen={() => onSloChange(slo.id)} />
              ))}
            </ul>
          )}
        </section>
      )}

      {editing && (
        <SloEditorModal
          client={client}
          existing={editing.existing}
          onSaved={(saved) => {
            if (!editing.existing && saved) onSloChange(saved.id);
            else reload();
          }}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}

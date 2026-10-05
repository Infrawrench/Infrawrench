import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { T, Var, useGT } from "gt-react";
import { formatDaysOfWeek, formatMoney } from "@infrawrench/client-core";
import { ScheduleEditorModal } from "./ScheduleEditorModal.js";
import { RemediateToggle, RemediationPanel } from "../savings/RemediationPanel.js";
import type { SchedulesClient, SleepSchedule } from "./types.js";

export interface SleepSchedulesSectionProps {
  /** Org-scoped data access; the hosting panel remounts on org switch. */
  client: SchedulesClient;
  /** Navigate to a scheduled resource's detail view. */
  onOpenResource?: ((schedule: SleepSchedule) => void) | undefined;
}

function formatInstant(iso: string, timezone: string): string {
  try {
    return new Intl.DateTimeFormat(undefined, {
      timeZone: timezone,
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

function LastRunBadge({ schedule }: { schedule: SleepSchedule }) {
  const gt = useGT();
  if (!schedule.lastRunStatus) return null;
  const label =
    schedule.lastRunStatus === "ok"
      ? schedule.lastRunAction === "stop"
        ? gt("Stopped ok")
        : gt("Started ok")
      : schedule.lastRunStatus === "skipped_freeze"
        ? gt("Skipped: freeze")
        : gt("Failed");
  const tone =
    schedule.lastRunStatus === "ok"
      ? "border-border text-on-surface-tertiary"
      : schedule.lastRunStatus === "skipped_freeze"
        ? "border-amber-500/50 text-warning"
        : "border-red-500/50 text-danger";
  return (
    <span
      className={`rounded-full border px-2 py-0.5 text-xs ${tone}`}
      title={schedule.lastRunError ?? undefined}
    >
      {label}
    </span>
  );
}

/**
 * "Sleep schedules" section of the Costs panel: every off-at/on-at window in
 * the org, with the next transition, the last run's outcome (freeze skips and
 * failures included, never silent), the projected monthly saving, and
 * pause/edit/delete controls. Schedules are created from the resource detail
 * page's Schedule tab, where the resource is already in front of the user.
 */
export function SleepSchedulesSection({ client, onOpenResource }: SleepSchedulesSectionProps) {
  const gt = useGT();
  const [schedules, setSchedules] = useState<SleepSchedule[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<SleepSchedule | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  /** Rows whose Remediate panel is expanded. */
  const [openRemediation, setOpenRemediation] = useState<ReadonlySet<string>>(new Set());
  const toggleRemediation = useCallback((id: string) => {
    setOpenRemediation((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);
  const requestSeq = useRef(0);

  const refresh = useCallback(async () => {
    const seq = ++requestSeq.current;
    setError(null);
    try {
      const next = await client.listSchedules();
      if (seq === requestSeq.current) setSchedules(next.schedules);
    } catch (e) {
      if (seq === requestSeq.current) setError(e instanceof Error ? e.message : String(e));
    }
  }, [client]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const togglePause = async (schedule: SleepSchedule) => {
    setBusyId(schedule.id);
    try {
      await client.updateSchedule(schedule.id, { paused: !schedule.paused });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (schedule: SleepSchedule) => {
    if (
      !window.confirm(
        gt("Delete the sleep schedule for {name}? The resource stays in whatever state it is in.", {
          name: schedule.resourceName,
        }),
      )
    ) {
      return;
    }
    setBusyId(schedule.id);
    try {
      await client.deleteSchedule(schedule.id);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  };

  const totalSaving = (schedules ?? []).reduce<Map<string, number>>((acc, s) => {
    if (s.projectedMonthlySaving != null && s.currency && !s.paused) {
      acc.set(s.currency, (acc.get(s.currency) ?? 0) + s.projectedMonthlySaving);
    }
    return acc;
  }, new Map());

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-on-surface">{gt("Sleep schedules")}</h2>
          <T>
            <p className="mt-1 text-xs text-on-surface-secondary">
              Stops and starts non-prod resources on a schedule.
              <Var>
                {totalSaving.size > 0 ? (
                  <>
                    {" "}
                    {gt("Projected saving")}{" "}
                    <span className="font-medium text-on-surface">
                      {[...totalSaving.entries()]
                        .map(([currency, amount]) => `${formatMoney(amount, currency)}/mo`)
                        .join(" + ")}
                    </span>
                    .
                  </>
                ) : null}
              </Var>
            </p>
          </T>
        </div>
        <button
          type="button"
          onClick={() => void refresh()}
          className="shrink-0 rounded-lg border border-border bg-surface-raised px-3 py-1.5 text-sm text-on-surface hover:border-border-strong"
        >
          {gt("Refresh")}
        </button>
      </div>

      {error !== null && (
        <div role="alert" className="text-sm text-danger">
          {gt("Couldn't load sleep schedules: {error}", { error })}{" "}
          <button type="button" onClick={() => void refresh()} className="underline">
            {gt("Retry")}
          </button>
        </div>
      )}
      {schedules === null && error === null && (
        <p role="status" className="text-sm text-on-surface-faint">
          {gt("Loading schedules…")}
        </p>
      )}
      {schedules !== null && schedules.length === 0 && (
        <p className="text-sm text-on-surface-faint">
          {gt("No schedules yet. Add one from a stoppable resource's Schedule tab.")}
        </p>
      )}

      {schedules !== null && schedules.length > 0 && (
        <div className="border border-border rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <tbody>
              {schedules.map((s) => (
                <Fragment key={s.id}>
                  <tr
                    className={`border-border ${
                      openRemediation.has(s.id) ? "" : "border-b last:border-b-0"
                    }`}
                  >
                    <td className="px-4 py-2.5 whitespace-nowrap">
                      <button
                        type="button"
                        onClick={onOpenResource ? () => onOpenResource(s) : undefined}
                        className={`font-medium text-on-surface ${onOpenResource ? "hover:underline" : "cursor-default"}`}
                      >
                        {s.resourceName}
                      </button>
                      <div className="text-xs text-on-surface-faint">{s.accountName}</div>
                    </td>
                    <td className="px-3 py-2.5 whitespace-nowrap text-on-surface-secondary">
                      {gt("{days} · off {stopTime} → on {startTime}", {
                        days: formatDaysOfWeek(s.daysOfWeek),
                        stopTime: s.stopTime,
                        startTime: s.startTime,
                      })}
                      <div className="text-xs text-on-surface-faint">{s.timezone}</div>
                    </td>
                    <td className="px-3 py-2.5 whitespace-nowrap text-on-surface-secondary">
                      {s.paused ? (
                        <span className="rounded-full border border-border px-2 py-0.5 text-xs text-on-surface-tertiary">
                          {gt("Paused")}
                        </span>
                      ) : s.nextTransitionAt ? (
                        gt("{action} {time}", {
                          action: s.nextTransitionAction === "stop" ? gt("Off") : gt("On"),
                          time: formatInstant(s.nextTransitionAt, s.timezone),
                        })
                      ) : (
                        <span className="text-on-surface-faint">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2.5 whitespace-nowrap">
                      <LastRunBadge schedule={s} />
                    </td>
                    <td className="px-3 py-2.5 whitespace-nowrap text-right text-on-surface">
                      {s.projectedMonthlySaving != null && s.currency ? (
                        <>
                          {formatMoney(s.projectedMonthlySaving, s.currency)}
                          <span className="ml-1 text-xs text-on-surface-faint">{gt("/mo")}</span>
                        </>
                      ) : (
                        <span className="text-on-surface-faint">—</span>
                      )}
                    </td>
                    <td className="px-4 py-2.5 whitespace-nowrap text-right">
                      <div className="flex items-center justify-end gap-2">
                        <RemediateToggle
                          remediation={s.remediation}
                          open={openRemediation.has(s.id)}
                          onToggle={() => toggleRemediation(s.id)}
                        />
                        <button
                          type="button"
                          disabled={busyId === s.id}
                          onClick={() => void togglePause(s)}
                          className="rounded-lg border border-border bg-surface-raised px-2.5 py-1 text-xs text-on-surface hover:border-border-strong disabled:opacity-50"
                        >
                          {s.paused ? gt("Resume") : gt("Pause")}
                        </button>
                        <button
                          type="button"
                          disabled={busyId === s.id}
                          onClick={() => setEditing(s)}
                          className="rounded-lg border border-border bg-surface-raised px-2.5 py-1 text-xs text-on-surface hover:border-border-strong disabled:opacity-50"
                        >
                          {gt("Edit")}
                        </button>
                        <button
                          type="button"
                          disabled={busyId === s.id}
                          onClick={() => void remove(s)}
                          className="rounded-lg border border-border bg-surface-raised px-2.5 py-1 text-xs text-danger hover:border-red-500/50 disabled:opacity-50"
                        >
                          {gt("Delete")}
                        </button>
                      </div>
                    </td>
                  </tr>
                  {openRemediation.has(s.id) && s.remediation && (
                    <tr className="border-b border-border last:border-b-0">
                      <td colSpan={6} className="px-4 pb-3">
                        <RemediationPanel remediation={s.remediation} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {schedules !== null && schedules.length > 0 && (
        <p className="text-xs text-on-surface-faint">
          {gt(
            "Savings are projected from recent billing and weekly off-hours; some providers still bill stopped resources. Change freezes skip transitions.",
          )}
        </p>
      )}

      {editing && (
        <ScheduleEditorModal
          client={client}
          target={{
            resourceId: editing.resourceId,
            accountId: editing.accountId,
            resourceName: editing.resourceName,
          }}
          existing={editing}
          onSaved={() => void refresh()}
          onClose={() => setEditing(null)}
        />
      )}
    </section>
  );
}

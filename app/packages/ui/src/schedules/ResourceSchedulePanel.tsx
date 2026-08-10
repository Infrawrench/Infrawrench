import { useCallback, useEffect, useRef, useState } from "react";
import { formatDaysOfWeek, formatMoney } from "@infrawrench/client-core";
import { ScheduleEditorModal, type ScheduleEditorTarget } from "./ScheduleEditorModal.js";
import type { SchedulesClient, SleepSchedule } from "./types.js";

export interface ResourceSchedulePanelProps {
  client: SchedulesClient;
  target: ScheduleEditorTarget;
}

/**
 * The resource detail page's Schedule tab: this resource's sleep/wake window
 * (if any) with pause/edit/delete, or a create flow with the projected-saving
 * quote. Hosts render it only for types whose plugin declares lifecycle
 * start/stop actions (`schedulable` on the detail payload).
 */
export function ResourceSchedulePanel({ client, target }: ResourceSchedulePanelProps) {
  const [schedule, setSchedule] = useState<SleepSchedule | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const requestSeq = useRef(0);

  const refresh = useCallback(async () => {
    const seq = ++requestSeq.current;
    setError(null);
    try {
      const next = await client.listSchedules();
      if (seq === requestSeq.current) {
        setSchedule(next.schedules.find((s) => s.resourceId === target.resourceId) ?? null);
        setLoaded(true);
      }
    } catch (e) {
      if (seq === requestSeq.current) {
        setError(e instanceof Error ? e.message : String(e));
        setLoaded(true);
      }
    }
  }, [client, target.resourceId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const togglePause = async () => {
    if (!schedule) return;
    setBusy(true);
    try {
      await client.updateSchedule(schedule.id, { paused: !schedule.paused });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!schedule) return;
    if (
      !window.confirm(
        `Delete the sleep schedule for ${target.resourceName}? The resource stays in whatever state it is in.`,
      )
    ) {
      return;
    }
    setBusy(true);
    try {
      await client.deleteSchedule(schedule.id);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-3 p-4">
      <div>
        <h2 className="text-sm font-semibold text-on-surface">Sleep schedule</h2>
        <p className="mt-1 text-xs text-on-surface-secondary">
          Stop this resource outside working hours and start it back up automatically. Executed
          server-side; transitions respect change freezes and show up in the change timeline.
        </p>
      </div>

      {error !== null && (
        <div role="alert" className="text-sm text-red-500">
          {error}{" "}
          <button type="button" onClick={() => void refresh()} className="underline">
            Retry
          </button>
        </div>
      )}
      {!loaded && error === null && (
        <p role="status" className="text-sm text-on-surface-faint">
          Loading…
        </p>
      )}

      {loaded && schedule === null && (
        <div>
          <button
            type="button"
            onClick={() => setEditorOpen(true)}
            className="rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-500"
          >
            Add sleep schedule…
          </button>
        </div>
      )}

      {schedule !== null && (
        <div className="rounded-xl border border-border bg-surface-sunken px-4 py-3 text-sm text-on-surface">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">
              {formatDaysOfWeek(schedule.daysOfWeek)} · off {schedule.stopTime} → on{" "}
              {schedule.startTime}
            </span>
            <span className="text-xs text-on-surface-faint">{schedule.timezone}</span>
            {schedule.paused && (
              <span className="rounded-full border border-border px-2 py-0.5 text-xs text-on-surface-tertiary">
                Paused
              </span>
            )}
          </div>
          <div className="mt-1 text-xs text-on-surface-secondary">
            {schedule.projectedMonthlySaving != null && schedule.currency && (
              <>
                Projected saving {formatMoney(schedule.projectedMonthlySaving, schedule.currency)}
                /mo ·{" "}
              </>
            )}
            {schedule.lastRunStatus === "failed" && (
              <span className="text-red-500">
                Last run failed: {schedule.lastRunError ?? "unknown error"} ·{" "}
              </span>
            )}
            {schedule.lastRunStatus === "skipped_freeze" && (
              <span className="text-amber-500">Last transition skipped (change freeze) · </span>
            )}
            {schedule.nextTransitionAt && !schedule.paused ? (
              <>
                Next {schedule.nextTransitionAction === "stop" ? "off" : "on"} at{" "}
                {new Date(schedule.nextTransitionAt).toLocaleString()}
              </>
            ) : (
              <>No transition scheduled</>
            )}
          </div>
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => void togglePause()}
              className="rounded-lg border border-border bg-surface-raised px-2.5 py-1 text-xs text-on-surface hover:border-border-strong disabled:opacity-50"
            >
              {schedule.paused ? "Resume" : "Pause"}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => setEditorOpen(true)}
              className="rounded-lg border border-border bg-surface-raised px-2.5 py-1 text-xs text-on-surface hover:border-border-strong disabled:opacity-50"
            >
              Edit
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void remove()}
              className="rounded-lg border border-border bg-surface-raised px-2.5 py-1 text-xs text-red-500 hover:border-red-500/50 disabled:opacity-50"
            >
              Delete
            </button>
          </div>
        </div>
      )}

      {editorOpen && (
        <ScheduleEditorModal
          client={client}
          target={target}
          existing={schedule}
          onSaved={() => void refresh()}
          onClose={() => setEditorOpen(false)}
        />
      )}
    </div>
  );
}

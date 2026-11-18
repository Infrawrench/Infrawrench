import { useState } from "react";
import { useGT } from "gt-react";
import {
  DRILL_INTERVAL_PRESETS,
  DRILL_SCHEDULE_LIMITS,
  QUERY_MONITOR_OPERATOR_LABELS,
  describeDrillCheck,
  drillRunHoldsCopy,
  formatRto,
  validateDrillSchedule,
  type DrillRestorePointKind,
  type QueryMonitorMode,
  type QueryMonitorOperator,
  type RestoreDrillRun,
  type RestoreDrillSchedule,
  type RestoreDrillScheduleInput,
  type RestoreDrillTargetRow,
} from "@infrawrench/client-core";
import { useDataString } from "../i18n/data-strings.js";

type Gt = ReturnType<typeof useGT>;

/** What the host supplies for automatic drills. Undefined hides every schedule control. */
export interface DrillAutomation {
  targets: RestoreDrillTargetRow[];
  schedules: RestoreDrillSchedule[];
  /** Omitted, schedules are shown read-only. */
  onCreateSchedule?: ((input: RestoreDrillScheduleInput) => Promise<void>) | undefined;
  onUpdateSchedule?:
    ((scheduleId: string, patch: Partial<RestoreDrillScheduleInput>) => Promise<void>) | undefined;
  onDeleteSchedule?: ((scheduleId: string) => Promise<void>) | undefined;
  onRunSchedule?: ((scheduleId: string) => Promise<void>) | undefined;
  loadRuns?: ((scheduleId: string) => Promise<RestoreDrillRun[]>) | undefined;
}

const OPERATORS: QueryMonitorOperator[] = ["gt", "gte", "lt", "lte", "eq", "neq"];

function intervalLabel(gt: Gt, days: number): string {
  switch (days) {
    case 1:
      return gt("Daily");
    case 7:
      return gt("Weekly");
    case 14:
      return gt("Every 2 weeks");
    case 30:
      return gt("Monthly");
    case 90:
      return gt("Quarterly");
    default:
      return gt("Every {days} days", { days });
  }
}

function restorePointLabel(gt: Gt, kind: DrillRestorePointKind): string {
  return kind === "latest-backup" ? gt("Latest backup") : gt("Point in time");
}

function runStateLabel(gt: Gt, run: RestoreDrillRun): string {
  switch (run.state) {
    case "starting":
      return gt("Starting");
    case "restoring":
      return gt("Restoring");
    case "cleaning":
      return gt("Deleting the copy");
    case "done":
      switch (run.outcome) {
        case "verified":
          return gt("Restored and checked");
        case "restored-unverified":
          return gt("Restored, not checked");
        case "failed":
          return gt("Restore failed");
        default:
          return gt("Finished");
      }
  }
}

function formatSeconds(seconds: number | null): string {
  return seconds === null ? formatRto(null) : formatRto(Math.max(1, Math.ceil(seconds / 60)));
}

interface Draft {
  intervalDays: number;
  restorePoint: DrillRestorePointKind;
  hoursAgo: string;
  verifySql: string;
  verifyMode: QueryMonitorMode;
  verifyOperator: QueryMonitorOperator;
  verifyThreshold: string;
  timeLimitMinutes: string;
}

function draftFor(target: RestoreDrillTargetRow, schedule: RestoreDrillSchedule | null): Draft {
  if (schedule) {
    return {
      intervalDays: schedule.intervalDays,
      restorePoint: schedule.restorePoint,
      hoursAgo: String(schedule.pointInTimeHoursAgo ?? 0),
      verifySql: schedule.verifySql ?? "",
      verifyMode: schedule.verifyMode,
      verifyOperator: schedule.verifyOperator,
      verifyThreshold: String(schedule.verifyThreshold),
      timeLimitMinutes: String(schedule.timeLimitMinutes),
    };
  }
  const typical = target.typicalReadyMinutes ?? 10;
  return {
    intervalDays: DRILL_SCHEDULE_LIMITS.defaultIntervalDays,
    restorePoint: target.restorePoints[0] ?? "latest-backup",
    hoursAgo: "0",
    verifySql: "",
    verifyMode: "rowCount",
    verifyOperator: "gt",
    verifyThreshold: "0",
    timeLimitMinutes: String(
      Math.min(
        DRILL_SCHEDULE_LIMITS.maxTimeLimitMinutes,
        Math.max(DRILL_SCHEDULE_LIMITS.defaultTimeLimitMinutes, typical * 4),
      ),
    ),
  };
}

function draftToInput(resourceId: string, draft: Draft): RestoreDrillScheduleInput {
  const sql = draft.verifySql.trim();
  return {
    resourceId,
    intervalDays: draft.intervalDays,
    restorePoint: draft.restorePoint,
    pointInTimeHoursAgo: draft.restorePoint === "point-in-time" ? Number(draft.hoursAgo) : null,
    verifySql: sql || null,
    verifyMode: draft.verifyMode,
    verifyOperator: draft.verifyOperator,
    verifyThreshold: Number(draft.verifyThreshold),
    timeLimitMinutes: Number(draft.timeLimitMinutes),
  };
}

const inputClass =
  "rounded-lg border border-border bg-surface px-2 py-1 text-sm text-on-surface disabled:opacity-50";
const labelClass = "flex flex-col gap-1 text-xs text-on-surface-tertiary";
const buttonClass =
  "rounded-lg border border-border px-2.5 py-1 text-xs text-on-surface-tertiary hover:bg-surface-overlay disabled:opacity-50";

/**
 * The automatic-drill controls for one resource on the Drills tab: the
 * schedule (or a button to make one), run now, pause, delete, and the run
 * history. Rendered only for resources whose provider can make isolated copies.
 */
export function DrillScheduleControls({
  target,
  schedule,
  automation,
}: {
  target: RestoreDrillTargetRow;
  schedule: RestoreDrillSchedule | null;
  automation: DrillAutomation;
}) {
  const gt = useGT();
  const gtData = useDataString();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [runs, setRuns] = useState<RestoreDrillRun[] | null>(null);
  const [showRuns, setShowRuns] = useState(false);
  const canEdit = Boolean(automation.onCreateSchedule);

  async function act(work: () => Promise<void>) {
    setBusy(true);
    setProblem(null);
    try {
      await work();
    } catch (e) {
      setProblem(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    if (!draft) return;
    const input = draftToInput(target.resourceId, draft);
    const invalid = validateDrillSchedule(input, target);
    if (invalid) {
      setProblem(invalid);
      return;
    }
    await act(async () => {
      if (schedule) {
        const { resourceId: _resourceId, ...patch } = input;
        await automation.onUpdateSchedule?.(schedule.id, patch);
      } else {
        await automation.onCreateSchedule?.(input);
      }
      setDraft(null);
    });
  }

  async function toggleRuns() {
    if (showRuns || !schedule) {
      setShowRuns(false);
      return;
    }
    setShowRuns(true);
    if (automation.loadRuns) {
      await act(async () => setRuns(await automation.loadRuns!(schedule.id)));
    }
  }

  const lastRun = schedule?.lastRun ?? null;
  const stranded = lastRun !== null && lastRun.cleanupState === "failed";
  const copyNoun = gtData(target.copyNoun);

  return (
    <div className="mt-3 flex flex-col gap-2 rounded-lg border border-border p-3">
      <div className="flex flex-wrap items-center gap-2 text-xs text-on-surface-tertiary">
        <svg
          aria-hidden="true"
          viewBox="0 0 24 24"
          className="h-3.5 w-3.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M6 3v12" />
          <circle cx="18" cy="6" r="3" />
          <circle cx="6" cy="18" r="3" />
          <path d="M18 9a9 9 0 0 1-9 9" />
        </svg>
        {schedule ? (
          <span className="text-on-surface">
            {schedule.enabled
              ? gt("Automatic: {interval}, from {point} · next {when}", {
                  interval: intervalLabel(gt, schedule.intervalDays),
                  point: restorePointLabel(gt, schedule.restorePoint),
                  when: new Date(schedule.nextRunAt).toLocaleDateString(),
                })
              : gt("Automatic drills paused")}
          </span>
        ) : (
          <span>{gt("No automatic drill")}</span>
        )}
        {schedule?.verifySql && (
          <span>
            {gt("Checks {condition}", {
              condition: describeDrillCheck(schedule),
            })}
          </span>
        )}
        <div className="ml-auto flex flex-wrap gap-1.5">
          {schedule && automation.onRunSchedule && (
            <button
              type="button"
              disabled={busy || (lastRun !== null && lastRun.state !== "done")}
              onClick={() => void act(() => automation.onRunSchedule!(schedule.id))}
              className={buttonClass}
            >
              {gt("Run now")}
            </button>
          )}
          {schedule && automation.loadRuns && (
            <button type="button" onClick={() => void toggleRuns()} className={buttonClass}>
              {showRuns ? gt("Hide history") : gt("History")}
            </button>
          )}
          {canEdit && (
            <button
              type="button"
              onClick={() => {
                setDraft(draft ? null : draftFor(target, schedule));
                setProblem(null);
              }}
              className={buttonClass}
            >
              {schedule ? gt("Edit") : gt("Schedule drill")}
            </button>
          )}
          {schedule && automation.onUpdateSchedule && (
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                void act(() =>
                  automation.onUpdateSchedule!(schedule.id, { enabled: !schedule.enabled }),
                )
              }
              className={buttonClass}
            >
              {schedule.enabled ? gt("Pause") : gt("Resume")}
            </button>
          )}
          {schedule && automation.onDeleteSchedule && (
            <button
              type="button"
              disabled={busy}
              onClick={() => void act(() => automation.onDeleteSchedule!(schedule.id))}
              className={buttonClass}
            >
              {gt("Delete schedule")}
            </button>
          )}
        </div>
      </div>

      {lastRun && (
        <p className="text-xs text-on-surface-tertiary">
          {gt("Last run {when}: {state}", {
            when: new Date(lastRun.startedAt).toLocaleString(),
            state: runStateLabel(gt, lastRun),
          })}
          {lastRun.restoreSeconds !== null &&
            ` · ${gt("restored in {time}", { time: formatSeconds(lastRun.restoreSeconds) })}`}
          {lastRun.detail ? ` · ${lastRun.detail}` : ""}
        </p>
      )}

      {stranded && lastRun && (
        <p role="alert" className="text-xs font-medium text-danger">
          {gt("The {noun} {name} could not be deleted and may still be running: {error}", {
            noun: copyNoun,
            name: lastRun.copyName,
            error: lastRun.cleanupError ?? "",
          })}
        </p>
      )}

      {target.costSummary && (draft || !schedule) && (
        <p className="text-xs text-on-surface-faint">
          {gtData(target.costSummary)}
          {target.costUrl && (
            <>
              {" "}
              <a
                href={target.costUrl}
                target="_blank"
                rel="noreferrer"
                className="underline underline-offset-2"
              >
                {gt("Pricing")}
              </a>
            </>
          )}
        </p>
      )}

      {problem && (
        <p role="alert" className="text-xs text-danger">
          {problem}
        </p>
      )}

      {draft && (
        <div className="flex flex-wrap items-end gap-2">
          <label className={labelClass}>
            {gt("Every")}
            <select
              value={draft.intervalDays}
              onChange={(e) => setDraft({ ...draft, intervalDays: Number(e.target.value) })}
              className={inputClass}
            >
              {[
                ...DRILL_INTERVAL_PRESETS,
                ...((DRILL_INTERVAL_PRESETS as readonly number[]).includes(draft.intervalDays)
                  ? []
                  : [draft.intervalDays]),
              ].map((days) => (
                <option key={days} value={days}>
                  {intervalLabel(gt, days)}
                </option>
              ))}
            </select>
          </label>
          <label className={labelClass}>
            {gt("Restore from")}
            <select
              value={draft.restorePoint}
              onChange={(e) =>
                setDraft({ ...draft, restorePoint: e.target.value as DrillRestorePointKind })
              }
              className={inputClass}
            >
              {target.restorePoints.map((kind) => (
                <option key={kind} value={kind}>
                  {restorePointLabel(gt, kind)}
                </option>
              ))}
            </select>
          </label>
          {draft.restorePoint === "point-in-time" && (
            <label className={labelClass}>
              {gt("Hours before the run")}
              <input
                type="number"
                min={0}
                max={target.maxLookbackHours ?? DRILL_SCHEDULE_LIMITS.maxPointInTimeHoursAgo}
                value={draft.hoursAgo}
                onChange={(e) => setDraft({ ...draft, hoursAgo: e.target.value })}
                className={`${inputClass} w-24`}
              />
            </label>
          )}
          <label className={labelClass}>
            {gt("Time limit (minutes)")}
            <input
              type="number"
              min={DRILL_SCHEDULE_LIMITS.minTimeLimitMinutes}
              max={DRILL_SCHEDULE_LIMITS.maxTimeLimitMinutes}
              value={draft.timeLimitMinutes}
              onChange={(e) => setDraft({ ...draft, timeLimitMinutes: e.target.value })}
              className={`${inputClass} w-24`}
            />
          </label>
          <label className={`${labelClass} w-full`}>
            {gt("Check query (read-only, optional)")}
            <textarea
              value={draft.verifySql}
              onChange={(e) => setDraft({ ...draft, verifySql: e.target.value })}
              rows={2}
              // i18n-ignore: SQL syntax example
              placeholder="SELECT count(*) FROM orders"
              className={`${inputClass} font-mono`}
            />
          </label>
          {draft.verifySql.trim() !== "" && (
            <>
              <label className={labelClass}>
                {gt("Expect")}
                <select
                  value={draft.verifyMode}
                  onChange={(e) =>
                    setDraft({ ...draft, verifyMode: e.target.value as QueryMonitorMode })
                  }
                  className={inputClass}
                >
                  <option value="rowCount">{gt("Row count")}</option>
                  <option value="scalar">{gt("First value")}</option>
                </select>
              </label>
              <label className={labelClass}>
                {gt("Condition")}
                <select
                  value={draft.verifyOperator}
                  onChange={(e) =>
                    setDraft({ ...draft, verifyOperator: e.target.value as QueryMonitorOperator })
                  }
                  className={inputClass}
                >
                  {OPERATORS.map((op) => (
                    <option key={op} value={op}>
                      {QUERY_MONITOR_OPERATOR_LABELS[op]}
                    </option>
                  ))}
                </select>
              </label>
              <label className={labelClass}>
                {gt("Value")}
                <input
                  type="number"
                  value={draft.verifyThreshold}
                  onChange={(e) => setDraft({ ...draft, verifyThreshold: e.target.value })}
                  className={`${inputClass} w-28`}
                />
              </label>
            </>
          )}
          <button
            type="button"
            disabled={busy}
            onClick={() => void save()}
            className="rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-on-accent disabled:opacity-50"
          >
            {schedule ? gt("Save schedule") : gt("Schedule")}
          </button>
        </div>
      )}

      {showRuns && (
        <ul className="flex flex-col gap-1 text-xs text-on-surface-tertiary">
          {runs === null ? (
            <li role="status">{gt("Loading…")}</li>
          ) : runs.length === 0 ? (
            <li>{gt("No runs yet")}</li>
          ) : (
            runs.map((run) => (
              <li key={run.id} className="flex flex-wrap gap-x-3 gap-y-0.5">
                <span className="tabular-nums">{new Date(run.startedAt).toLocaleString()}</span>
                <span
                  className={
                    run.outcome === "failed"
                      ? "text-danger"
                      : run.outcome === "verified"
                        ? "text-success"
                        : ""
                  }
                >
                  {runStateLabel(gt, run)}
                </span>
                <span>
                  {gt("Restore time {time}", { time: formatSeconds(run.restoreSeconds) })}
                </span>
                <span>{gt("Restore point age {age}", { age: formatRto(run.rpoMinutes) })}</span>
                {drillRunHoldsCopy(run) && run.cleanupState === "failed" && (
                  <span className="text-danger">
                    {gt("Copy not deleted after {count} attempts", {
                      count: run.cleanupAttempts,
                    })}
                  </span>
                )}
                {run.detail && <span className="basis-full">{run.detail}</span>}
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}

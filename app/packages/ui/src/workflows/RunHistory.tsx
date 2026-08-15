import { useMemo, useState } from "react";
import { useGT } from "gt-react";

import { useDataString } from "../i18n/data-strings.js";
import type { WorkflowRunLog, WorkflowRunResult, WorkflowRunRow } from "./types.js";

/**
 * How many rows the history shows before the "show all" toggle. The server
 * caps `GET /workflows/:id/runs` at 50 rows and offers no paging (the desktop
 * local client caps at 50 too), so the full list is always bounded — this is
 * purely so a busy workflow doesn't bury the editor under fifty rows.
 */
const COLLAPSED_ROW_COUNT = 10;

/**
 * The row limit both `listWorkflowRuns` (cloud) and the desktop's local query
 * apply. There is no paging parameter on either, so a full list means "the
 * latest 50", not "every run there has ever been".
 */
const SERVER_RUN_CAP = 50;

/** Statuses that mean the run hasn't finished yet. */
function isInFlight(status: string): boolean {
  return status === "running" || status === "pending";
}

/** Tailwind text colour for a run status. Shared by every run surface. */
export function runStatusClass(status: string): string {
  if (status === "success") return "text-success";
  if (status === "failure") return "text-danger";
  if (isInFlight(status)) return "text-warning";
  return "text-on-surface-secondary";
}

/**
 * Translated label for a run status. The statuses are a closed set
 * (`workflow_runs.status`), so each is a literal `gt()` call; anything else
 * that reaches the UI falls through to {@link useDataString}, which looks the
 * raw value up without tripping the gt CLI's literal-argument check.
 */
function useRunStatusLabel(): (status: string) => string {
  const gt = useGT();
  const gtData = useDataString();
  return (status: string) => {
    switch (status) {
      case "success":
        return gt("success");
      case "failure":
        return gt("failure");
      case "running":
        return gt("running");
      case "pending":
        return gt("pending");
      case "canceled":
        return gt("canceled");
      default:
        return gtData(status);
    }
  };
}

/** Translated label for what started a run (`workflow_runs.trigger_source`). */
function useTriggerSourceLabel(): (source: string) => string {
  const gt = useGT();
  const gtData = useDataString();
  return (source: string) => {
    switch (source) {
      case "manual":
        return gt("Manual");
      case "cron":
        return gt("Schedule");
      case "git":
        return gt("Git push");
      case "api":
        return gt("API");
      case "budget":
        return gt("Budget");
      default:
        return gtData(source);
    }
  };
}

/**
 * Milliseconds since the epoch for a run timestamp, or `null`. Cloud rows are
 * ISO strings (Drizzle `timestamp` through `JSON.stringify`); the desktop's
 * local SQLite rows are `YYYY-MM-DD HH:MM:SS` in UTC, so normalise both.
 */
export function parseRunTimestamp(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = new Date(value.includes("T") ? value : `${value.replace(" ", "T")}Z`).getTime();
  return Number.isNaN(ms) ? null : ms;
}

/** When the run started — `startedAt` if the runner recorded one, else the row's creation. */
function runStartedMs(run: WorkflowRunRow): number | null {
  return parseRunTimestamp(run.startedAt) ?? parseRunTimestamp(run.createdAt);
}

/**
 * How long the run took. Prefers the recorded `durationMs` and falls back to
 * the timestamps, which is what local rows written by an older desktop build
 * carry.
 */
function runDurationMs(run: WorkflowRunRow): number | null {
  if (typeof run.durationMs === "number") return run.durationMs;
  const started = parseRunTimestamp(run.startedAt);
  const finished = parseRunTimestamp(run.finishedAt);
  if (started == null || finished == null) return null;
  return Math.max(0, finished - started);
}

/** "820ms" / "3.4s" / "2m 05s". */
export function formatRunDuration(ms: number, gt: ReturnType<typeof useGT>): string {
  if (ms < 1000) return gt("{ms}ms", { ms: Math.round(ms) });
  if (ms < 60_000) return gt("{seconds}s", { seconds: (ms / 1000).toFixed(1) });
  const totalSeconds = Math.round(ms / 1000);
  return gt("{minutes}m {seconds}s", {
    minutes: Math.floor(totalSeconds / 60),
    seconds: String(totalSeconds % 60).padStart(2, "0"),
  });
}

/**
 * Best-effort "2h ago" for a run's start time. Deliberately the same message
 * strings as {@link WorkflowDashboardCard}'s `relativeTime` (down to the
 * placeholder names) so the two share catalog entries.
 */
function formatRelative(ms: number, gt: ReturnType<typeof useGT>): string {
  const secs = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (secs < 60) return gt("just now");
  const mins = Math.round(secs / 60);
  if (mins < 60) return gt("{mins}m ago", { mins });
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return gt("{hrs}h ago", { hrs });
  return gt("{days}d ago", { days: Math.round(hrs / 24) });
}

/** Log lines, coloured by level. The one renderer every run surface uses. */
export function RunLogLines({ logs }: { logs: WorkflowRunLog[] }) {
  return (
    <>
      {logs.map((l, i) => (
        <div
          key={i}
          className={l.level === "error" ? "text-danger" : l.level === "warn" ? "text-warning" : ""}
        >
          {l.message}
        </div>
      ))}
    </>
  );
}

/**
 * What a run recorded. `logs` is optional here (rather than required as on
 * {@link WorkflowRunResult}) because a row read back from storage can be
 * missing it when the column failed to parse.
 */
export interface RunOutcome {
  logs?: WorkflowRunLog[] | undefined;
  error?: { message: string; stack?: string } | null | undefined;
  output?: unknown;
}

/** Logs, then the error, then the declared output — a finished run's whole story. */
export function RunOutcomeBody({ run }: { run: RunOutcome }) {
  const gt = useGT();
  const logs = run.logs ?? [];
  const hasOutput = run.output !== undefined && run.output !== null;
  return (
    <>
      {logs.length === 0 && !run.error && !hasOutput && (
        <div className="opacity-50">{gt("This run logged nothing.")}</div>
      )}
      <RunLogLines logs={logs} />
      {run.error && (
        <div className="text-danger">{gt("Error: {message}", { message: run.error.message })}</div>
      )}
      {hasOutput && <pre className="mt-2 opacity-80">{JSON.stringify(run.output, null, 2)}</pre>}
    </>
  );
}

/** The run that just finished in the editor: status, duration, logs, output. */
export function RunResultPanel({ run }: { run: WorkflowRunResult }) {
  const gt = useGT();
  const statusLabel = useRunStatusLabel();
  return (
    <div className="h-48 border-t border-white/10 flex flex-col min-h-0">
      <div className="px-3 py-1 text-xs border-b border-white/10 flex items-center gap-2">
        <span className={`font-semibold ${runStatusClass(run.status)}`}>
          {statusLabel(run.status)}
        </span>
        {run.durationMs != null && (
          <span className="opacity-50">{formatRunDuration(run.durationMs, gt)}</span>
        )}
      </div>
      <div className="flex-1 overflow-auto p-2 font-mono text-[11px] leading-relaxed">
        <RunOutcomeBody run={run} />
      </div>
    </div>
  );
}

/** Logs streamed live while a run is in progress (same colour-by-level styling). */
export function LiveLogPanel({ logs }: { logs: WorkflowRunLog[] }) {
  const gt = useGT();
  return (
    <div className="h-48 border-t border-white/10 flex flex-col min-h-0">
      <div className="px-3 py-1 text-xs border-b border-white/10 flex items-center gap-2">
        <span className="font-semibold text-warning">{gt("running…")}</span>
      </div>
      <div className="flex-1 overflow-auto p-2 font-mono text-[11px] leading-relaxed">
        <RunLogLines logs={logs} />
      </div>
    </div>
  );
}

export interface WorkflowRunHistoryProps {
  /** Rows from `client.listRuns()`. Re-sorted newest first defensively. */
  runs: WorkflowRunRow[];
  /**
   * The run the editor started, once its id is known. Its row is marked as
   * already shown by the live/result panel above rather than offering a second
   * copy of the same logs.
   */
  currentRunId?: string | null | undefined;
  /** A run is executing in the editor right now (the live panel is mounted). */
  liveRunActive?: boolean;
}

/**
 * Persisted run history for the selected workflow: status, when it started,
 * how long it took and what started it, newest first, each row expanding to
 * the logs, error and output the run recorded.
 *
 * The rows come straight from `listRuns()` — the API returns each run's logs
 * with the row, so expanding costs no extra request. Reconciling with the live
 * panel is why `currentRunId` exists: after an editor run lands, its row is the
 * one `RunResultPanel` is already displaying, so it is flagged instead of
 * duplicated.
 */
export function WorkflowRunHistory({
  runs,
  currentRunId = null,
  liveRunActive = false,
}: WorkflowRunHistoryProps) {
  const gt = useGT();
  const statusLabel = useRunStatusLabel();
  const triggerLabel = useTriggerSourceLabel();
  const [collapsed, setCollapsed] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [expandedRunId, setExpandedRunId] = useState<string | null>(null);

  const ordered = useMemo(
    () => [...runs].sort((a, b) => (runStartedMs(b) ?? 0) - (runStartedMs(a) ?? 0)),
    [runs],
  );
  const visible = showAll ? ordered : ordered.slice(0, COLLAPSED_ROW_COUNT);
  const hidden = ordered.length - visible.length;

  return (
    <section className="border-t border-white/10 text-xs flex flex-col min-h-0">
      <div className="px-3 py-1.5 flex items-center gap-2">
        <button
          type="button"
          onClick={() => setCollapsed((c) => !c)}
          aria-expanded={!collapsed}
          className="flex items-center gap-1.5 opacity-70 hover:opacity-100"
        >
          <span aria-hidden="true">{collapsed ? "▸" : "▾"}</span>
          <span className="font-semibold">{gt("Run history")}</span>
          <span className="opacity-60">
            {/* The API returns at most 50 rows, so say "latest" once we're at
                the cap rather than implying the workflow has only ever run 50
                times. */}
            {ordered.length >= SERVER_RUN_CAP
              ? gt("(latest {count})", { count: ordered.length })
              : gt("({count})", { count: ordered.length })}
          </span>
        </button>
      </div>
      {!collapsed &&
        (ordered.length === 0 ? (
          <div className="px-3 pb-2 opacity-50">
            {liveRunActive
              ? gt("The first run is in progress — its logs are streaming above.")
              : gt("No runs yet. Press Run, or wait for this workflow’s trigger to fire.")}
          </div>
        ) : (
          <div className="max-h-48 overflow-auto">
            <table className="w-full">
              <caption className="sr-only">{gt("Run history")}</caption>
              <thead className="text-[10px] uppercase tracking-wide opacity-50">
                <tr className="border-b border-white/10">
                  <th scope="col" className="text-left font-normal px-3 py-1">
                    {gt("Status")}
                  </th>
                  <th scope="col" className="text-left font-normal px-3 py-1">
                    {gt("Started")}
                  </th>
                  <th scope="col" className="text-left font-normal px-3 py-1">
                    {gt("Duration")}
                  </th>
                  <th scope="col" className="text-left font-normal px-3 py-1">
                    {gt("Trigger")}
                  </th>
                  <th scope="col" className="px-3 py-1" />
                </tr>
              </thead>
              <tbody>
                {visible.flatMap((run) => {
                  const started = runStartedMs(run);
                  const duration = runDurationMs(run);
                  const isCurrent = currentRunId != null && run.id === currentRunId;
                  const expanded = expandedRunId === run.id;
                  return [
                    <tr
                      key={run.id}
                      className={`border-b border-white/5 ${isCurrent ? "bg-white/5" : ""}`}
                    >
                      <td className="px-3 py-1">
                        <span className={runStatusClass(run.status)}>
                          {statusLabel(run.status)}
                        </span>
                      </td>
                      <td
                        className="px-3 py-1 opacity-70"
                        title={started != null ? new Date(started).toLocaleString() : undefined}
                      >
                        {started != null ? formatRelative(started, gt) : "—"}
                      </td>
                      <td className="px-3 py-1 opacity-70">
                        {isInFlight(run.status)
                          ? gt("in progress")
                          : duration != null
                            ? formatRunDuration(duration, gt)
                            : "—"}
                      </td>
                      <td className="px-3 py-1 opacity-70">{triggerLabel(run.triggerSource)}</td>
                      <td className="px-3 py-1 text-right">
                        {isCurrent ? (
                          <span className="opacity-50">
                            {liveRunActive ? gt("streaming above") : gt("shown above")}
                          </span>
                        ) : (
                          <button
                            type="button"
                            onClick={() => setExpandedRunId(expanded ? null : run.id)}
                            aria-expanded={expanded}
                            className="px-2 py-0.5 rounded bg-white/10 hover:bg-white/20"
                          >
                            {expanded ? gt("Hide logs") : gt("Logs")}
                          </button>
                        )}
                      </td>
                    </tr>,
                    expanded ? (
                      <tr key={`${run.id}-logs`} className="border-b border-white/5">
                        <td colSpan={5} className="px-3 py-2 bg-surface-raised/40">
                          <div className="max-h-40 overflow-auto font-mono text-[11px] leading-relaxed">
                            <RunOutcomeBody run={run} />
                          </div>
                        </td>
                      </tr>
                    ) : null,
                  ];
                })}
              </tbody>
            </table>
            {hidden > 0 && (
              <div className="px-3 py-1.5">
                <button
                  type="button"
                  onClick={() => setShowAll(true)}
                  className="px-2 py-0.5 rounded bg-white/10 hover:bg-white/20"
                >
                  {gt("Show {count} more", { count: hidden })}
                </button>
              </div>
            )}
          </div>
        ))}
    </section>
  );
}

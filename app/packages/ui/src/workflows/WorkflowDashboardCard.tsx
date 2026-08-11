import { useState } from "react";
import { WorkflowIcon } from "./WorkflowIcon.js";

export interface WorkflowCardMetric {
  key: string;
  label: string;
  unit?: string | null | undefined;
  value: number | string | boolean | null;
}

export interface WorkflowDashboardCardData {
  workflowId: string;
  name: string;
  metrics: WorkflowCardMetric[];
  lastRunAt?: string | null | undefined;
  lastStatus?: "success" | "failure" | "running" | "pending" | null | undefined;
}

export interface WorkflowDashboardCardProps {
  data: WorkflowDashboardCardData;
  /** Open the workflow in the Workflows panel. */
  onOpen: () => void;
  /** Remove the pin from the dashboard. */
  onUnpin: () => void;
  /** Trigger a manual run; should resolve once metrics are refreshed. */
  onRun: () => Promise<void> | void;
}

function formatValue(v: WorkflowCardMetric["value"], unit?: string | null): string {
  if (v === null || v === undefined) return "—";
  const base = typeof v === "boolean" ? (v ? "yes" : "no") : String(v);
  return unit ? `${base} ${unit}` : base;
}

/** Best-effort "2h ago" from an ISO/SQL timestamp. */
function relativeTime(iso: string): string {
  const then = new Date(iso.includes("T") ? iso : iso.replace(" ", "T") + "Z").getTime();
  if (Number.isNaN(then)) return "";
  const secs = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (secs < 60) return "just now";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

/**
 * A dashboard card for a pinned workflow: its declared metrics with current
 * values, last-run status, and an inline Run button. Platform-agnostic — the
 * host supplies the data and the run/open/unpin handlers.
 */
export function WorkflowDashboardCard({
  data,
  onOpen,
  onUnpin,
  onRun,
}: WorkflowDashboardCardProps) {
  const [running, setRunning] = useState(false);

  const run = async () => {
    if (running) return;
    setRunning(true);
    try {
      await onRun();
    } finally {
      setRunning(false);
    }
  };

  const status = running ? "running" : data.lastStatus;
  const statusColor =
    status === "success"
      ? "text-success"
      : status === "failure"
        ? "text-danger"
        : status === "running"
          ? "text-info"
          : "text-on-surface-faint";
  const statusGlyph = status === "failure" ? "✕" : status === "running" ? "•" : "✓";

  return (
    <div className="group relative rounded-2xl border border-border bg-surface-raised hover:border-border-strong transition-colors flex flex-col overflow-hidden">
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onUnpin();
        }}
        title="Remove from dashboard"
        aria-label="Remove from dashboard"
        className="absolute top-2 right-2 size-5 rounded-full text-on-surface-faint hover:text-on-surface-secondary hover:bg-surface-sunken transition-all opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 text-xs flex items-center justify-center z-10"
      >
        ✕
      </button>

      <div className="flex items-center gap-2 px-5 pt-5 pb-3">
        <span className="text-on-surface-tertiary flex-shrink-0">
          <WorkflowIcon size={16} />
        </span>
        <button
          type="button"
          onClick={onOpen}
          className="text-base font-semibold text-on-surface leading-tight truncate text-left hover:text-white min-w-0 flex-1"
          title={data.name}
        >
          {data.name}
        </button>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            void run();
          }}
          disabled={running}
          className="flex-shrink-0 text-[11px] px-2 py-1 rounded bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white transition-colors mr-6"
        >
          {running ? "Running…" : "Run"}
        </button>
      </div>

      <button type="button" onClick={onOpen} className="px-5 pb-4 text-left flex flex-col gap-1.5">
        {data.metrics.length === 0 ? (
          <span className="text-xs text-on-surface-faint">No metrics declared.</span>
        ) : (
          data.metrics.map((m) => (
            <div key={m.key} className="flex items-baseline justify-between gap-3 text-xs">
              <span className="text-on-surface-muted truncate" title={m.label}>
                {m.label}
              </span>
              <span className="font-mono text-on-surface tabular-nums flex-shrink-0">
                {formatValue(m.value, m.unit)}
              </span>
            </div>
          ))
        )}
      </button>

      <div className="px-5 py-2 border-t border-border/60 flex items-center gap-1.5 text-[11px]">
        <span className={statusColor}>{statusGlyph}</span>
        <span className="text-on-surface-faint">
          {status === "running"
            ? "running…"
            : data.lastRunAt
              ? `ran ${relativeTime(data.lastRunAt)}`
              : "never run"}
        </span>
      </div>
    </div>
  );
}

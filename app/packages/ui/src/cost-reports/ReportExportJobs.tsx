import { useCallback, useEffect, useRef, useState } from "react";
import { T, useGT } from "gt-react";
import {
  COST_EXPORT_JOB_LIMITS,
  COST_EXPORT_JOB_POLL_MS,
  formatExportBytes,
  isCostExportJobActive,
  resolveCostDateRange,
  type CostExportJob,
  type CostExportJobFormat,
  type CostReport,
  type FocusVersion,
} from "@infrawrench/client-core";
import { Modal } from "../components/Modal.js";
import type { CostReportsClient } from "./types.js";

/** The format picker's options: the three file layouts, FOCUS in both versions. */
type ExportChoice = "csv" | "ndjson" | "focus-1.4" | "focus-1.3";

function requestFormat(choice: ExportChoice): {
  format: CostExportJobFormat;
  focusVersion?: FocusVersion;
} {
  if (choice === "focus-1.4") return { format: "focus", focusVersion: "1.4" };
  if (choice === "focus-1.3") return { format: "focus", focusVersion: "1.3" };
  return { format: choice };
}

/**
 * "Export…" on a report: a background export job with progress, and the file
 * when it is ready.
 *
 * The job is the answer to an export that is too big for one request: the
 * button queues it, the gateway writes it, and this component polls. Polling
 * lives here rather than in the dialog, so closing the dialog does not lose
 * the job: the toolbar keeps a small status line ("Export 45%…", then
 * "Export ready: Download") until it is downloaded or dismissed, which is how
 * the user hears about a file that took minutes. The dialog also lists the
 * user's recent exports, so a file finished while they were elsewhere is one
 * click away for the day it is kept.
 */
export function ReportExportJobs({
  client,
  report,
}: {
  client: CostReportsClient;
  report: CostReport;
}) {
  const gt = useGT();
  const [open, setOpen] = useState(false);
  const [tracked, setTracked] = useState<CostExportJob | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const getJob = client.getExportJob;

  // Poll the tracked job while it is queued or running.
  useEffect(() => {
    if (!tracked || !getJob || !isCostExportJobActive(tracked.status)) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      getJob(tracked.id)
        .then((next) => {
          if (cancelled) return;
          setTracked(next);
          if (next.status === "failed") {
            setNotice(gt("The export failed: {error}", { error: next.error ?? "" }));
          }
        })
        .catch(() => {
          // A missed poll is retried on the next timer; keep the last state.
          if (!cancelled) setTracked({ ...tracked });
        });
    }, COST_EXPORT_JOB_POLL_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [tracked, getJob, gt]);

  if (!client.createExportJob || !client.getExportJob) return null;

  const active = tracked && isCostExportJobActive(tracked.status);
  const ready = tracked?.status === "succeeded";

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title={gt("Export this report as CSV, NDJSON or FOCUS in the background")}
        className="hover:text-on-surface-secondary underline"
      >
        {gt("Export…")}
      </button>
      {active && (
        <span role="status" className="text-on-surface-tertiary tabular-nums">
          {gt("Export {percent}%", { percent: Math.round(tracked.progress * 100) })}
        </span>
      )}
      {ready && client.downloadExportJob && (
        <span role="status" className="flex items-center gap-1 text-success">
          {gt("Export ready:")}
          <button
            type="button"
            onClick={() => {
              void client.downloadExportJob!(tracked).catch((e: unknown) =>
                setNotice(e instanceof Error ? e.message : String(e)),
              );
              setTracked(null);
            }}
            className="underline hover:text-on-surface"
          >
            {gt("Download")}
          </button>
        </span>
      )}
      {notice && !open && (
        <span role="alert" className="text-danger">
          {notice}{" "}
          <button type="button" onClick={() => setNotice(null)} className="underline">
            {gt("Dismiss")}
          </button>
        </span>
      )}
      {open && (
        <ExportDialog
          client={client}
          report={report}
          tracked={tracked}
          onStarted={(job) => {
            setNotice(null);
            setTracked(job);
          }}
          onDownloaded={(job) => {
            if (tracked?.id === job.id) setTracked(null);
          }}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

function ExportDialog({
  client,
  report,
  tracked,
  onStarted,
  onDownloaded,
  onClose,
}: {
  client: CostReportsClient;
  report: CostReport;
  tracked: CostExportJob | null;
  onStarted: (job: CostExportJob) => void;
  onDownloaded: (job: CostExportJob) => void;
  onClose: () => void;
}) {
  const gt = useGT();
  const initial = useRef(resolveCostDateRange(report.config.dateRange));
  const [choice, setChoice] = useState<ExportChoice>("csv");
  const [from, setFrom] = useState(initial.current.from);
  const [to, setTo] = useState(initial.current.to);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recent, setRecent] = useState<CostExportJob[] | null>(null);
  const listJobs = client.listExportJobs;

  const loadRecent = useCallback(async () => {
    if (!listJobs) return;
    try {
      setRecent(await listJobs());
    } catch {
      setRecent([]);
    }
  }, [listJobs]);

  useEffect(() => {
    void loadRecent();
  }, [loadRecent]);

  // Keep the list's copy of the tracked job current as the toolbar polls it.
  const rows = (recent ?? []).map((job) => (tracked && job.id === tracked.id ? tracked : job));
  if (tracked && !rows.some((job) => job.id === tracked.id)) rows.unshift(tracked);

  const hasUnitCost = Boolean(report.config.unitCostMetricId || report.config.unitCostUsageUnit);

  async function start() {
    if (!client.createExportJob) return;
    setBusy(true);
    setError(null);
    try {
      const job = await client.createExportJob({
        reportId: report.id,
        ...requestFormat(choice),
        from,
        to,
      });
      onStarted(job);
      await loadRecent();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function download(job: CostExportJob) {
    if (!client.downloadExportJob) return;
    setError(null);
    try {
      await client.downloadExportJob(job);
      onDownloaded(job);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function cancel(job: CostExportJob) {
    if (!client.cancelExportJob) return;
    try {
      const next = await client.cancelExportJob(job.id);
      if (tracked?.id === job.id) onStarted(next);
      await loadRecent();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  const statusLabel = (job: CostExportJob): string => {
    switch (job.status) {
      case "queued":
        return gt("Queued");
      case "running":
        return gt("Writing… {percent}%", { percent: Math.round(job.progress * 100) });
      case "succeeded":
        return gt("Ready");
      case "failed":
        return gt("Failed");
      case "cancelled":
        return gt("Cancelled");
      case "expired":
        return gt("Expired");
    }
  };

  const formatLabel = (job: CostExportJob): string =>
    job.format === "focus"
      ? gt("FOCUS {version}", { version: job.focusVersion ?? "" })
      : job.format === "ndjson"
        ? gt("NDJSON")
        : gt("CSV");

  const inputClass =
    "px-2.5 py-1.5 text-sm bg-surface border border-border rounded-lg focus:outline-none focus:border-border-strong";

  return (
    <Modal onClose={onClose} ariaLabel={gt("Export report")}>
      <div className="bg-surface-raised border border-border-strong rounded-xl shadow-2xl w-[560px] max-w-[calc(100vw-2rem)] p-6 space-y-4">
        <div>
          <h2 className="text-base font-semibold text-on-surface">
            {gt("Export {name}", { name: report.name })}
          </h2>
          <T>
            <p className="mt-1 text-xs text-on-surface-muted">
              The file is written in the background, so a long range or a full FOCUS export does not
              have to fit in one download. You can close this window: the report toolbar says when
              the file is ready, and it is kept for a day.
            </p>
          </T>
        </div>

        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1">
            <span className="text-xs text-on-surface-tertiary">{gt("Format")}</span>
            <select
              value={choice}
              onChange={(e) => setChoice(e.target.value as ExportChoice)}
              className={inputClass}
            >
              <option value="csv">{gt("CSV, report columns")}</option>
              <option value="ndjson">{gt("NDJSON, report columns")}</option>
              <option value="focus-1.4">{gt("FOCUS 1.4 CSV, one row per resource per day")}</option>
              <option value="focus-1.3">{gt("FOCUS 1.3 CSV, one row per resource per day")}</option>
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-on-surface-tertiary">{gt("From")}</span>
            <input
              type="date"
              value={from}
              max={to || undefined}
              onChange={(e) => setFrom(e.target.value)}
              className={inputClass}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-on-surface-tertiary">{gt("To")}</span>
            <input
              type="date"
              value={to}
              min={from || undefined}
              onChange={(e) => setTo(e.target.value)}
              className={inputClass}
            />
          </label>
        </div>
        <p className="text-xs text-on-surface-faint">
          {choice === "csv" || choice === "ndjson"
            ? hasUnitCost
              ? gt(
                  "One row per day, {groupBy} and currency, plus this report's unit cost for each day across the whole report.",
                  { groupBy: report.config.groupBy ?? gt("total") },
                )
              : gt("One row per day, {groupBy} and currency, with the report's filters applied.", {
                  groupBy: report.config.groupBy ?? gt("total"),
                })
            : gt(
                "The FOCUS layout ignores the report's grouping: every resource, every day, with the report's filters applied.",
              )}{" "}
          {gt("Up to {days} days per export.", { days: COST_EXPORT_JOB_LIMITS.maxDays })}
        </p>

        {error && (
          <p role="alert" className="text-xs text-danger">
            {error}
          </p>
        )}

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 text-sm font-medium border border-border hover:bg-surface-overlay text-on-surface-secondary rounded-lg transition-colors"
          >
            {gt("Close")}
          </button>
          <button
            type="button"
            onClick={() => void start()}
            disabled={busy || !from || !to || from > to}
            className="px-3 py-1.5 text-sm font-medium bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded-lg transition-colors"
          >
            {busy ? gt("Starting…") : gt("Start export")}
          </button>
        </div>

        {rows.length > 0 && (
          <div className="border-t border-border pt-3">
            <h3 className="text-xs font-semibold text-on-surface-secondary mb-2">
              {gt("Your recent exports")}
            </h3>
            <ul className="space-y-2 max-h-64 overflow-auto">
              {rows.map((job) => (
                <li key={job.id} className="text-xs">
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-on-surface-secondary">
                      {job.source.reportName ?? gt("Ad-hoc query")} · {formatLabel(job)} ·{" "}
                      {gt("{from} to {to}", { from: job.from, to: job.to })}
                    </span>
                    <span className="shrink-0 flex items-center gap-2">
                      <span
                        className={
                          job.status === "failed"
                            ? "text-danger"
                            : job.status === "succeeded"
                              ? "text-success"
                              : "text-on-surface-faint"
                        }
                      >
                        {statusLabel(job)}
                      </span>
                      {job.status === "succeeded" && client.downloadExportJob && (
                        <button
                          type="button"
                          onClick={() => void download(job)}
                          className="underline text-on-surface-secondary hover:text-on-surface"
                        >
                          {gt("Download")}
                        </button>
                      )}
                      {isCostExportJobActive(job.status) && client.cancelExportJob && (
                        <button
                          type="button"
                          onClick={() => void cancel(job)}
                          className="underline text-on-surface-faint hover:text-danger"
                        >
                          {gt("Cancel")}
                        </button>
                      )}
                    </span>
                  </div>
                  {isCostExportJobActive(job.status) && (
                    <div
                      className="mt-1 h-1.5 rounded-full bg-surface-sunken overflow-hidden"
                      role="progressbar"
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={Math.round(job.progress * 100)}
                      aria-label={gt("Export progress")}
                    >
                      <div
                        className="h-full bg-blue-500 transition-all"
                        style={{ width: `${Math.max(2, Math.round(job.progress * 100))}%` }}
                      />
                    </div>
                  )}
                  <p className="mt-0.5 text-on-surface-faint">
                    {job.status === "failed" && job.error
                      ? job.error
                      : job.rowCount > 0
                        ? gt("{rows} rows · {size}", {
                            rows: job.rowCount.toLocaleString(),
                            size: formatExportBytes(job.byteCount),
                          })
                        : ""}
                    {job.status === "succeeded" && job.expiresAt
                      ? ` · ${gt("kept until {when}", {
                          when: new Date(job.expiresAt).toLocaleString(),
                        })}`
                      : ""}
                    {job.source.unitCostMetric
                      ? ` · ${gt("with {metric} unit costs", { metric: job.source.unitCostMetric })}`
                      : ""}
                  </p>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </Modal>
  );
}

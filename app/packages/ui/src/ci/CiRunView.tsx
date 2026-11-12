import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useGT } from "gt-react";
import {
  ciLiveJobKey,
  emptyCiLiveRun,
  reduceCiLogEvents,
  type CiCloudJob,
  type CiJobOutput,
  type CiJobSummary,
  type CiLiveJobStatus,
  type CiLiveRun,
  type CiLogEvent,
  type CiRun,
} from "@infrawrench/client-core";
import { CiDownloadList, type CiDownloadFn, type CiDownloadRow } from "./CiDownloads.js";
import { CiRunGraph } from "./CiRunGraph.js";
import { CiStatusIcon } from "./CiStatusIcon.js";
import { formatDuration } from "./format.js";
import { baseKey, groupStatus, MAX_ROWS, type GraphJob } from "./graph.js";
import type { CiClient } from "./types.js";

type Gt = ReturnType<typeof useGT>;

/** How often a live log's events are applied: often enough to read as live, rarely enough to stay cheap. */
const LIVE_FLUSH_MS = 100;

/**
 * Follows a running run's live log while `active`: the pipelines' graphs as
 * the runner announces them, each job's status and output as they happen.
 * Events are applied in batches, so a job printing thousands of lines a
 * second costs one render per batch. `onEnded` runs when the log ends by
 * itself (the run finished), so the caller can load the finished run.
 */
export function useCiLiveRun(
  client: CiClient,
  runId: string,
  active: boolean,
  onEnded: () => void,
): { run: CiLiveRun | null; error: string | null } {
  const [state, setState] = useState<{ run: CiLiveRun | null; error: string | null }>({
    run: null,
    error: null,
  });
  const ended = useRef(onEnded);
  ended.current = onEnded;
  useEffect(() => {
    if (!active) return;
    const abort = new AbortController();
    let current = emptyCiLiveRun();
    let pending: CiLogEvent[] = [];
    let timer: ReturnType<typeof setTimeout> | null = null;
    const flush = () => {
      timer = null;
      current = reduceCiLogEvents(current, pending);
      pending = [];
      setState({ run: current, error: null });
    };
    setState({ run: null, error: null });
    void (async () => {
      try {
        for await (const event of client.streamRunLogs(runId, abort.signal)) {
          pending.push(event);
          timer ??= setTimeout(flush, LIVE_FLUSH_MS);
        }
        if (!abort.signal.aborted) {
          if (timer !== null) clearTimeout(timer);
          flush();
          ended.current();
        }
      } catch (e) {
        if (abort.signal.aborted) return;
        if (timer !== null) clearTimeout(timer);
        setState({ run: current, error: e instanceof Error ? e.message : String(e) });
      }
    })();
    return () => {
      abort.abort();
      if (timer !== null) clearTimeout(timer);
    };
  }, [client, runId, active]);
  return state;
}

export function ciJobStatusLabel(status: CiLiveJobStatus, gt: Gt): string {
  switch (status) {
    case "passed":
      return gt("Passed");
    case "failed":
      return gt("Failed");
    case "skipped":
      return gt("Skipped");
    case "error":
      return gt("Error");
    case "running":
      return gt("Running");
    case "pending":
      return gt("Waiting");
    case "cancelled":
      return gt("Cancelled");
  }
}

/** One pipeline of a run, as the view draws it. */
interface PipelineView {
  name: string;
  jobs: GraphJob[];
}

/** A finished run's pipelines, from its jobs' reports. */
function finishedPipelines(jobs: readonly CiJobSummary[]): PipelineView[] {
  const pipelines: PipelineView[] = [];
  for (const job of jobs) {
    let pipeline = pipelines.find((p) => p.name === job.pipeline);
    if (!pipeline) {
      pipeline = { name: job.pipeline, jobs: [] };
      pipelines.push(pipeline);
    }
    pipeline.jobs.push({
      pipeline: job.pipeline,
      id: job.id,
      name: job.name,
      status: job.status,
      durationMs: job.durationMs,
      cached: job.reason?.startsWith("Cached:") ?? false,
      needs: job.needs ?? [],
    });
  }
  return pipelines;
}

/**
 * A running run's pipelines, from its live log: every job the runner
 * announced, waiting until its events arrive. A key whose matrix was not
 * known yet shows its entries as they start, or itself until then.
 */
function livePipelines(live: CiLiveRun): PipelineView[] {
  const all = Object.values(live.jobs);
  return live.pipelines.map((pipeline) => {
    const jobs: GraphJob[] = [];
    for (const planned of pipeline.jobs) {
      const ids =
        planned.ids ??
        all
          .filter((j) => j.pipeline === pipeline.name && baseKey(j.id) === planned.key)
          .map((j) => j.id);
      // A key skipped or failed as a whole reports under the key itself.
      const asKey = live.jobs[ciLiveJobKey(pipeline.name, planned.key)];
      for (const id of ids.length > 0 ? ids : [planned.key]) {
        const seen = live.jobs[ciLiveJobKey(pipeline.name, id)] ?? asKey;
        jobs.push({
          pipeline: pipeline.name,
          id,
          name: seen?.name ?? (ids.length === 1 ? planned.name : id),
          status: seen?.status ?? "pending",
          durationMs: seen?.durationMs ?? null,
          startedAt: seen?.startedAt ?? null,
          cached: seen?.cached ?? false,
          needs: planned.needs,
        });
      }
    }
    return { name: pipeline.name, jobs };
  });
}

interface Selection {
  pipeline: string;
  id: string;
}

function Sidebar({
  pipelines,
  selected,
  now,
  onSelect,
}: {
  pipelines: PipelineView[];
  selected: Selection | null;
  now: number;
  onSelect: (selection: Selection | null) => void;
}) {
  const gt = useGT();
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const row = (job: GraphJob, indent: boolean) => {
    const isSelected = selected?.pipeline === job.pipeline && selected.id === job.id;
    const time =
      job.status === "running" && job.startedAt
        ? formatDuration(now - job.startedAt)
        : formatDuration(job.durationMs);
    return (
      <li key={job.id}>
        <button
          type="button"
          onClick={() => onSelect({ pipeline: job.pipeline, id: job.id })}
          aria-current={isSelected ? "true" : undefined}
          className={`flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs ${
            indent ? "pl-6" : ""
          } ${isSelected ? "bg-accent-muted text-accent-on-muted" : "text-on-surface hover:bg-surface-sunken"}`}
        >
          <CiStatusIcon status={job.status} />
          <span className="min-w-0 flex-1 truncate">{job.name}</span>
          <span className="shrink-0 tabular-nums text-on-surface-faint">{time}</span>
        </button>
      </li>
    );
  };
  return (
    <nav
      aria-label={gt("Jobs")}
      className="w-full shrink-0 lg:sticky lg:top-4 lg:max-h-[calc(100vh-2rem)] lg:w-72 lg:self-start lg:overflow-y-auto"
    >
      <button
        type="button"
        onClick={() => onSelect(null)}
        aria-current={selected === null ? "true" : undefined}
        className={`w-full rounded px-2 py-1.5 text-left text-sm font-medium ${
          selected === null
            ? "bg-accent-muted text-accent-on-muted"
            : "text-on-surface hover:bg-surface-sunken"
        }`}
      >
        {gt("Summary")}
      </button>
      <p className="mt-3 px-2 text-[11px] font-medium uppercase text-on-surface-faint">
        {gt("All jobs")}
      </p>
      <div className="mt-1">
        {pipelines.map((pipeline) => {
          const groups = new Map<string, GraphJob[]>();
          for (const job of pipeline.jobs) {
            const key = baseKey(job.id);
            groups.set(key, [...(groups.get(key) ?? []), job]);
          }
          return (
            <div key={pipeline.name} className="mb-2">
              {pipelines.length > 1 ? (
                <p className="px-2 py-1 text-xs font-semibold text-on-surface-secondary">
                  {pipeline.name}
                </p>
              ) : null}
              <ul>
                {[...groups.entries()].map(([key, jobs]) => {
                  if (jobs.length === 1) return row(jobs[0]!, false);
                  const id = `${pipeline.name}\u0000${key}`;
                  const isOpen =
                    open[id] ??
                    (jobs.length <= MAX_ROWS ||
                      jobs.some((j) => selected?.pipeline === j.pipeline && selected.id === j.id));
                  return (
                    <li key={key}>
                      <button
                        type="button"
                        onClick={() => setOpen((o) => ({ ...o, [id]: !isOpen }))}
                        aria-expanded={isOpen}
                        className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs text-on-surface hover:bg-surface-sunken"
                      >
                        <CiStatusIcon status={groupStatus(jobs)} />
                        <span className="min-w-0 flex-1 truncate font-mono">{key}</span>
                        <span className="shrink-0 text-on-surface-faint">
                          {gt("{count} jobs", { count: String(jobs.length) })}
                        </span>
                        <svg
                          width="12"
                          height="12"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          aria-hidden="true"
                          className={`shrink-0 text-on-surface-faint transition-transform ${isOpen ? "rotate-180" : ""}`}
                        >
                          <path d="m6 9 6 6 6-6" />
                        </svg>
                      </button>
                      {isOpen ? <ul>{jobs.map((j) => row(j, true))}</ul> : null}
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}
      </div>
    </nav>
  );
}

/** Keeps a scrolled-to-the-end log at its end as lines arrive; one scrolled up stays put. */
function useStickToBottom(dependency: unknown) {
  const ref = useRef<HTMLPreElement>(null);
  const atBottom = useRef(true);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && atBottom.current) el.scrollTop = el.scrollHeight;
  }, [dependency]);
  const onScroll = () => {
    const el = ref.current;
    if (el) atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  };
  return { ref, onScroll };
}

function cloudStateLabel(job: CiCloudJob, gt: Gt): string {
  switch (job.state) {
    case "claiming":
      return gt("Claiming");
    case "starting":
      return gt("Starting machine");
    case "running":
      return gt("Running on its machine");
    case "tearing_down":
      return gt("Tearing down");
    case "done":
      return gt("Torn down");
  }
}

/** Where a cloud job ran: its connection, kind, machine and state. */
export function CiCloudBadge({
  cloud,
  summary,
}: {
  cloud: CiCloudJob | null;
  summary: CiJobSummary["cloud"];
}) {
  const gt = useGT();
  if (!cloud && !summary) return null;
  const parts = [
    cloud?.accountName ?? summary?.provider ?? cloud?.pluginId,
    cloud?.kind ?? summary?.kind,
    cloud?.machine ?? summary?.machine,
    cloud?.region ?? summary?.region,
  ].filter((p): p is string => Boolean(p));
  const executor = cloud?.label ?? summary?.executor ?? null;
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2 text-xs">
      <span className="inline-flex items-center gap-1 rounded bg-info/15 px-1.5 py-0.5 text-info">
        <svg
          aria-hidden="true"
          viewBox="0 0 24 24"
          width="12"
          height="12"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z" />
        </svg>
        {gt("Cloud job")}
      </span>
      <span className="font-mono text-on-surface-muted">{parts.join(" · ")}</span>
      {cloud ? <span className="text-on-surface-faint">{cloudStateLabel(cloud, gt)}</span> : null}
      {executor ? <span className="font-mono text-on-surface-faint">{executor}</span> : null}
      {cloud?.reason ? <span className="w-full text-on-surface-muted">{cloud.reason}</span> : null}
    </div>
  );
}

/** What a job was lent, by name. */
function LentNames({ access }: { access: CiJobSummary["access"] }) {
  const gt = useGT();
  if (!access) return null;
  const rows: Array<[string, string[] | undefined]> = [
    [gt("Connections"), access.connections],
    [gt("SSH keys"), access.sshKeys],
    [gt("Resources"), access.resources],
    [gt("Environment from"), access.envFrom],
  ];
  const shown = rows.filter(([, names]) => names && names.length > 0);
  if (shown.length === 0) return null;
  return (
    <dl className="flex flex-wrap gap-x-4 gap-y-1 border-b border-border px-4 py-2 text-xs">
      <dt className="sr-only">{gt("Lent to this job")}</dt>
      {shown.map(([label, names]) => (
        <div key={label} className="flex gap-1.5">
          <dt className="text-on-surface-faint">{label}</dt>
          <dd className="font-mono text-on-surface-muted">{names!.join(", ")}</dd>
        </div>
      ))}
    </dl>
  );
}

function JobLog({
  job,
  output,
  cloud,
  live,
  truncated,
  now,
  onDownload,
}: {
  job: GraphJob;
  output: CiJobOutput | null;
  cloud: CiCloudJob | null;
  live: CiLiveRun | null;
  truncated: boolean;
  now: number;
  onDownload: CiDownloadFn | undefined;
}) {
  const gt = useGT();
  const liveJob = live?.jobs[ciLiveJobKey(job.pipeline, job.id)] ?? null;
  const lines = liveJob?.lines ?? null;
  const { ref, onScroll } = useStickToBottom(lines?.length ?? output);
  const time =
    job.status === "running" && job.startedAt
      ? formatDuration(now - job.startedAt)
      : formatDuration(job.durationMs);
  const hasOutput = lines ? lines.length > 0 : Boolean(output?.stdout || output?.stderr);
  return (
    <section className="flex min-w-0 flex-1 flex-col rounded-md border border-border bg-surface">
      <header className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3">
        <CiStatusIcon status={job.status} size={16} />
        <h3 className="min-w-0 truncate text-sm font-semibold text-on-surface">{job.name}</h3>
        <span className="text-xs text-on-surface-faint">{ciJobStatusLabel(job.status, gt)}</span>
        <span className="ml-auto text-xs tabular-nums text-on-surface-faint">{time}</span>
      </header>
      <CiCloudBadge cloud={cloud} summary={output?.cloud} />
      <LentNames access={output?.access} />
      {output?.reason ? (
        <p className="border-b border-border px-4 py-2 text-xs text-on-surface-muted">
          {output.reason}
        </p>
      ) : null}
      {onDownload && output?.downloads?.length ? (
        <div className="border-b border-border p-3">
          <CiDownloadList
            rows={output.downloads.map((file) => ({
              jobId: output.id,
              jobName: output.name,
              file,
            }))}
            showJob={false}
            onDownload={onDownload}
          />
        </div>
      ) : null}
      {truncated && lines ? (
        <p className="border-b border-border px-4 py-2 text-xs text-warning">
          {gt("The run printed more than the live log keeps; later output shows when it finishes.")}
        </p>
      ) : null}
      {hasOutput ? (
        <pre
          ref={ref}
          onScroll={onScroll}
          className="max-h-[70vh] min-h-48 overflow-auto bg-surface-sunken px-4 py-3 font-mono text-[11px] leading-5 text-on-surface"
        >
          {lines
            ? lines.map((l, i) => (
                <span key={i} className={l.stream === "stderr" ? "text-danger" : undefined}>
                  {l.line}
                  {"\n"}
                </span>
              ))
            : [
                output?.stdout ?? "",
                output?.stderr ? (
                  <span key="err" className="text-danger">
                    {output.stderr}
                  </span>
                ) : null,
              ]}
        </pre>
      ) : (
        <p className="px-4 py-6 text-xs text-on-surface-faint">
          {job.status === "pending"
            ? gt("This job has not started yet.")
            : job.status === "running"
              ? gt("No output yet.")
              : gt("This job printed nothing.")}
        </p>
      )}
    </section>
  );
}

/**
 * A run's jobs: a sidebar listing them (a matrix's or a `packages:` job's
 * entries grouped), and either the summary, one graph per pipeline, or the
 * selected job's log. While the run is going, `live` (its live log) drives
 * everything and the selected job's output follows as it is printed; once
 * it has finished, the jobs' reports do.
 */
export function CiRunView({
  run,
  jobs,
  live,
  liveError,
  onDownload,
  cloudJobs,
}: {
  run: CiRun;
  /** Where its cloud jobs ran, from the run's detail. */
  cloudJobs?: readonly CiCloudJob[] | undefined;
  /** A finished run's jobs, with their output when it could be read. */
  jobs: readonly (CiJobOutput | CiJobSummary)[] | null;
  live: CiLiveRun | null;
  liveError: string | null;
  /** Starts a download of a file a job kept; without it none are listed. */
  onDownload?: CiDownloadFn | undefined;
}) {
  const gt = useGT();
  const [selected, setSelected] = useState<Selection | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const running = live !== null;
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);

  const pipelines = useMemo(
    () => (live ? livePipelines(live) : finishedPipelines(jobs ?? [])),
    [live, jobs],
  );
  const selectedJob = selected
    ? (pipelines
        .find((p) => p.name === selected.pipeline)
        ?.jobs.find((j) => j.id === selected.id) ?? null)
    : null;
  const output =
    selectedJob && jobs
      ? ((jobs.find((j) => j.pipeline === selectedJob.pipeline && j.id === selectedJob.id) as
          CiJobOutput | undefined) ?? null)
      : null;
  // Every job's downloads, for the run's summary.
  const downloads = useMemo<CiDownloadRow[]>(
    () =>
      (jobs ?? []).flatMap((j) =>
        "downloads" in j && j.downloads
          ? j.downloads.map((file) => ({ jobId: j.id, jobName: j.name, file }))
          : [],
      ),
    [jobs],
  );
  const subtitle =
    run.event === "pull-request"
      ? gt("On: pull request #{number}", { number: String(run.pullNumber ?? "") })
      : run.event === "schedule"
        ? gt("On: schedule, on {branch}", { branch: run.headRef })
        : gt("On: push to {branch}", { branch: run.headRef });

  return (
    <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
      <Sidebar
        pipelines={pipelines}
        selected={selectedJob ? selected : null}
        now={now}
        onSelect={setSelected}
      />
      <div className="flex min-w-0 flex-1 flex-col gap-4">
        {liveError ? (
          <p role="alert" className="text-xs text-danger">
            {gt("The live log stopped: {error}", { error: liveError })}
          </p>
        ) : null}
        {selectedJob ? (
          <JobLog
            job={selectedJob}
            output={output}
            cloud={
              cloudJobs?.find(
                (c) => c.jobId === selectedJob.id && c.pipeline === selectedJob.pipeline,
              ) ??
              cloudJobs?.find((c) => c.jobId === selectedJob.id) ??
              null
            }
            live={live}
            truncated={live?.truncated ?? false}
            now={now}
            onDownload={onDownload}
          />
        ) : pipelines.length === 0 ? (
          <p role="status" className="text-xs text-on-surface-faint">
            {running ? gt("Waiting for the runner to start the pipelines…") : gt("No jobs ran.")}
          </p>
        ) : (
          <>
            {pipelines.map((pipeline) => (
              <CiRunGraph
                key={pipeline.name}
                title={pipeline.name}
                subtitle={subtitle}
                jobs={pipeline.jobs}
                selected={selected?.pipeline === pipeline.name ? selected.id : null}
                now={now}
                onSelect={(job) => setSelected({ pipeline: job.pipeline, id: job.id })}
              />
            ))}
            {onDownload ? (
              <CiDownloadList rows={downloads} showJob onDownload={onDownload} />
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}

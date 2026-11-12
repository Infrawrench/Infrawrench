/**
 * A CI run as its live log tells it (`GET /ci/runs/:runId/logs`, the
 * runner's log events relayed as Server-Sent Events): the pipelines' job
 * graphs, each job's status as it starts and finishes, and what it prints.
 * Both apps reduce the stream with {@link reduceCiLog} and render the same
 * view the finished run's report gives.
 */
import { CI_JOB_STATUSES, type CiJobStatus } from "./ci";
import type { SseFrame } from "./sse";

/** One job key of a pipeline, as the runner announces it before any job runs. */
export interface CiPlannedJob {
  key: string;
  name: string;
  needs: string[];
  /** The ids its entries report under; `null` while its matrix waits on another job. */
  ids: string[] | null;
}

export type CiLogEvent =
  | { event: "pipeline-started"; pipeline: string; jobs: CiPlannedJob[] }
  | { event: "job-started"; job: string; name: string }
  | { event: "output"; job: string; stream: "stdout" | "stderr"; line: string }
  | {
      event: "job-finished";
      job: string;
      status: string;
      duration_ms: number;
      cached?: boolean;
    }
  | { event: "truncated"; after_bytes?: number }
  | {
      event: "run-finished";
      passed?: boolean | null;
      error?: string | null;
      /** Something in it was cancelled (runners from the release with cancelling). */
      cancelled?: boolean;
    };

/**
 * A frame of the log stream as a {@link CiLogEvent}, or `null` for one this
 * build does not know (a newer runner may send more). The job events carry
 * their own `event` field; `truncated` and `run-finished` only their name.
 */
export function ciLogEvent(frame: SseFrame): CiLogEvent | null {
  const data = frame.data;
  if (typeof data !== "object" || data === null) return null;
  const record = data as Record<string, unknown>;
  const event = typeof record["event"] === "string" ? record["event"] : frame.event;
  switch (event) {
    case "pipeline-started":
      return Array.isArray(record["jobs"]) && typeof record["pipeline"] === "string"
        ? ({ ...record, event } as CiLogEvent)
        : null;
    case "job-started":
    case "output":
    case "job-finished":
      return typeof record["job"] === "string" ? ({ ...record, event } as CiLogEvent) : null;
    case "truncated":
    case "run-finished":
      return { ...record, event } as CiLogEvent;
    default:
      return null;
  }
}

export type CiLiveJobStatus = "pending" | "running" | CiJobStatus;

export interface CiLiveJob {
  pipeline: string;
  id: string;
  name: string;
  status: CiLiveJobStatus;
  durationMs: number | null;
  cached: boolean;
  /** When it started, by this client's clock, for a running job's elapsed time. */
  startedAt: number | null;
  lines: { stream: "stdout" | "stderr"; line: string }[];
}

export interface CiLivePipeline {
  name: string;
  jobs: CiPlannedJob[];
}

export interface CiLiveRun {
  pipelines: CiLivePipeline[];
  /** By `${pipeline}\u0000${id}`. */
  jobs: Record<string, CiLiveJob>;
  /** Output was dropped past the runner's log limit. */
  truncated: boolean;
  finished: boolean;
}

/** Lines kept per job; older ones are dropped first. */
export const CI_LIVE_MAX_LINES = 20_000;

export function emptyCiLiveRun(): CiLiveRun {
  return { pipelines: [], jobs: {}, truncated: false, finished: false };
}

export function ciLiveJobKey(pipeline: string, id: string): string {
  return `${pipeline}\u0000${id}`;
}

const FINISHED: readonly string[] = CI_JOB_STATUSES;

/**
 * `run` with `events` applied, in order. Pipelines run one after another, so
 * a job event belongs to the pipeline announced last. The run, its job table
 * and every job an event touched are new objects (copied once per call,
 * however many events), so a React render sees the change; apply a frame's
 * events in one call rather than one at a time.
 */
export function reduceCiLogEvents(
  run: CiLiveRun,
  events: readonly CiLogEvent[],
  now = Date.now(),
): CiLiveRun {
  if (events.length === 0) return run;
  const next: CiLiveRun = { ...run, pipelines: run.pipelines.slice(), jobs: { ...run.jobs } };
  const touched = new Set<string>();
  const job = (id: string, name?: string): CiLiveJob => {
    const pipeline = next.pipelines[next.pipelines.length - 1]?.name ?? "";
    const key = ciLiveJobKey(pipeline, id);
    const existing = next.jobs[key];
    if (existing && touched.has(key)) return existing;
    const copy: CiLiveJob = existing
      ? { ...existing, lines: existing.lines.slice() }
      : {
          pipeline,
          id,
          name: name ?? id,
          status: "pending",
          durationMs: null,
          cached: false,
          startedAt: null,
          lines: [],
        };
    next.jobs[key] = copy;
    touched.add(key);
    return copy;
  };
  for (const event of events) {
    switch (event.event) {
      case "pipeline-started":
        next.pipelines.push({ name: event.pipeline, jobs: event.jobs });
        break;
      case "job-started": {
        const j = job(event.job, event.name);
        j.name = event.name;
        j.status = "running";
        j.startedAt = now;
        break;
      }
      case "output": {
        const j = job(event.job);
        j.lines.push({ stream: event.stream, line: event.line });
        if (j.lines.length > CI_LIVE_MAX_LINES)
          j.lines.splice(0, j.lines.length - CI_LIVE_MAX_LINES);
        break;
      }
      case "job-finished": {
        const j = job(event.job);
        j.status = (FINISHED.includes(event.status) ? event.status : "error") as CiJobStatus;
        j.durationMs = event.duration_ms;
        j.cached = event.cached === true;
        break;
      }
      case "truncated":
        next.truncated = true;
        break;
      case "run-finished":
        next.finished = true;
        break;
    }
  }
  return next;
}

/** {@link reduceCiLogEvents} for one event. */
export function reduceCiLog(run: CiLiveRun, event: CiLogEvent, now = Date.now()): CiLiveRun {
  return reduceCiLogEvents(run, [event], now);
}

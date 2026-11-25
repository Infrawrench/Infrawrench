/**
 * A CI run as its log tells it. A finished run arrives whole (`ci.getRun`,
 * each job with what it printed); a run in progress arrives as the runner's
 * log events (`ci.runLog`, server-sent events). Both become the same
 * `LiveRun`, so one view draws either.
 */
import { API_ROUTES } from "../../api/routes.gen";
import { api, fillPath } from "../../api/client";
import type { CiJobOutput } from "@infrawrench/git-contract";
import type { RepoRef } from "../../lib/paths";

export interface SseFrame {
  readonly event: string;
  readonly data: unknown;
}

/**
 * The complete frames of an event stream's text, and what is left over (a
 * frame still arriving). Data that is not JSON is kept as its text.
 */
export function parseSse(text: string): { frames: SseFrame[]; rest: string } {
  const frames: SseFrame[] = [];
  const blocks = text.replace(/\r\n/g, "\n").split("\n\n");
  const rest = blocks.pop() ?? "";
  for (const block of blocks) {
    let event = "message";
    const data: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith(":")) continue;
      const colon = line.indexOf(":");
      const field = colon < 0 ? line : line.slice(0, colon);
      const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
      if (field === "event") event = value;
      else if (field === "data") data.push(value);
    }
    if (data.length === 0 && event === "message") continue;
    const raw = data.join("\n");
    let parsed: unknown = raw;
    try {
      parsed = raw === "" ? null : JSON.parse(raw);
    } catch {
      // Left as text.
    }
    frames.push({ event, data: parsed });
  }
  return { frames, rest };
}

export type LiveJobStatus =
  "pending" | "running" | "passed" | "failed" | "skipped" | "error" | "cancelled";

export interface LogLine {
  readonly stream: "stdout" | "stderr";
  readonly line: string;
}

export interface LiveJob {
  readonly pipeline: string;
  readonly id: string;
  readonly name: string;
  readonly status: LiveJobStatus;
  readonly reason: string | null;
  readonly durationMs: number | null;
  readonly needs: ReadonlyArray<string>;
  readonly lines: ReadonlyArray<LogLine>;
}

export interface LiveRun {
  /** Jobs in the order the pipelines announce them. */
  readonly jobs: ReadonlyArray<LiveJob>;
  /** Output was dropped past the runner's log limit. */
  readonly truncated: boolean;
  readonly finished: boolean;
}

const FINISHED = new Set(["passed", "failed", "skipped", "error", "cancelled"]);

const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;

/** Lines kept per job; older ones are dropped first. */
export const MAX_LINES = 20_000;

/**
 * The run so far from every frame received. Pipelines run one after another,
 * so a job event belongs to the pipeline announced last. A frame this build
 * does not know is skipped: a newer runner may send more.
 */
export function reduceFrames(frames: ReadonlyArray<SseFrame>): LiveRun {
  type Draft = { -readonly [K in keyof LiveJob]: LiveJob[K] } & { lines: LogLine[] };
  const jobs: Draft[] = [];
  const byKey = new Map<string, Draft>();
  let pipeline = "";
  let truncated = false;
  let finished = false;

  const jobOf = (id: string, name?: string): Draft => {
    const key = `${pipeline}\u0000${id}`;
    let job = byKey.get(key);
    if (!job) {
      job = {
        pipeline,
        id,
        name: name ?? id,
        status: "pending",
        reason: null,
        durationMs: null,
        needs: [],
        lines: [],
      };
      byKey.set(key, job);
      jobs.push(job);
    }
    return job;
  };

  for (const frame of frames) {
    const data = record(frame.data);
    const event = typeof data?.["event"] === "string" ? data["event"] : frame.event;
    switch (event) {
      case "pipeline-started": {
        if (typeof data?.["pipeline"] !== "string" || !Array.isArray(data["jobs"])) break;
        pipeline = data["pipeline"];
        for (const planned of data["jobs"]) {
          const item = record(planned);
          if (item === null || typeof item["key"] !== "string") continue;
          const ids = Array.isArray(item["ids"]) ? item["ids"] : [item["key"]];
          for (const id of ids) {
            if (typeof id !== "string") continue;
            const job = jobOf(id, typeof item["name"] === "string" ? item["name"] : id);
            job.needs = Array.isArray(item["needs"])
              ? item["needs"].filter((need): need is string => typeof need === "string")
              : [];
          }
        }
        break;
      }
      case "job-started": {
        if (typeof data?.["job"] !== "string") break;
        const job = jobOf(data["job"], typeof data["name"] === "string" ? data["name"] : undefined);
        if (typeof data["name"] === "string") job.name = data["name"];
        job.status = "running";
        break;
      }
      case "output": {
        if (typeof data?.["job"] !== "string" || typeof data["line"] !== "string") break;
        const job = jobOf(data["job"]);
        if (job.status === "pending") job.status = "running";
        job.lines.push({
          stream: data["stream"] === "stderr" ? "stderr" : "stdout",
          line: data["line"],
        });
        if (job.lines.length > MAX_LINES) job.lines.splice(0, job.lines.length - MAX_LINES);
        break;
      }
      case "job-finished": {
        if (typeof data?.["job"] !== "string") break;
        const job = jobOf(data["job"]);
        const status = typeof data["status"] === "string" ? data["status"] : "";
        job.status = FINISHED.has(status) ? (status as LiveJobStatus) : "error";
        job.durationMs = typeof data["duration_ms"] === "number" ? data["duration_ms"] : null;
        break;
      }
      case "truncated":
        truncated = true;
        break;
      case "run-finished":
        finished = true;
        break;
      default:
        break;
    }
  }
  if (finished) {
    // A job the runner never started when the run ended did not run.
    for (const job of jobs) {
      if (job.status === "pending" || job.status === "running") job.status = "cancelled";
    }
  }
  return { jobs, truncated, finished };
}

const linesOf = (text: string, stream: "stdout" | "stderr"): LogLine[] => {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines.map((line) => ({ stream, line }));
};

/** A finished run's report in the live shape: each job's output, then its errors. */
export function runFromReport(jobs: ReadonlyArray<CiJobOutput>): LiveRun {
  return {
    truncated: false,
    finished: true,
    jobs: jobs.map((job) => ({
      pipeline: job.pipeline,
      id: job.id,
      name: job.name,
      status: job.status,
      reason: job.reason,
      durationMs: job.durationMs,
      needs: job.needs ?? [],
      lines: [...linesOf(job.stdout, "stdout"), ...linesOf(job.stderr, "stderr")],
    })),
  };
}

/** The key a job is picked by in the page's `?job=`. */
export const jobKey = (job: Pick<LiveJob, "pipeline" | "id">): string =>
  `${job.pipeline}/${job.id}`;

/** The job to show first: the one asked for, else one that failed, else one running, else the first. */
export function pickJob(run: LiveRun, wanted: string | undefined): LiveJob | null {
  return (
    run.jobs.find((job) => jobKey(job) === wanted) ??
    run.jobs.find((job) => job.status === "failed" || job.status === "error") ??
    run.jobs.find((job) => job.status === "running") ??
    run.jobs[0] ??
    null
  );
}

/**
 * Follows a run's log until it ends or `signal` aborts, calling `onFrames`
 * with every frame received so far each time more arrive.
 *
 * Against the worker this reads the event stream as it is written. The dev
 * mock has no stream to hold open, so there the log is asked for again every
 * second and a half.
 */
export async function followRunLog(
  repo: RepoRef,
  runId: string,
  onFrames: (frames: SseFrame[]) => void,
  signal: AbortSignal,
  mock: boolean,
): Promise<void> {
  if (mock) {
    while (!signal.aborted) {
      const text = await api.ci.runLog({ params: { ...repo, runId } });
      if (signal.aborted) return;
      const { frames } = parseSse(typeof text === "string" ? text : "");
      onFrames(frames);
      if (frames.some((frame) => frame.event === "run-finished")) return;
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
    return;
  }
  const response = await fetch(fillPath(API_ROUTES.ci.runLog[1], { ...repo, runId }), {
    credentials: "same-origin",
    headers: { accept: "text/event-stream" },
    signal,
  });
  if (!response.ok || response.body === null) {
    throw new Error(`The log could not be read (${response.status})`);
  }
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  const all: SseFrame[] = [];
  let pending = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    const parsed = parseSse(pending + value);
    pending = parsed.rest;
    if (parsed.frames.length > 0) {
      all.push(...parsed.frames);
      onFrames([...all]);
    }
  }
}

/**
 * CI's wire types: what the API answers for an organization's CI (connected
 * GitHub accounts, runs, their jobs and usage). The server maps its rows to
 * these and both apps render them.
 */

import type { CiCloudJob, CiJobAccessNames } from "./ci-access";

export const CI_RUN_STATUSES = [
  "awaiting_approval",
  "queued",
  /** Waiting for its concurrency group: another run of the repository holds it. */
  "pending",
  "running",
  "passed",
  "failed",
  "error",
  "rejected",
  /** Stopped before it finished: by a newer run of its concurrency group, or by a person. */
  "cancelled",
  /**
   * Nothing to run: no pipeline of the commit runs on its push or pull
   * request (`on:` names other branches or events, or `paths:` left every
   * one out). The run list leaves these out.
   */
  "skipped",
] as const;

/** The statuses the run list leaves out unless they are asked for by name. */
export const CI_HIDDEN_RUN_STATUSES: readonly CiRunStatus[] = ["skipped"];

export type CiRunStatus = (typeof CI_RUN_STATUSES)[number];

export const CI_JOB_STATUSES = ["passed", "failed", "skipped", "error", "cancelled"] as const;

export type CiJobStatus = (typeof CI_JOB_STATUSES)[number];

export interface CiJobSummary {
  /** The pipeline file's name for the job (`Tests`). */
  pipeline: string;
  id: string;
  name: string;
  status: CiJobStatus;
  /** Why it failed, was skipped or errored. */
  reason: string | null;
  durationMs: number | null;
  /**
   * The job keys it waited for, as the pipeline's `needs:` expanded them
   * (`build[app/packages/ui]`, `prep`). Absent from runs before runner 0.3.1.
   */
  needs?: string[] | undefined;
  /** What the job was lent, by name (`connections:`, `ssh-keys:`, resources, `env-from:`). */
  access?: CiJobAccessNames | undefined;
  /** A cloud job's `cloud:` block, and what ran it. */
  cloud?: CiJobCloud | undefined;
}

/** Where a cloud job ran. */
export interface CiJobCloud {
  provider: string;
  kind: string;
  machine?: string;
  region?: string;
  /** The provider's name for what ran it, e.g. `aws ec2 i-0abc (eu-west-1)`. */
  executor?: string;
}

export interface CiJobOutput extends CiJobSummary {
  /** What the job printed, with the run's secrets masked by the runner. */
  stdout: string;
  stderr: string;
  /** The files it kept for download (`downloads:`); absent when none. */
  downloads?: CiDownload[] | undefined;
}

/** A file a job kept with `downloads:`, in the runners' store until it expires. */
export interface CiDownload {
  /** Relative to the clone when it is under it, else absolute. */
  path: string;
  size: number;
  /** Of the stored bytes (for text, after masking). */
  sha256: string;
  contentType: string;
  /** When it stops being served and is deleted. */
  expiresAt: string;
  /** Text, with the run's secrets masked; `false` for a binary, stored as it was. */
  masked: boolean;
}

/** A short-lived link the CI proxy serves one download from. */
export interface CiDownloadLink {
  url: string;
  expiresAt: string;
}

/**
 * What started a run: a push, a pull request, a pipeline's `on.schedule`
 * cron on the default branch, or a person starting an `on.manual` pipeline
 * on a branch they chose.
 */
export const CI_EVENTS = ["push", "pull-request", "schedule", "manual"] as const;

export type CiEvent = (typeof CI_EVENTS)[number];

export interface CiRun {
  id: string;
  repoFullName: string;
  event: CiEvent;
  /**
   * The branch pushed, the pull request's head branch, the default branch for
   * a schedule, or the branch a manual run was started on.
   */
  headRef: string;
  sha: string;
  pullNumber: number | null;
  /** The repository a pull request's head is in, when it is not this one. */
  headRepoFullName: string | null;
  /** A pull request from a fork: runs only once approved, and without secrets. */
  fromFork: boolean;
  /** Who pushed or opened the pull request (a GitHub login), or who started a manual run. */
  actorLogin: string | null;
  status: CiRunStatus;
  statusReason: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  jobs: CiJobSummary[] | null;
  vcpuSeconds: number | null;
  memoryGibSeconds: number | null;
  /** The commit or pull request on GitHub. */
  githubUrl: string;
  /** The run this one retries, when it is a retry. */
  retryOfRunId?: string | null;
  /** The newest retry of this run, when it has been retried. */
  retriedAsRunId?: string | null;
  /** Run without reading the task cache: every `task-cache:` job ran. */
  noTaskCache?: boolean;
  /** A scheduled or manual run's pipeline file: the one it runs. */
  pipelineFile?: string;
  /** A manual run's inputs, by name, as text (`true`, `4`, `staging`). */
  inputs?: Record<string, string>;
  /**
   * The concurrency groups its pipelines hold or wait for (`concurrency:`),
   * once the runners have read them; absent before then.
   */
  concurrencyGroups?: string[];
  /** Someone asked to cancel it and the runner is stopping it. */
  cancelRequested?: boolean;
}

export interface CiRunDetail {
  run: CiRun;
  /** Each job's output, once the run has finished; `null` before then. */
  jobs: CiJobOutput[] | null;
  /** The run's cloud jobs: where each ran and how far it got. Absent when it has none. */
  cloudJobs?: CiCloudJob[];
}

export interface CiAccount {
  installationId: number;
  /** The GitHub organization or user the App is installed on. */
  accountLogin: string;
  accountType: string | null;
  ciEnabled: boolean;
}

export interface CiStatus {
  /** CI is turned on for this organization (a platform admin decides). */
  enabled: boolean;
  /** The runner pool is configured on this server. */
  configured: boolean;
  /** The GitHub App is configured on this server. */
  githubConfigured: boolean;
  /** The organization's plan includes CI (paid, trial or complimentary). */
  planIncludesCi: boolean;
  accounts: CiAccount[];
}

export interface CiUsage {
  /** `YYYY-MM`, in UTC. */
  month: string;
  runs: number;
  vcpuSeconds: number;
  memoryGibSeconds: number;
  /** Storage (caches and downloads) over the month, sampled hourly. */
  storageGibHours: number;
  /** Storage (caches and downloads) now, when the runners answered. */
  storageBytes: number | null;
}

/** The runs a retry can start from: finished ones. */
export const CI_RETRYABLE_STATUSES: readonly CiRunStatus[] = [
  "passed",
  "failed",
  "error",
  "cancelled",
];

/** The runs that can be cancelled: not started, waiting for their group, or running. */
export const CI_CANCELLABLE_STATUSES: readonly CiRunStatus[] = ["queued", "pending", "running"];

/** One repository's stored caches (`cache:` and `task-cache:` entries). */
export interface CiRepoCache {
  /** The repository's name, as the runner keys it (lowercase). */
  repo: string;
  bytes: number;
  entries: number;
}

/** A connected GitHub account's stored caches, per repository. */
export interface CiAccountCaches {
  installationId: number;
  accountLogin: string;
  usedBytes: number;
  /** The account's storage quota, across its repositories. */
  quotaBytes: number | null;
  repos: CiRepoCache[];
  /** Why the runners could not say, when they could not. */
  error: string | null;
}

export interface CiCaches {
  accounts: CiAccountCaches[];
}

/** What clearing a repository's caches removed. */
/** One pipeline file of a repository with `on.schedule`, as of its last read. */
export interface CiScheduledPipeline {
  /** The pipeline file, under `.infrawrench/ci/`. */
  file: string;
  /** Its `name:`. */
  name: string;
  /** Its `on.schedule` cron expressions, in UTC. */
  cron: string[];
  /** The next minute one of them fires on, or `null` when none ever does. */
  nextRunAt: string | null;
}

/** A repository's scheduled pipelines on its default branch. */
export interface CiRepoSchedule {
  installationId: number;
  repoFullName: string;
  defaultBranch: string;
  /** The default branch's commit the pipelines were read from, which scheduled runs run. */
  sha: string | null;
  pipelines: CiScheduledPipeline[];
  /** When the default branch was last read; `null` until the first read. */
  refreshedAt: string | null;
  /** Why the last read failed, or which pipeline files did not parse. */
  error: string | null;
}

export interface CiSchedules {
  schedules: CiRepoSchedule[];
}

/** What an `on.manual` input takes. */
export const CI_INPUT_TYPES = ["string", "boolean", "choice", "number"] as const;

export type CiInputType = (typeof CI_INPUT_TYPES)[number];

/** One `on.manual` input of a pipeline, as the runners read it. */
export interface CiInput {
  name: string;
  type: CiInputType;
  description?: string;
  /** A run cannot start without a value (an empty one counts as none). */
  required: boolean;
  /** As text: `true`/`false` for a boolean, the number as written. */
  default?: string;
  /** A `choice` input's values. */
  options?: string[];
}

/** A pipeline someone may start by hand, as of its default branch's last read. */
export interface CiManualPipeline {
  /** The pipeline file, under `.infrawrench/ci/`. */
  file: string;
  name: string;
  inputs: CiInput[];
}

/** A repository's pipelines with `on.manual` on its default branch. */
export interface CiRepoManual {
  installationId: number;
  repoFullName: string;
  defaultBranch: string;
  /** The default branch's commit the pipelines were read from. */
  sha: string | null;
  pipelines: CiManualPipeline[];
  refreshedAt: string | null;
}

export interface CiManualPipelines {
  repositories: CiRepoManual[];
}

/** A value for an input as a client sends it. */
export type CiInputValue = string | boolean | number;

/** What starting a manual run takes. */
export interface CiStartRun {
  installationId: number;
  /** `owner/name`. */
  repoFullName: string;
  /** The pipeline file, as listed (`.infrawrench/ci/deploy.yml`). */
  pipelineFile: string;
  /** A branch of the repository itself; the default branch when omitted. */
  branch?: string;
  inputs?: Record<string, CiInputValue>;
}

/** The most inputs one pipeline declares, and the largest one value (the runner's limits). */
export const CI_MAX_INPUTS = 32;
export const CI_MAX_INPUT_BYTES = 16 * 1024;

/** Why an input's value is refused, for a form to say in its own words. */
export type CiInputProblem =
  | { kind: "required" }
  | { kind: "unknown" }
  | { kind: "boolean" }
  | { kind: "number" }
  | { kind: "choice"; options: string[] }
  | { kind: "too-long"; maxBytes: number }
  | { kind: "nul" };

/** A value as the run reads it: `true`/`false`, a number's decimal text, or the text. */
export function ciInputText(value: CiInputValue): string {
  return typeof value === "string" ? value : String(value);
}

function utf8Length(text: string): number {
  return new TextEncoder().encode(text).length;
}

/**
 * Checks values against a pipeline's inputs, as the runner will: answers
 * each problem by input name (an unknown name under its own), and the
 * values the run would read, as text, with every default filled in.
 * Mirrors `iwci_spec::inputs::resolve`; the runner has the last word, since
 * a branch's file can declare other inputs than the default branch's.
 */
export function checkCiInputs(
  inputs: readonly CiInput[],
  given: Readonly<Record<string, CiInputValue>>,
): { problems: Record<string, CiInputProblem>; values: Record<string, string> } {
  const problems: Record<string, CiInputProblem> = {};
  const values: Record<string, string> = {};
  for (const name of Object.keys(given)) {
    if (!inputs.some((i) => i.name === name)) problems[name] = { kind: "unknown" };
  }
  for (const input of inputs) {
    const raw = Object.prototype.hasOwnProperty.call(given, input.name)
      ? ciInputText(given[input.name]!)
      : undefined;
    const present =
      raw !== undefined && !(raw === "" && (input.type !== "string" || input.required));
    if (!present) {
      if (input.default !== undefined) values[input.name] = input.default;
      else {
        if (input.required) problems[input.name] = { kind: "required" };
        values[input.name] = input.type === "boolean" ? "false" : "";
      }
      continue;
    }
    const problem = ciInputProblem(input, raw);
    if (problem) problems[input.name] = problem;
    else values[input.name] = input.type === "number" ? raw.trim() : raw;
  }
  return { problems, values };
}

function ciInputProblem(input: CiInput, raw: string): CiInputProblem | null {
  if (utf8Length(raw) > CI_MAX_INPUT_BYTES) {
    return { kind: "too-long", maxBytes: CI_MAX_INPUT_BYTES };
  }
  if (raw.includes("\u0000")) return { kind: "nul" };
  switch (input.type) {
    case "string":
      return null;
    case "boolean":
      return raw === "true" || raw === "false" ? null : { kind: "boolean" };
    case "number": {
      const t = raw.trim();
      // A decimal number with an optional exponent, as Rust's f64 parse
      // takes it less `inf` and `NaN`.
      return /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(t) && Number.isFinite(Number(t))
        ? null
        : { kind: "number" };
    }
    case "choice":
      return (input.options ?? []).includes(raw)
        ? null
        : { kind: "choice", options: input.options ?? [] };
  }
}

export interface CiCacheCleared {
  installationId: number;
  repo: string;
  deletedEntries: number;
  deletedBytes: number;
}

/** A secret's name: its value is write-only and never comes back. */
export interface CiSecret {
  name: string;
  updatedAt: string;
}

export interface CiVariable {
  name: string;
  value: string;
  updatedAt: string;
}

/**
 * The secrets and variables of one scope: a connected GitHub account (every
 * repository), or one of its repositories, whose own override the account's
 * of the same name.
 */
export interface CiValues {
  installationId: number;
  /** The repository's name, or `null` for the whole account. */
  repo: string | null;
  secrets: CiSecret[];
  variables: CiVariable[];
}

/** Letters, digits and `_`, not starting with a digit (the runner's rule). */
export const CI_VALUE_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

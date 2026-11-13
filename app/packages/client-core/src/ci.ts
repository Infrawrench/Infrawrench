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
] as const;

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

export interface CiRun {
  id: string;
  repoFullName: string;
  event: "push" | "pull-request";
  /** The branch pushed, or the pull request's head branch. */
  headRef: string;
  sha: string;
  pullNumber: number | null;
  /** The repository a pull request's head is in, when it is not this one. */
  headRepoFullName: string | null;
  /** A pull request from a fork: runs only once approved, and without secrets. */
  fromFork: boolean;
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

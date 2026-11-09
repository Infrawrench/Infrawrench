/**
 * CI's wire types: what the API answers for an organization's CI (connected
 * GitHub accounts, runs, their jobs and usage). The server maps its rows to
 * these and both apps render them.
 */

export const CI_RUN_STATUSES = [
  "awaiting_approval",
  "queued",
  "running",
  "passed",
  "failed",
  "error",
  "rejected",
] as const;

export type CiRunStatus = (typeof CI_RUN_STATUSES)[number];

export const CI_JOB_STATUSES = ["passed", "failed", "skipped", "error"] as const;

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
}

export interface CiJobOutput extends CiJobSummary {
  /** What the job printed, with the run's secrets masked by the runner. */
  stdout: string;
  stderr: string;
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
}

export interface CiRunDetail {
  run: CiRun;
  /** Each job's output, once the run has finished; `null` before then. */
  jobs: CiJobOutput[] | null;
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
  /** Cache storage over the month, sampled hourly. */
  storageGibHours: number;
  /** Cache storage now, when the runners answered. */
  storageBytes: number | null;
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

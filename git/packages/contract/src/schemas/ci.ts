/**
 * Infrawrench CI for a repository here, in the shapes the app's CI tab shows
 * (`@infrawrench/api-contract` `domains/ci.ts`), so a run reads the same in
 * both places. The status lists repeat client-core's `ci.ts` because this
 * package imports only `effect`; a status added there is added here.
 */
import { Schema } from "effect";
import { IsoDateTime, Oid } from "./common";
import { UserRef } from "./people";

export const CI_RUN_STATUSES = [
  "awaiting_approval",
  "queued",
  "pending",
  "running",
  "passed",
  "failed",
  "error",
  "rejected",
  "cancelled",
  "skipped",
] as const;
export const CiRunStatus = Schema.Literals(CI_RUN_STATUSES).annotate({
  identifier: "CiRunStatus",
  description:
    "`awaiting_approval`: a fork's pull request waiting for someone with `ci:approve`. `pending`: waiting for its concurrency group. `skipped`: no pipeline runs on this push or pull request.",
});
export type CiRunStatus = typeof CiRunStatus.Type;

export const CI_JOB_STATUSES = ["passed", "failed", "skipped", "error", "cancelled"] as const;
export const CiJobStatus = Schema.Literals(CI_JOB_STATUSES).annotate({
  identifier: "CiJobStatus",
});
export type CiJobStatus = typeof CiJobStatus.Type;

export const CI_EVENTS = ["push", "pull-request", "schedule", "manual"] as const;
export const CiEvent = Schema.Literals(CI_EVENTS).annotate({ identifier: "CiEvent" });
export type CiEvent = typeof CiEvent.Type;

export const CiJob = Schema.Struct({
  pipeline: Schema.String.annotate({ description: "The pipeline's `name:`." }),
  id: Schema.String,
  name: Schema.String,
  status: CiJobStatus,
  reason: Schema.NullOr(Schema.String),
  durationMs: Schema.NullOr(Schema.Finite),
  needs: Schema.optionalKey(
    Schema.Array(Schema.String).annotate({ description: "The job keys it waited for." }),
  ),
}).annotate({ identifier: "CiJob" });
export type CiJob = typeof CiJob.Type;

export const CiJobOutput = Schema.Struct({
  ...CiJob.fields,
  stdout: Schema.String,
  stderr: Schema.String,
}).annotate({ identifier: "CiJobOutput" });
export type CiJobOutput = typeof CiJobOutput.Type;

export const CiRun = Schema.Struct({
  id: Schema.String,
  event: CiEvent,
  headRef: Schema.String,
  sha: Oid,
  pullNumber: Schema.NullOr(Schema.Int),
  fromFork: Schema.Boolean,
  actor: Schema.NullOr(UserRef).annotate({ description: "Who pushed or started it." }),
  status: CiRunStatus,
  statusReason: Schema.NullOr(Schema.String),
  createdAt: IsoDateTime,
  startedAt: Schema.NullOr(IsoDateTime),
  finishedAt: Schema.NullOr(IsoDateTime),
  jobs: Schema.NullOr(Schema.Array(CiJob)).annotate({
    description: "Null until the run has finished; follow the log while it runs.",
  }),
  pipelineFile: Schema.optionalKey(
    Schema.String.annotate({ description: "A scheduled or manual run's pipeline file." }),
  ),
  retryOfRunId: Schema.optionalKey(Schema.NullOr(Schema.String)),
  retriedAsRunId: Schema.optionalKey(Schema.NullOr(Schema.String)),
  cancelRequested: Schema.optionalKey(Schema.Boolean),
  commitTitle: Schema.NullOr(Schema.String).annotate({
    description: "The first line of the commit's message.",
  }),
  appUrl: Schema.NullOr(Schema.String).annotate({
    description:
      "The run in the Infrawrench app's CI tab, where it is retried, cancelled and approved. Null for a user's own repository, which has no organisation.",
  }),
}).annotate({ identifier: "CiRun" });
export type CiRun = typeof CiRun.Type;

export const CiRunDetail = Schema.Struct({
  run: CiRun,
  jobs: Schema.NullOr(Schema.Array(CiJobOutput)),
}).annotate({ identifier: "CiRunDetail" });
export type CiRunDetail = typeof CiRunDetail.Type;

/** Whether CI runs for the repository at all, for the CI tab's empty state. */
export const CiRepositoryStatus = Schema.Struct({
  enabled: Schema.Boolean.annotate({
    description: "The owner's plan and the server's runner configuration allow CI here.",
  }),
  pipelines: Schema.Array(Schema.Struct({ file: Schema.String, name: Schema.String })).annotate({
    description: "`.infrawrench/ci/*.yml` on the default branch.",
  }),
  reason: Schema.NullOr(Schema.String).annotate({
    description: "Why not, when `enabled` is false.",
  }),
}).annotate({ identifier: "CiRepositoryStatus" });
export type CiRepositoryStatus = typeof CiRepositoryStatus.Type;

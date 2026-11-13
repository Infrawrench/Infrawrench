/**
 * `/api/org/:orgId/ci`: CI on the organization's GitHub repositories.
 *
 * CI is rolled out per organization (`ORG_FEATURES`): until a platform admin
 * turns it on, the status endpoint says so and everything else is a 404.
 * Runs come from the GitHub App's push and pull request deliveries; a pull
 * request from a fork waits for someone with `ci:approve`, and runs without
 * secrets once approved.
 */
import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/http-api";
import { CI_EXECUTOR_KIND_IDS, CI_JOB_STATUSES, CI_RUN_STATUSES } from "@infrawrench/client-core";
import { RequiredPermission, SuccessDescription } from "../http/annotations";
import { withApiDefaults } from "../http/api-defaults";
import { BadRequest, Conflict, NotFound } from "../http/errors";
import { OrgAuth } from "../http/middleware-tags";
import { IsoDateTime, Ok, OrgId, OrgParams, Uuid } from "../http/schemas/common";
import { documentedAs } from "../http/schemas/documented";

export const CiRunStatusSchema = Schema.Literals(CI_RUN_STATUSES).annotate({
  identifier: "CiRunStatus",
});

export const CiJobSummarySchema = Schema.Struct({
  pipeline: Schema.String,
  id: Schema.String,
  name: Schema.String,
  status: Schema.Literals(CI_JOB_STATUSES),
  reason: Schema.NullOr(Schema.String),
  durationMs: Schema.NullOr(Schema.Number),
  needs: Schema.optionalKey(
    Schema.Array(Schema.String).annotate({
      description:
        "The job keys it waited for, as the pipeline's `needs:` expanded them. Absent from runs before runner 0.3.1.",
    }),
  ),
  access: Schema.optionalKey(
    Schema.Struct({
      connections: Schema.optionalKey(Schema.Array(Schema.String)),
      sshKeys: Schema.optionalKey(Schema.Array(Schema.String)),
      resources: Schema.optionalKey(Schema.Array(Schema.String)),
      envFrom: Schema.optionalKey(Schema.Array(Schema.String)),
    }).annotate({
      identifier: "CiJobAccessNames",
      description:
        "What the job was lent, by name only: connections, SSH keys, resources and `env-from:` grants.",
    }),
  ),
  cloud: Schema.optionalKey(
    Schema.Struct({
      provider: Schema.String,
      kind: Schema.String,
      machine: Schema.optionalKey(Schema.String),
      region: Schema.optionalKey(Schema.String),
      executor: Schema.optionalKey(
        Schema.String.annotate({ description: "What ran it, e.g. `aws ec2 i-0abc (eu-west-1)`." }),
      ),
    }).annotate({
      identifier: "CiJobCloud",
      description: "A cloud job's `cloud:` block and what ran it.",
    }),
  ),
}).annotate({ identifier: "CiJobSummary" });

/** The run's live log: the runner's events as `event:` / `data:` frames. */
const RunLogStream = Schema.String.pipe(HttpApiSchema.asText({ contentType: "text/event-stream" }));

export const CiDownloadSchema = Schema.Struct({
  path: Schema.String.annotate({
    description: "Where the job left it: relative to the clone when it is under it, else absolute.",
  }),
  size: Schema.Number,
  sha256: Schema.String.annotate({
    description: "Of the stored bytes; for a text file, after masking.",
  }),
  contentType: Schema.String,
  expiresAt: IsoDateTime.annotate({ description: "When it stops being served and is deleted." }),
  masked: Schema.Boolean.annotate({
    description:
      "A text file, with the run's secrets masked. `false` for a binary file, which is stored as the job left it.",
  }),
}).annotate({ identifier: "CiDownload" });

export const CiDownloadLinkSchema = Schema.Struct({
  url: Schema.String.annotate({
    description: "Served by the CI proxy as an attachment; needs no other credential.",
  }),
  expiresAt: IsoDateTime,
}).annotate({ identifier: "CiDownloadLink" });

export const CiJobOutputSchema = Schema.Struct({
  ...CiJobSummarySchema.fields,
  stdout: Schema.String,
  stderr: Schema.String,
  downloads: Schema.optionalKey(
    Schema.Array(CiDownloadSchema).annotate({
      description: "The files the job kept with `downloads:`. Absent when it kept none.",
    }),
  ),
}).annotate({ identifier: "CiJobOutput" });

export const CiRunSchema = Schema.Struct({
  id: Schema.String,
  repoFullName: Schema.String,
  event: Schema.Literals(["push", "pull-request", "schedule"]).annotate({
    description:
      "What started the run. `schedule`: a pipeline's `on.schedule` cron, on the default branch's head.",
  }),
  headRef: Schema.String,
  sha: Schema.String,
  pullNumber: Schema.NullOr(Schema.Int),
  headRepoFullName: Schema.NullOr(Schema.String),
  fromFork: Schema.Boolean,
  actorLogin: Schema.NullOr(Schema.String),
  status: CiRunStatusSchema,
  statusReason: Schema.NullOr(Schema.String),
  createdAt: IsoDateTime,
  startedAt: Schema.NullOr(IsoDateTime),
  finishedAt: Schema.NullOr(IsoDateTime),
  jobs: Schema.NullOr(Schema.Array(CiJobSummarySchema)),
  vcpuSeconds: Schema.NullOr(Schema.Number),
  memoryGibSeconds: Schema.NullOr(Schema.Number),
  githubUrl: Schema.String,
  retryOfRunId: Schema.optionalKey(
    Schema.NullOr(Schema.String).annotate({
      description: "The run this one retries: the same repository, commit, branch and event.",
    }),
  ),
  retriedAsRunId: Schema.optionalKey(
    Schema.NullOr(Schema.String).annotate({ description: "The newest retry of this run." }),
  ),
  noTaskCache: Schema.optionalKey(
    Schema.Boolean.annotate({
      description:
        "The run did not read the task cache: every `task-cache:` job ran, and saved its result again.",
    }),
  ),
  pipelineFile: Schema.optionalKey(
    Schema.String.annotate({
      description: "A scheduled run's pipeline file, whose `on.schedule` cron started it.",
    }),
  ),
  concurrencyGroups: Schema.optionalKey(
    Schema.Array(Schema.String).annotate({
      description:
        "The `concurrency:` groups its pipelines hold or wait for, once the runners have read them.",
    }),
  ),
  cancelRequested: Schema.optionalKey(
    Schema.Boolean.annotate({
      description: "Someone asked to cancel the run, and its runner is stopping it.",
    }),
  ),
}).annotate({ identifier: "CiRun" });

export const CiCloudJobSchema = Schema.Struct({
  jobId: Schema.String,
  jobName: Schema.String,
  pipeline: Schema.String,
  accountId: Schema.NullOr(Schema.String),
  accountName: Schema.NullOr(Schema.String),
  pluginId: Schema.String,
  kind: Schema.String,
  machine: Schema.NullOr(Schema.String),
  region: Schema.NullOr(Schema.String),
  state: Schema.Literals(["claiming", "starting", "running", "tearing_down", "done"]).annotate({
    description:
      "`claiming`: Infrawrench is claiming it from the runner (retried when the runner pool is busy). `starting`: the machine is coming up. `running`: it called back. `tearing_down`: the job ended and its compute is being removed. `done`: removed.",
  }),
  outcome: Schema.NullOr(Schema.String),
  reason: Schema.NullOr(Schema.String),
  label: Schema.NullOr(
    Schema.String.annotate({ description: "The provider's name for what runs it." }),
  ),
  claimedAt: IsoDateTime,
  finishedAt: Schema.NullOr(IsoDateTime),
}).annotate({ identifier: "CiCloudJob" });

export const CiRunDetailSchema = Schema.Struct({
  run: CiRunSchema,
  jobs: Schema.NullOr(Schema.Array(CiJobOutputSchema)),
  cloudJobs: Schema.optionalKey(
    Schema.Array(CiCloudJobSchema).annotate({
      description: "Where each of its cloud jobs ran. Absent when it has none.",
    }),
  ),
}).annotate({ identifier: "CiRunDetail" });

const KindSchema = Schema.Literals(CI_EXECUTOR_KIND_IDS);
const ReposSchema = Schema.NullOr(Schema.Array(Schema.String)).annotate({
  description: "Repositories (`owner/name`). Null: every repository the organization runs CI for.",
});
const BranchPatternSchema = Schema.NullOr(Schema.String).annotate({
  description:
    "Branches it holds for: globs separated by commas, where `*` stops at `/` and `**` does not (`main, release/*`). Null: every branch.",
});

export const CiPreflightRecordSchema = Schema.Struct({
  ok: Schema.Boolean,
  missing: Schema.Array(Schema.Struct({ permission: Schema.String, label: Schema.String })),
  problems: Schema.Array(Schema.String),
  region: Schema.optionalKey(Schema.String),
  checkedAt: IsoDateTime,
}).annotate({ identifier: "CiPreflightRecord" });

export const CiConnectionAccessSettingsSchema = Schema.Struct({
  jobsEnabled: Schema.Boolean.annotate({
    description: "Cloud jobs may run on this connection. Needs a passing check for every kind.",
  }),
  jobKinds: Schema.Array(KindSchema),
  maxConcurrentJobs: Schema.Int,
  maxJobMinutes: Schema.Int,
  jobRepos: ReposSchema,
  jobBranchPattern: BranchPatternSchema,
  lendEnabled: Schema.Boolean.annotate({
    description: "Jobs may be lent this connection's credentials (`connections:`).",
  }),
  lendRepos: ReposSchema,
  lendBranchPattern: BranchPatternSchema,
}).annotate({ identifier: "CiConnectionAccessSettings" });

export const CiConnectionAccessSchema = Schema.Struct({
  accountId: Schema.String,
  accountName: Schema.String,
  pluginId: Schema.String,
  pluginName: Schema.String,
  executor: Schema.NullOr(
    Schema.Struct({
      kinds: Schema.Array(
        Schema.Struct({
          kind: KindSchema,
          label: Schema.String,
          defaults: Schema.Struct({
            machine: Schema.optionalKey(Schema.String),
            image: Schema.optionalKey(Schema.String),
            region: Schema.optionalKey(Schema.String),
          }),
          typicalStartSeconds: Schema.optionalKey(Schema.Number),
          minimumBillingSeconds: Schema.optionalKey(Schema.Number),
          gpus: Schema.optionalKey(Schema.Boolean),
          machineSuggestions: Schema.optionalKey(Schema.Array(Schema.String)),
          regionLabel: Schema.optionalKey(
            Schema.String.annotate({
              description: "What `cloud.region` means for this kind, when it is not a region.",
            }),
          ),
        }),
      ),
      helpLink: Schema.NullOr(Schema.Struct({ label: Schema.String, url: Schema.String })),
    }),
  ),
  credential: Schema.NullOr(
    Schema.Struct({
      description: Schema.String,
      shortLived: Schema.Boolean,
      namespaces: Schema.Boolean,
    }),
  ),
  settings: CiConnectionAccessSettingsSchema,
  preflight: Schema.Record(Schema.String, CiPreflightRecordSchema),
  updatedAt: Schema.NullOr(IsoDateTime),
}).annotate({ identifier: "CiConnectionAccess" });

export const CiResourceGrantSchema = Schema.Struct({
  id: Schema.String,
  accountId: Schema.String,
  accountName: Schema.String,
  pluginId: Schema.String,
  resourceId: Schema.String,
  resourceTypeId: Schema.String,
  resourceName: Schema.String,
  ciName: Schema.String,
  outputs: Schema.Array(Schema.String),
  secretVersion: Schema.NullOr(Schema.String),
  repos: ReposSchema,
  branchPattern: BranchPatternSchema,
  createdAt: IsoDateTime,
}).annotate({ identifier: "CiResourceGrant" });

export const CiResourceGrantInputSchema = Schema.Struct({
  resourceId: Schema.String,
  ciName: Schema.String.annotate({
    description:
      "The name pipelines use: `[A-Za-z0-9][A-Za-z0-9_-]{0,63}`, unique in the organization.",
  }),
  outputs: Schema.Array(Schema.String),
  secretVersion: Schema.NullOr(
    Schema.String.annotate({
      description:
        "For a secret with versions: `latest`, or a version id. Read as the output `value`.",
    }),
  ),
  repos: ReposSchema,
  branchPattern: BranchPatternSchema,
}).annotate({ identifier: "CiResourceGrantInput" });

export const CiSshKeyLendingSchema = Schema.Struct({
  sshKeyId: Schema.String,
  keyName: Schema.String,
  ownerUserId: Schema.String,
  ownerName: Schema.NullOr(Schema.String),
  ciName: Schema.String,
  repos: ReposSchema,
  branchPattern: BranchPatternSchema,
  mine: Schema.Boolean,
  createdAt: IsoDateTime,
}).annotate({ identifier: "CiSshKeyLending" });

export const CiAccessOverviewSchema = Schema.Struct({
  viewerUserId: Schema.NullOr(
    Schema.String.annotate({ description: "The caller: only a key's owner can lend it." }),
  ),
  connections: Schema.Array(CiConnectionAccessSchema),
  grants: Schema.Array(CiResourceGrantSchema),
  sshKeys: Schema.Array(CiSshKeyLendingSchema),
}).annotate({ identifier: "CiAccessOverview" });

export const CiResourceOutputsSchema = Schema.Struct({
  outputs: Schema.Array(
    Schema.Struct({ key: Schema.String, label: Schema.String, sensitive: Schema.Boolean }),
  ),
  secretVersions: Schema.NullOr(
    Schema.Array(
      Schema.Struct({
        id: Schema.String,
        state: Schema.String,
        createdAt: Schema.NullOr(Schema.String),
      }),
    ),
  ),
}).annotate({ identifier: "CiResourceOutputs" });

export const CiAccountSchema = Schema.Struct({
  installationId: Schema.Int,
  accountLogin: Schema.String,
  accountType: Schema.NullOr(Schema.String),
  ciEnabled: Schema.Boolean,
}).annotate({ identifier: "CiAccount" });

export const CiStatusSchema = Schema.Struct({
  enabled: Schema.Boolean.annotate({ description: "CI is turned on for this organization" }),
  configured: Schema.Boolean.annotate({
    description: "The runner pool is configured on this server",
  }),
  githubConfigured: Schema.Boolean,
  planIncludesCi: Schema.Boolean,
  accounts: Schema.Array(CiAccountSchema),
}).annotate({ identifier: "CiStatus" });

export const CiUsageSchema = Schema.Struct({
  month: Schema.String,
  runs: Schema.Int,
  vcpuSeconds: Schema.Number,
  memoryGibSeconds: Schema.Number,
  storageGibHours: Schema.Number,
  storageBytes: Schema.NullOr(Schema.Number),
}).annotate({ identifier: "CiUsage" });

export const CiValuesSchema = Schema.Struct({
  installationId: Schema.Int,
  repo: Schema.NullOr(Schema.String),
  secrets: Schema.Array(
    Schema.Struct({ name: Schema.String, updatedAt: IsoDateTime }).annotate({
      identifier: "CiSecret",
    }),
  ).annotate({ description: "Secret names only: a secret's value is write-only." }),
  variables: Schema.Array(
    Schema.Struct({ name: Schema.String, value: Schema.String, updatedAt: IsoDateTime }).annotate({
      identifier: "CiVariable",
    }),
  ),
}).annotate({ identifier: "CiValues" });

export const CiRepoCacheSchema = Schema.Struct({
  repo: Schema.String.annotate({ description: "The repository's name, lowercased." }),
  bytes: Schema.Number,
  entries: Schema.Int,
}).annotate({ identifier: "CiRepoCache" });

export const CiCachesSchema = Schema.Struct({
  accounts: Schema.Array(
    Schema.Struct({
      installationId: Schema.Int,
      accountLogin: Schema.String,
      usedBytes: Schema.Number,
      quotaBytes: Schema.NullOr(Schema.Number),
      repos: Schema.Array(CiRepoCacheSchema),
      error: Schema.NullOr(Schema.String).annotate({
        description: "Why the runners could not say what this account stores, when they could not.",
      }),
    }).annotate({ identifier: "CiAccountCaches" }),
  ),
}).annotate({ identifier: "CiCaches" });

export const CiScheduledPipelineSchema = Schema.Struct({
  file: Schema.String.annotate({ description: "The pipeline file, under `.infrawrench/ci/`." }),
  name: Schema.String,
  cron: Schema.Array(Schema.String).annotate({
    description: "Its `on.schedule` cron expressions, in UTC.",
  }),
  nextRunAt: Schema.NullOr(IsoDateTime).annotate({
    description: "The next minute one of them fires on; null when none ever does.",
  }),
}).annotate({ identifier: "CiScheduledPipeline" });

export const CiRepoScheduleSchema = Schema.Struct({
  installationId: Schema.Int,
  repoFullName: Schema.String,
  defaultBranch: Schema.String,
  sha: Schema.NullOr(Schema.String).annotate({
    description:
      "The default branch's commit the pipelines were read from, which scheduled runs check out.",
  }),
  pipelines: Schema.Array(CiScheduledPipelineSchema),
  refreshedAt: Schema.NullOr(IsoDateTime).annotate({
    description: "When the default branch was last read; null until the first read.",
  }),
  error: Schema.NullOr(Schema.String).annotate({
    description: "Why the last read failed, or which pipeline files did not parse.",
  }),
}).annotate({ identifier: "CiRepoSchedule" });

export const CiSchedulesSchema = Schema.Struct({
  schedules: Schema.Array(CiRepoScheduleSchema),
}).annotate({ identifier: "CiSchedules" });

export const CiCacheClearedSchema = Schema.Struct({
  installationId: Schema.Int,
  repo: Schema.String,
  deletedEntries: Schema.Int,
  deletedBytes: Schema.Number,
}).annotate({ identifier: "CiCacheCleared" });

const RunParams = { orgId: OrgId, runId: Uuid } as const;

/** Which secrets or variables: a connected account's, or one repository's. */
const ValueScopeQuery = {
  installationId: documentedAs(Schema.NumberFromString.check(Schema.isInt())).annotate({
    description: "The GitHub App installation of an account that runs CI.",
  }),
  repo: Schema.optionalKey(
    documentedAs(Schema.String).annotate({
      description: "A repository's name, for its own values. Omitted: the whole account's.",
    }),
  ),
} as const;
const ValueParams = {
  orgId: OrgId,
  kind: Schema.Literals(["secrets", "variables"]),
  name: Schema.String,
} as const;

export class CiGroup extends HttpApiGroup.make("ci")
  .add(
    HttpApiEndpoint.get("status", "/", { params: OrgParams, success: CiStatusSchema })
      .annotate(RequiredPermission, "ci:read")
      .annotate(OpenApi.Summary, "CI status and the GitHub accounts that run it")
      .annotate(SuccessDescription, "CI status"),
    HttpApiEndpoint.put("setAccount", "/accounts/:installationId", {
      params: { orgId: OrgId, installationId: Schema.NumberFromString.check(Schema.isInt()) },
      payload: Schema.Struct({ enabled: Schema.Boolean }),
      success: CiAccountSchema,
      error: [BadRequest, NotFound],
    })
      .annotate(RequiredPermission, "ci:write")
      .annotate(OpenApi.Summary, "Run CI, or stop running it, for a connected GitHub account")
      .annotate(SuccessDescription, "The account"),
    HttpApiEndpoint.get("listRuns", "/runs", {
      params: OrgParams,
      query: {
        status: Schema.optionalKey(documentedAs(CiRunStatusSchema)),
        limit: Schema.optionalKey(documentedAs(Schema.NumberFromString.check(Schema.isInt()))),
      },
      success: Schema.Struct({ runs: Schema.Array(CiRunSchema) }),
      error: NotFound,
    })
      .annotate(RequiredPermission, "ci:read")
      .annotate(OpenApi.Summary, "List CI runs, newest first")
      .annotate(SuccessDescription, "Runs"),
    HttpApiEndpoint.get("getRun", "/runs/:runId", {
      params: RunParams,
      success: CiRunDetailSchema,
      error: NotFound,
    })
      .annotate(RequiredPermission, "ci:read")
      .annotate(OpenApi.Summary, "A CI run, with each job's output once it has finished")
      .annotate(SuccessDescription, "The run"),
    HttpApiEndpoint.get("runLogs", "/runs/:runId/logs", {
      params: RunParams,
      success: RunLogStream,
      error: [NotFound, Conflict],
    })
      .annotate(RequiredPermission, "ci:read")
      .annotate(OpenApi.Summary, "A running CI run's log, streamed as SSE")
      .annotate(OpenApi.Exclude, true),
    HttpApiEndpoint.get("downloadLink", "/runs/:runId/download", {
      params: RunParams,
      query: {
        job: documentedAs(Schema.String).annotate({
          description: "The job's id, as the run's `jobs` list it.",
        }),
        path: documentedAs(Schema.String).annotate({
          description: "The file's `path`, as the job's `downloads` list it.",
        }),
      },
      success: CiDownloadLinkSchema,
      error: [NotFound, Conflict],
    })
      .annotate(RequiredPermission, "ci:read")
      .annotate(OpenApi.Summary, "A short-lived link to a file a job kept for download")
      .annotate(
        OpenApi.Description,
        "The link is signed for this one file for 15 minutes (less when the file expires sooner) and is served by the CI proxy, not this API.",
      )
      .annotate(SuccessDescription, "The link"),
    HttpApiEndpoint.post("approveRun", "/runs/:runId/approve", {
      params: RunParams,
      success: Ok,
      error: [NotFound, Conflict],
    })
      .annotate(RequiredPermission, "ci:approve")
      .annotate(OpenApi.Summary, "Approve a fork's pull request commit")
      .annotate(
        OpenApi.Description,
        "Runs CI for this one commit of a pull request from a fork, without the organization's or repository's secrets. A later commit needs approving again.",
      )
      .annotate(SuccessDescription, "Queued"),
    HttpApiEndpoint.post("rejectRun", "/runs/:runId/reject", {
      params: RunParams,
      success: Ok,
      error: [NotFound, Conflict],
    })
      .annotate(RequiredPermission, "ci:approve")
      .annotate(OpenApi.Summary, "Decline to run a fork's pull request commit")
      .annotate(SuccessDescription, "Rejected"),
    HttpApiEndpoint.post("retryRun", "/runs/:runId/retry", {
      params: RunParams,
      payload: Schema.Struct({
        noTaskCache: Schema.optionalKey(
          Schema.Boolean.annotate({
            description:
              "Run every `task-cache:` job instead of replaying a passing run's result. Results are saved again either way.",
          }),
        ),
      }),
      success: CiRunSchema,
      error: [NotFound, Conflict],
    })
      .annotate(RequiredPermission, "ci:approve")
      .annotate(OpenApi.Summary, "Run a finished CI run again")
      .annotate(
        OpenApi.Description,
        "Queues a new run of the same repository, commit, branch and event, linked to this one. A run waiting for approval is approved instead, and a fork's pull request still runs without secrets.",
      )
      .annotate(SuccessDescription, "The new run, queued"),
    HttpApiEndpoint.post("cancelRun", "/runs/:runId/cancel", {
      params: RunParams,
      success: CiRunSchema,
      error: [NotFound, Conflict],
    })
      .annotate(RequiredPermission, "ci:approve")
      .annotate(OpenApi.Summary, "Cancel a CI run")
      .annotate(
        OpenApi.Description,
        "A queued run, or one waiting for its concurrency group, ends as cancelled at once. A running one is stopped by its runner, its running jobs as a timeout would stop them, and ends as cancelled once the runner reports it. A run waiting for approval is rejected instead.",
      )
      .annotate(SuccessDescription, "The run, cancelled or being cancelled"),
    HttpApiEndpoint.get("listCaches", "/caches", {
      params: OrgParams,
      success: CiCachesSchema,
      error: NotFound,
    })
      .annotate(RequiredPermission, "ci:read")
      .annotate(OpenApi.Summary, "The caches CI keeps for each repository")
      .annotate(SuccessDescription, "Caches per account and repository"),
    HttpApiEndpoint.delete("clearCache", "/caches/:installationId/:repo", {
      params: {
        orgId: OrgId,
        installationId: Schema.NumberFromString.check(Schema.isInt()),
        repo: Schema.String,
      },
      success: CiCacheClearedSchema,
      error: [BadRequest, NotFound, Conflict],
    })
      .annotate(RequiredPermission, "ci:write")
      .annotate(OpenApi.Summary, "Clear a repository's CI caches")
      .annotate(
        OpenApi.Description,
        "Deletes every branch's and pull request's `cache:` and `task-cache:` entries of one repository. The next run of each job starts cold and saves again.",
      )
      .annotate(SuccessDescription, "What was removed"),
    HttpApiEndpoint.get("listSchedules", "/schedules", {
      params: OrgParams,
      success: CiSchedulesSchema,
      error: NotFound,
    })
      .annotate(RequiredPermission, "ci:read")
      .annotate(OpenApi.Summary, "Repositories' scheduled pipelines")
      .annotate(
        OpenApi.Description,
        "Each repository's pipelines with `on.schedule` on its default branch, as last read, with each pipeline's next run. They are read again on every push to the default branch, which is also how a schedule is added, changed or removed. Repositories with no scheduled pipeline are left out unless their last read failed.",
      )
      .annotate(SuccessDescription, "Scheduled pipelines per repository"),
    HttpApiEndpoint.get("listValues", "/values", {
      params: OrgParams,
      query: ValueScopeQuery,
      success: CiValuesSchema,
      error: [BadRequest, NotFound],
    })
      .annotate(RequiredPermission, "ci:write")
      .annotate(OpenApi.Summary, "List an account's or a repository's CI secrets and variables")
      .annotate(
        OpenApi.Description,
        "A repository's own value overrides the account's of the same name. Pipelines read them as `${{ secrets.NAME }}` and `${{ vars.NAME }}`; a fork's pull request gets variables but never secrets.",
      )
      .annotate(SuccessDescription, "Names, and variables' values"),
    HttpApiEndpoint.put("setValue", "/values/:kind/:name", {
      params: ValueParams,
      query: ValueScopeQuery,
      payload: Schema.Struct({ value: Schema.String }),
      success: Ok,
      error: [BadRequest, NotFound, Conflict],
    })
      .annotate(RequiredPermission, "ci:write")
      .annotate(OpenApi.Summary, "Set a CI secret or variable")
      .annotate(SuccessDescription, "Set"),
    HttpApiEndpoint.delete("deleteValue", "/values/:kind/:name", {
      params: ValueParams,
      query: ValueScopeQuery,
      success: Ok,
      error: [BadRequest, NotFound, Conflict],
    })
      .annotate(RequiredPermission, "ci:write")
      .annotate(OpenApi.Summary, "Remove a CI secret or variable")
      .annotate(SuccessDescription, "Removed"),
    HttpApiEndpoint.get("access", "/access", {
      params: OrgParams,
      success: CiAccessOverviewSchema,
      error: NotFound,
    })
      .annotate(RequiredPermission, "ci:read")
      .annotate(OpenApi.Summary, "What CI jobs may use: connections, resources and SSH keys")
      .annotate(
        OpenApi.Description,
        "Every connection whose provider can run CI jobs or lend its credentials, with what it is allowed; the resources granted to CI; and the SSH keys their owners lend. Nothing secret.",
      )
      .annotate(SuccessDescription, "CI access"),
    HttpApiEndpoint.put("setConnectionAccess", "/access/connections/:accountId", {
      params: { orgId: OrgId, accountId: Schema.String },
      payload: CiConnectionAccessSettingsSchema,
      success: CiConnectionAccessSchema,
      error: [BadRequest, NotFound, Conflict],
    })
      .annotate(RequiredPermission, "ci-access:write")
      .annotate(OpenApi.Summary, "Set what CI may do with a connection")
      .annotate(
        OpenApi.Description,
        "Run cloud jobs on it (kinds, limits, repositories, branches) and lend its credentials to jobs (repositories, branches). Turning cloud jobs on needs a passing permission check for every kind.",
      )
      .annotate(SuccessDescription, "The connection's CI access"),
    HttpApiEndpoint.post("preflightConnection", "/access/connections/:accountId/preflight", {
      params: { orgId: OrgId, accountId: Schema.String },
      payload: Schema.Struct({ kind: KindSchema, region: Schema.optionalKey(Schema.String) }),
      success: CiConnectionAccessSchema,
      error: [BadRequest, NotFound, Conflict],
    })
      .annotate(RequiredPermission, "ci-access:write")
      .annotate(OpenApi.Summary, "Check whether a connection can run cloud jobs of a kind")
      .annotate(
        OpenApi.Description,
        "Asks the provider without starting anything (a dry run or a permission test) and keeps the answer: what is missing and how to grant it. A failing check turns that kind off.",
      )
      .annotate(SuccessDescription, "The connection's CI access, with the check"),
    HttpApiEndpoint.get("resourceOutputs", "/access/resource-outputs", {
      params: OrgParams,
      query: {
        resourceId: documentedAs(Schema.String).annotate({ description: "The resource's id." }),
      },
      success: CiResourceOutputsSchema,
      error: [BadRequest, NotFound],
    })
      .annotate(RequiredPermission, "ci-access:write")
      .annotate(OpenApi.Summary, "What a resource can be granted to CI")
      .annotate(SuccessDescription, "Its outputs and, for a secret, its versions"),
    HttpApiEndpoint.post("createGrant", "/access/grants", {
      params: OrgParams,
      payload: CiResourceGrantInputSchema,
      success: CiResourceGrantSchema,
      error: [BadRequest, NotFound, Conflict],
    })
      .annotate(RequiredPermission, "ci-access:write")
      .annotate(OpenApi.Summary, "Grant CI jobs a resource's outputs")
      .annotate(
        OpenApi.Description,
        "Pipelines read them as `${{ resources.<ciName>.<output> }}` in `env:`, or all at once with `env-from: [<ciName>]`, read fresh for every run. Only for the listed repositories and branches, and never for a fork's pull request.",
      )
      .annotate(SuccessDescription, "The grant"),
    HttpApiEndpoint.put("updateGrant", "/access/grants/:grantId", {
      params: { orgId: OrgId, grantId: Schema.String },
      payload: CiResourceGrantInputSchema,
      success: CiResourceGrantSchema,
      error: [BadRequest, NotFound, Conflict],
    })
      .annotate(RequiredPermission, "ci-access:write")
      .annotate(OpenApi.Summary, "Change a resource grant")
      .annotate(SuccessDescription, "The grant"),
    HttpApiEndpoint.delete("deleteGrant", "/access/grants/:grantId", {
      params: { orgId: OrgId, grantId: Schema.String },
      success: Ok,
      error: NotFound,
    })
      .annotate(RequiredPermission, "ci:write")
      .annotate(OpenApi.Summary, "Remove a resource grant")
      .annotate(SuccessDescription, "Removed"),
    HttpApiEndpoint.put("setSshKeyLending", "/access/ssh-keys/:sshKeyId", {
      params: { orgId: OrgId, sshKeyId: Schema.String },
      payload: Schema.Struct({
        enabled: Schema.Boolean,
        ciName: Schema.String.annotate({
          description: "The name pipelines use in `ssh-keys:`; unique in the organization.",
        }),
        repos: ReposSchema,
        branchPattern: BranchPatternSchema,
      }),
      success: Schema.Struct({ lending: Schema.NullOr(CiSshKeyLendingSchema) }),
      error: [BadRequest, NotFound, Conflict],
    })
      .annotate(RequiredPermission, "ssh-keys:write")
      .annotate(OpenApi.Summary, "Lend one of your SSH keys to CI jobs, or stop")
      .annotate(
        OpenApi.Description,
        "Only the key's owner can, and only for a key whose private half Infrawrench holds. Jobs name it in `ssh-keys:`.",
      )
      .annotate(SuccessDescription, "The key's lending, or null once stopped"),
    HttpApiEndpoint.delete("revokeSshKeyLending", "/access/ssh-keys/:sshKeyId", {
      params: { orgId: OrgId, sshKeyId: Schema.String },
      success: Ok,
      error: NotFound,
    })
      .annotate(RequiredPermission, "ci:write")
      .annotate(OpenApi.Summary, "Stop CI jobs using someone's SSH key")
      .annotate(SuccessDescription, "No longer lent"),
    HttpApiEndpoint.get("usage", "/usage", {
      params: OrgParams,
      query: {
        month: Schema.optionalKey(
          documentedAs(Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}$/))),
        ),
      },
      success: CiUsageSchema,
      error: NotFound,
    })
      .annotate(RequiredPermission, "ci:read")
      .annotate(
        OpenApi.Summary,
        "CI usage in a month: runs, compute and storage (caches and downloads)",
      )
      .annotate(SuccessDescription, "Usage"),
  )
  .prefix("/api/org/:orgId/ci")
  .middleware(OrgAuth)
  .annotate(OpenApi.Title, "CI") {}

export class CiApi extends withApiDefaults(HttpApi.make("ci").add(CiGroup)) {}

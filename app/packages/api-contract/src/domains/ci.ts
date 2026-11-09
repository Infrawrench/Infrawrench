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
import { CI_JOB_STATUSES, CI_RUN_STATUSES } from "@infrawrench/client-core";
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
}).annotate({ identifier: "CiJobSummary" });

/** The run's live log: the runner's events as `event:` / `data:` frames. */
const RunLogStream = Schema.String.pipe(HttpApiSchema.asText({ contentType: "text/event-stream" }));

export const CiJobOutputSchema = Schema.Struct({
  ...CiJobSummarySchema.fields,
  stdout: Schema.String,
  stderr: Schema.String,
}).annotate({ identifier: "CiJobOutput" });

export const CiRunSchema = Schema.Struct({
  id: Schema.String,
  repoFullName: Schema.String,
  event: Schema.Literals(["push", "pull-request"]),
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
}).annotate({ identifier: "CiRun" });

export const CiRunDetailSchema = Schema.Struct({
  run: CiRunSchema,
  jobs: Schema.NullOr(Schema.Array(CiJobOutputSchema)),
}).annotate({ identifier: "CiRunDetail" });

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
      .annotate(OpenApi.Summary, "CI usage in a month: runs, compute and cache storage")
      .annotate(SuccessDescription, "Usage"),
  )
  .prefix("/api/org/:orgId/ci")
  .middleware(OrgAuth)
  .annotate(OpenApi.Title, "CI") {}

export class CiApi extends withApiDefaults(HttpApi.make("ci").add(CiGroup)) {}

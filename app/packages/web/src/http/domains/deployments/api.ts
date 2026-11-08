/**
 * Deployments: `/api/org/:orgId/deployments`, the endpoint definitions.
 *
 * Deployments run a repository's `Infrafile`. No route stores or returns the
 * Infrafile's source: it is read from git on every run and never persisted,
 * so the API only exposes the record of a run. The interactive run is not
 * here either: `select(...)` needs a live round trip, so it is a websocket
 * (`deploy:*` frames on `/api/ws`). What is here answers in one shot.
 *
 * The bodies are documented here and read raw by the handlers, which answer
 * a missing field with their own sentence, as they always have.
 */
import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/http-api";
import { minLength } from "@infrawrench/ui/schemas";
import { RequiredPermission, SuccessDescription } from "../../annotations";
import { withApiDefaults } from "../../domain";
import {
  BadRequest,
  Conflict,
  Forbidden,
  NotFound,
  PaymentRequired,
  Unauthorized,
} from "../../errors";
import { OrgAuth } from "../../middleware-tags";
import { ChangeFreezeBlocked } from "../../schemas/change-freeze";
import { documentedAs, optionalRequestBody } from "../../schemas/documented";
import { numericQuery } from "../../schemas/query";
import { IsoDateTime, Ok, OrgIdParams, OrgParams, Uuid } from "../../schemas/common";

const NonEmpty = Schema.String.check(minLength(1));
const Answers = Schema.Record(Schema.String, Schema.String);

export const DeployRepo = Schema.Struct({
  fullName: Schema.String.annotate({ examples: ["astrid/my-app"] }),
  defaultBranch: Schema.String.annotate({ examples: ["main"] }),
}).annotate({ identifier: "DeployRepo" });

const DefaultBranch = Schema.optionalKey(NonEmpty.annotate({ default: "main" }));

const DeployEnvsInput = Schema.Struct({
  repo: NonEmpty.annotate({ examples: ["astrid/my-app"] }),
  branch: DefaultBranch,
}).annotate({ identifier: "DeployEnvsInput" });

export const DeployEnvs = Schema.Struct({
  envs: Schema.Array(Schema.String).annotate({ examples: [["staging", "production"]] }),
  sha: Schema.String,
  repo: Schema.String,
  branch: Schema.String,
}).annotate({ identifier: "DeployEnvs" });

const DeployPlanInput = Schema.Struct({
  repo: NonEmpty,
  branch: DefaultBranch,
  env: Schema.optionalKey(Schema.String),
  /** Answers for `select(key, ...)`, so a plan needs no interactive round trip. */
  answers: Schema.optionalKey(Answers),
}).annotate({ identifier: "DeployPlanInput" });

const DeployRunLog = Schema.Struct({
  at: Schema.Int,
  level: Schema.Literals(["debug", "info", "warn", "error"]),
  message: Schema.String,
}).annotate({ identifier: "DeployRunLog" });

const DeployStage = Schema.Literals(["plan", "dockerfile", "build", "deploy", "destroy"]).annotate({
  identifier: "DeployStage",
});

const DeployStatus = Schema.Literals([
  "pending",
  "running",
  "success",
  "failure",
  "canceled",
]).annotate({ identifier: "DeployStatus" });

const Sidecar = Schema.Struct({ pluginId: Schema.String, parentResourceId: Schema.String });

/** A resource the run provisioned through `infra.accounts.*.create(...)`. */
const DeployCreatedResource = Schema.Struct({
  pluginId: Schema.String,
  accountId: Schema.String,
  resourceTypeId: Schema.String,
  resourceId: Schema.String,
  externalId: Schema.optionalKey(Schema.String),
  displayName: Schema.String,
  sidecar: Schema.optionalKey(Sidecar),
}).annotate({ identifier: "DeployCreatedResource" });

/**
 * A change a dry-run plan would make. On a plan-only run, creates, updates
 * and deletes through `infra.accounts` are intercepted and reported here.
 */
const DeployPlannedChange = Schema.Struct({
  action: Schema.Literals(["create", "update", "delete"]),
  accountId: Schema.String,
  resourceTypeId: Schema.String,
  resourceId: Schema.optionalKey(Schema.String),
  displayName: Schema.String,
  fields: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  sidecar: Schema.optionalKey(Sidecar),
}).annotate({ identifier: "DeployPlannedChange" });

export const DeployPlanResult = Schema.Struct({
  runId: Uuid,
  result: Schema.Struct({
    status: DeployStatus,
    env: Schema.String,
    plan: Schema.optionalKey(Schema.Unknown),
    /** The rendered Dockerfile. The Infrafile itself is never returned. */
    dockerfile: Schema.optionalKey(Schema.String),
    image: Schema.optionalKey(Schema.String),
    notes: Schema.Array(Schema.String),
    createdResources: Schema.Array(DeployCreatedResource),
    /** Populated on plan-only runs; empty on real deploys. */
    plannedChanges: Schema.Array(DeployPlannedChange),
    logs: Schema.Array(DeployRunLog),
    reachedStage: Schema.optionalKey(DeployStage),
    error: Schema.optionalKey(
      Schema.Struct({ message: Schema.String, stack: Schema.optionalKey(Schema.String) }),
    ),
    durationMs: Schema.Int,
  }),
}).annotate({ identifier: "DeployPlanResult" });

export const DeploymentRun = Schema.Struct({
  id: Uuid,
  env: Schema.String,
  repo: Schema.NullOr(Schema.String),
  branch: Schema.NullOr(Schema.String),
  gitSha: Schema.NullOr(Schema.String),
  image: Schema.NullOr(Schema.String),
  status: DeployStatus,
  origin: Schema.Literals(["web", "cli", "trigger"]),
  stage: Schema.NullOr(DeployStage),
  durationMs: Schema.NullOr(Schema.Int),
  /** Hosted build-worker seconds consumed. Null when we did not pay for the build. */
  buildSeconds: Schema.NullOr(Schema.Int),
  /** `cloud-build`, `ssh`, or null when nothing was built. */
  buildRunner: Schema.NullOr(Schema.Literals(["cloud-build", "ssh"])),
  startedAt: IsoDateTime,
}).annotate({ identifier: "DeploymentRun" });

const DeploymentRunInput = Schema.Struct({
  env: NonEmpty,
  status: DeployStatus,
  repo: Schema.optionalKey(Schema.String),
  branch: Schema.optionalKey(Schema.String),
  gitSha: Schema.optionalKey(Schema.String),
  image: Schema.optionalKey(Schema.String),
  stage: Schema.optionalKey(DeployStage),
  notes: Schema.optionalKey(Schema.Array(Schema.String)),
  /** Whatever the run's `infra.output(...)` recorded. */
  output: Schema.optionalKey(Schema.Unknown),
  /** Whatever `plan()` returned, so `deploy --plan` can diff against this run. */
  plan: Schema.optionalKey(Schema.Unknown),
  createdResources: Schema.optionalKey(Schema.Array(DeployCreatedResource)),
  durationMs: Schema.optionalKey(Schema.Int),
  error: Schema.optionalKey(Schema.NullOr(Schema.Struct({ message: Schema.String }))),
}).annotate({ identifier: "DeploymentRunInput" });

export const DeploymentRunRecorded = Schema.Struct({ id: Uuid });

export const DeployTrigger = Schema.Struct({
  id: Uuid,
  repo: Schema.String,
  branch: Schema.String,
  env: Schema.String,
  enabled: Schema.Boolean,
  /** Last commit seen. Recorded when the trigger is armed, so it fires on the next push. */
  lastSha: Schema.NullOr(Schema.String),
  lastRunAt: Schema.NullOr(IsoDateTime),
}).annotate({ identifier: "DeployTrigger" });

const DeployTriggerInput = Schema.Struct({
  repo: NonEmpty,
  branch: NonEmpty,
  env: NonEmpty,
  /** Answers for `select(key, ...)`: a triggered deploy has nobody to ask. */
  answers: Schema.optionalKey(Answers),
}).annotate({ identifier: "DeployTriggerInput" });

const DeployRollbackInput = Schema.Struct({
  /** Also delete resources created by runs newer than the target. Destructive; off by default. */
  deleteCreated: Schema.optionalKey(Schema.Boolean),
}).annotate({ identifier: "DeployRollbackInput" });

/** What an undocumented endpoint sends: the service's value, unchanged. */
export const Undocumented = Schema.Unknown;

export class DeploymentsGroup extends HttpApiGroup.make("deployments")
  .add(
    HttpApiEndpoint.get("repos", "/repos", {
      params: OrgParams,
      success: Schema.Array(DeployRepo),
      error: [Unauthorized, Forbidden],
    })
      .annotate(RequiredPermission, "deployments:read")
      .annotate(OpenApi.Summary, "List repositories this organization can deploy from")
      .annotate(
        OpenApi.Description,
        "Repositories visible to the organization's GitHub App installations. Empty when the app is not configured.",
      )
      .annotate(SuccessDescription, "Repositories"),
    // Read is right here: the file is fetched and regex-parsed, never executed.
    HttpApiEndpoint.post("envs", "/envs", {
      params: OrgParams,
      payload: DeployEnvsInput,
      success: DeployEnvs,
      error: [BadRequest, Unauthorized, Forbidden, NotFound],
    })
      .annotate(RequiredPermission, "deployments:read")
      .annotate(OpenApi.Summary, "List the environments a repository's Infrafile declares")
      .annotate(OpenApi.Transform, optionalRequestBody)
      .annotate(
        OpenApi.Description,
        "Reads `Infrafile` at the branch head and returns its declared environments. The file is parsed, not executed.",
      )
      .annotate(SuccessDescription, "Declared environments"),
    // Its own permission, between read and write: a plan evaluates the repo's
    // Infrafile against this org's host, so it is code execution and not a
    // read, but it builds nothing and ships nothing, so it is not a write.
    HttpApiEndpoint.post("plan", "/plan", {
      params: OrgParams,
      payload: DeployPlanInput,
      success: DeployPlanResult,
      error: [BadRequest, Unauthorized, Forbidden, NotFound],
    })
      .annotate(RequiredPermission, "deployments:plan")
      .annotate(OpenApi.Summary, "Preview a deploy without building")
      .annotate(OpenApi.Transform, optionalRequestBody)
      .annotate(
        OpenApi.Description,
        "Runs the Infrafile's `plan()` and renders its Dockerfile, then stops. Nothing is built or deployed.",
      )
      .annotate(SuccessDescription, "Plan result"),
    HttpApiEndpoint.get("runs", "/runs", {
      params: OrgParams,
      // Read as sent: the handler parses `limit` itself and the service clamps it.
      query: {
        env: Schema.optionalKey(Schema.String),
        limit: Schema.optionalKey(documentedAs(Schema.String)),
      },
      success: Schema.Array(DeploymentRun),
      error: [Unauthorized, Forbidden],
    })
      .annotate(RequiredPermission, "deployments:read")
      .annotate(OpenApi.Summary, "List deployment runs")
      .annotate(
        OpenApi.Transform,
        numericQuery({ limit: { type: "integer", minimum: 1, maximum: 200 } }),
      )
      .annotate(SuccessDescription, "Runs, newest first"),
    HttpApiEndpoint.post("recordRun", "/runs", {
      params: OrgParams,
      payload: DeploymentRunInput,
      success: DeploymentRunRecorded.pipe(HttpApiSchema.status(201)),
      error: [BadRequest, Unauthorized, Forbidden],
    })
      .annotate(RequiredPermission, "deployments:write")
      .annotate(OpenApi.Summary, "Record a deployment that ran elsewhere")
      .annotate(OpenApi.Transform, optionalRequestBody)
      .annotate(
        OpenApi.Description,
        "The CLI builds on the operator's own machine, so the server never sees that run. Reporting it here keeps one history across both origins.",
      )
      .annotate(SuccessDescription, "Recorded"),
    HttpApiEndpoint.get("run", "/runs/:id", {
      params: OrgIdParams,
      success: DeploymentRun,
      error: [Unauthorized, Forbidden, NotFound],
    })
      .annotate(RequiredPermission, "deployments:read")
      .annotate(OpenApi.Summary, "Get one deployment run, with its logs and rendered Dockerfile")
      .annotate(SuccessDescription, "Run"),
    // What this deploy did to the run rate, recomputed on every read because
    // provider cost arrives late and is then restated. `costs:read` on top of
    // `deployments:read` (in the handler): the response is spend. Served here
    // but documented by the Zod registry (`api/openapi/paths/change-cost-impact.ts`,
    // which owns the impact components shared with `/changes/cost-impacts`), so
    // it is excluded from this domain's document until those move.
    HttpApiEndpoint.get("costImpact", "/runs/:id/cost-impact", {
      params: OrgIdParams,
      query: {
        costBasis: Schema.optionalKey(Schema.String),
        windowDays: Schema.optionalKey(Schema.String),
      },
      success: Undocumented,
      error: [BadRequest, Forbidden, NotFound],
    })
      .annotate(RequiredPermission, "deployments:read")
      .annotate(OpenApi.Exclude, true),
    HttpApiEndpoint.post("rollback", "/runs/:id/rollback", {
      params: OrgIdParams,
      payload: DeployRollbackInput,
      success: DeployPlanResult,
      error: [
        BadRequest,
        Unauthorized,
        PaymentRequired,
        Forbidden,
        NotFound,
        Conflict,
        ChangeFreezeBlocked,
      ],
    })
      .annotate(RequiredPermission, "deployments:write")
      .annotate(OpenApi.Summary, "Roll back to a previous deployment")
      .annotate(
        OpenApi.Description,
        "Re-runs that run's `deploy()` with the image and plan it recorded, building nothing; the exact artifact that was known good ships again. The Infrafile is read at the commit that run deployed, not at the branch head. Only a successful run that produced an image can be rolled back to. With `deleteCreated`, resources that runs after the target created through `infra.accounts` are deleted once the rollback has succeeded; undoing the provisioning, not just the shipping. Deletions are best-effort and reported in the result's notes.",
      )
      .annotate(OpenApi.Transform, optionalRequestBody)
      .annotate(SuccessDescription, "Rollback result"),
    HttpApiEndpoint.get("triggers", "/triggers", {
      params: OrgParams,
      success: Schema.Array(DeployTrigger),
      error: [Unauthorized, Forbidden],
    })
      .annotate(RequiredPermission, "deployments:read")
      .annotate(OpenApi.Summary, "List deploy-on-push triggers")
      .annotate(SuccessDescription, "Triggers"),
    // `deployments:write`: a trigger is a standing instruction to deploy, the
    // same authority as deploying, just deferred.
    HttpApiEndpoint.post("upsertTrigger", "/triggers", {
      params: OrgParams,
      payload: DeployTriggerInput,
      success: DeployTrigger.pipe(HttpApiSchema.status(201)),
      error: [BadRequest, Unauthorized, Forbidden, NotFound],
    })
      .annotate(RequiredPermission, "deployments:write")
      .annotate(OpenApi.Summary, "Deploy an environment whenever a branch moves")
      .annotate(OpenApi.Transform, optionalRequestBody)
      .annotate(
        OpenApi.Description,
        "Arming a trigger records the branch's current commit WITHOUT deploying it; the trigger fires on the next push, not on the state at the moment it was created. The environment is validated against the Infrafile at that branch head, so a typo fails here rather than silently never firing.",
      )
      .annotate(SuccessDescription, "Trigger"),
    HttpApiEndpoint.patch("setTriggerEnabled", "/triggers/:id", {
      params: OrgIdParams,
      payload: Schema.Struct({ enabled: Schema.Boolean }),
      success: DeployTrigger,
      error: [BadRequest, Unauthorized, Forbidden, NotFound],
    })
      .annotate(RequiredPermission, "deployments:write")
      .annotate(OpenApi.Summary, "Enable or disable a deploy trigger")
      .annotate(OpenApi.Transform, optionalRequestBody)
      .annotate(SuccessDescription, "Trigger"),
    HttpApiEndpoint.delete("deleteTrigger", "/triggers/:id", {
      params: OrgIdParams,
      success: Ok,
      error: [Unauthorized, Forbidden],
    })
      .annotate(RequiredPermission, "deployments:write")
      .annotate(OpenApi.Summary, "Delete a deploy trigger")
      .annotate(SuccessDescription, "Deleted"),
  )
  .prefix("/api/org/:orgId/deployments")
  .middleware(OrgAuth)
  .annotate(OpenApi.Title, "Deployments") {}

export class DeploymentsApi extends withApiDefaults(
  HttpApi.make("deployments").add(DeploymentsGroup),
) {}

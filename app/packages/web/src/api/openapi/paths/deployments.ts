import { z } from "../zod";
import { strict, ErrorResponses, Ok, OrgIdParam, Uuid, IsoDateTime } from "../common";
import type { BuildContext } from "../context";

const DeployRepo = strict({
  fullName: z.string().openapi({ example: "astrid/my-app" }),
  defaultBranch: z.string().openapi({ example: "main" }),
}).openapi("DeployRepo");

const DeployEnvsInput = strict({
  repo: z.string().min(1).openapi({ example: "astrid/my-app" }),
  branch: z.string().min(1).default("main"),
}).openapi("DeployEnvsInput");

const DeployEnvs = strict({
  envs: z.array(z.string()).openapi({ example: ["staging", "production"] }),
  sha: z.string(),
  repo: z.string(),
  branch: z.string(),
}).openapi("DeployEnvs");

const DeployPlanInput = strict({
  repo: z.string().min(1),
  branch: z.string().min(1).default("main"),
  env: z.string().optional(),
  /** Answers for `select(key, …)`, so a plan needs no interactive round trip. */
  answers: z.record(z.string(), z.string()).optional(),
}).openapi("DeployPlanInput");

const DeployRunLog = strict({
  at: z.number().int(),
  level: z.enum(["debug", "info", "warn", "error"]),
  message: z.string(),
}).openapi("DeployRunLog");

const DeployStage = z.enum(["plan", "dockerfile", "build", "deploy"]).openapi("DeployStage");

const DeployStatus = z
  .enum(["pending", "running", "success", "failure", "canceled"])
  .openapi("DeployStatus");

const DeployPlanResult = strict({
  runId: Uuid,
  result: strict({
    status: DeployStatus,
    env: z.string(),
    plan: z.unknown().optional(),
    /** The *rendered* Dockerfile. The Infrafile itself is never returned. */
    dockerfile: z.string().optional(),
    image: z.string().optional(),
    notes: z.array(z.string()),
    logs: z.array(DeployRunLog),
    reachedStage: DeployStage.optional(),
    error: strict({ message: z.string(), stack: z.string().optional() }).optional(),
    durationMs: z.number().int(),
  }),
}).openapi("DeployPlanResult");

const DeploymentRun = strict({
  id: Uuid,
  env: z.string(),
  repo: z.string().nullable(),
  branch: z.string().nullable(),
  gitSha: z.string().nullable(),
  image: z.string().nullable(),
  status: DeployStatus,
  origin: z.enum(["web", "cli"]),
  // A union, not `.nullable()`: the latter renders as
  // `allOf: [$ref, {type:["string","null"]}]`, which still demands an enum value
  // and so rejects the nulls this column actually stores. The generator adds its
  // own null branch on top of this one, so the output carries a harmless
  // duplicate in the anyOf — cosmetic, and not worth a component to dodge.
  stage: z.union([DeployStage, z.null()]),
  durationMs: z.number().int().nullable(),
  /** Hosted build-worker seconds consumed. Null when we did not pay for the build. */
  buildSeconds: z.number().int().nullable(),
  /** `cloud-build`, `ssh`, or null when nothing was built. */
  buildRunner: z.union([z.enum(["cloud-build", "ssh"]), z.null()]),
  startedAt: IsoDateTime,
}).openapi("DeploymentRun");

const DeploymentRunInput = strict({
  env: z.string().min(1),
  status: DeployStatus,
  repo: z.string().optional(),
  branch: z.string().optional(),
  gitSha: z.string().optional(),
  image: z.string().optional(),
  stage: DeployStage.optional(),
  notes: z.array(z.string()).optional(),
  durationMs: z.number().int().optional(),
  error: strict({ message: z.string() }).nullable().optional(),
}).openapi("DeploymentRunInput");

const DeployTrigger = strict({
  id: Uuid,
  repo: z.string(),
  branch: z.string(),
  env: z.string(),
  enabled: z.boolean(),
  /** Last commit seen. Recorded when the trigger is armed, so it fires on the NEXT push. */
  lastSha: z.string().nullable(),
  lastRunAt: z.union([IsoDateTime, z.null()]),
}).openapi("DeployTrigger");

const DeployTriggerInput = strict({
  repo: z.string().min(1),
  branch: z.string().min(1),
  env: z.string().min(1),
  /** Answers for `select(key, …)`: a triggered deploy has nobody to ask. */
  answers: z.record(z.string(), z.string()).optional(),
}).openapi("DeployTriggerInput");

/**
 * Deployments run a repository's `Infrafile`. Note what is absent: there is no
 * route that stores or returns the Infrafile's source. It is read from git on
 * every run and never persisted, so the API only ever exposes the *record* of a
 * run. The interactive run itself is a websocket (`deploy:*` frames on
 * `/api/ws`), because `select(...)` needs a live round trip.
 */
export function registerDeploymentPaths(ctx: BuildContext) {
  const { registry } = ctx;
  const runIdParam = () =>
    OrgIdParam.extend({ id: Uuid.openapi({ param: { name: "id", in: "path" } }) });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/deployments/repos",
    tags: ["Deployments"],
    summary: "List repositories this organization can deploy from",
    description:
      "Repositories visible to the organization's GitHub App installations. Empty when the app is not configured.",
    request: { params: OrgIdParam },
    responses: {
      200: {
        description: "Repositories",
        content: { "application/json": { schema: z.array(DeployRepo) } },
      },
      401: ErrorResponses[401],
      403: ErrorResponses[403],
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/deployments/envs",
    tags: ["Deployments"],
    summary: "List the environments a repository's Infrafile declares",
    description:
      "Reads `Infrafile` at the branch head and returns its declared environments. The file is parsed, not executed.",
    request: {
      params: OrgIdParam,
      body: { content: { "application/json": { schema: DeployEnvsInput } } },
    },
    responses: {
      200: {
        description: "Declared environments",
        content: { "application/json": { schema: DeployEnvs } },
      },
      400: ErrorResponses[400],
      401: ErrorResponses[401],
      403: ErrorResponses[403],
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/deployments/plan",
    tags: ["Deployments"],
    summary: "Preview a deploy without building",
    description:
      "Runs the Infrafile's `plan()` and renders its Dockerfile, then stops. Nothing is built or deployed.",
    request: {
      params: OrgIdParam,
      body: { content: { "application/json": { schema: DeployPlanInput } } },
    },
    responses: {
      200: {
        description: "Plan result",
        content: { "application/json": { schema: DeployPlanResult } },
      },
      400: ErrorResponses[400],
      401: ErrorResponses[401],
      403: ErrorResponses[403],
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/deployments/runs",
    tags: ["Deployments"],
    summary: "List deployment runs",
    request: {
      params: OrgIdParam,
      query: strict({
        env: z.string().optional(),
        limit: z.coerce.number().int().min(1).max(200).optional(),
      }),
    },
    responses: {
      200: {
        description: "Runs, newest first",
        content: { "application/json": { schema: z.array(DeploymentRun) } },
      },
      401: ErrorResponses[401],
      403: ErrorResponses[403],
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/deployments/runs/{id}",
    tags: ["Deployments"],
    summary: "Get one deployment run, with its logs and rendered Dockerfile",
    request: { params: runIdParam() },
    responses: {
      200: { description: "Run", content: { "application/json": { schema: DeploymentRun } } },
      401: ErrorResponses[401],
      403: ErrorResponses[403],
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/deployments/runs/{id}/rollback",
    tags: ["Deployments"],
    summary: "Roll back to a previous deployment",
    description:
      "Re-runs that run's `deploy()` with the image and plan it recorded, building nothing — the exact artifact that was known good ships again. The Infrafile is read at the commit that run deployed, not at the branch head. Only a successful run that produced an image can be rolled back to.",
    request: { params: runIdParam() },
    responses: {
      200: {
        description: "Rollback result",
        content: { "application/json": { schema: DeployPlanResult } },
      },
      400: ErrorResponses[400],
      402: ErrorResponses[402],
      409: ErrorResponses[409],
      401: ErrorResponses[401],
      403: ErrorResponses[403],
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/deployments/triggers",
    tags: ["Deployments"],
    summary: "List deploy-on-push triggers",
    request: { params: OrgIdParam },
    responses: {
      200: {
        description: "Triggers",
        content: { "application/json": { schema: z.array(DeployTrigger) } },
      },
      401: ErrorResponses[401],
      403: ErrorResponses[403],
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/deployments/triggers",
    tags: ["Deployments"],
    summary: "Deploy an environment whenever a branch moves",
    description:
      "Arming a trigger records the branch's current commit WITHOUT deploying it — the trigger fires on the next push, not on the state at the moment it was created. The environment is validated against the Infrafile at that branch head, so a typo fails here rather than silently never firing.",
    request: {
      params: OrgIdParam,
      body: { content: { "application/json": { schema: DeployTriggerInput } } },
    },
    responses: {
      201: { description: "Trigger", content: { "application/json": { schema: DeployTrigger } } },
      400: ErrorResponses[400],
      401: ErrorResponses[401],
      403: ErrorResponses[403],
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "patch",
    path: "/api/org/{orgId}/deployments/triggers/{id}",
    tags: ["Deployments"],
    summary: "Enable or disable a deploy trigger",
    request: {
      params: runIdParam(),
      body: { content: { "application/json": { schema: strict({ enabled: z.boolean() }) } } },
    },
    responses: {
      200: { description: "Trigger", content: { "application/json": { schema: DeployTrigger } } },
      401: ErrorResponses[401],
      403: ErrorResponses[403],
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "delete",
    path: "/api/org/{orgId}/deployments/triggers/{id}",
    tags: ["Deployments"],
    summary: "Delete a deploy trigger",
    request: { params: runIdParam() },
    responses: {
      200: { description: "Deleted", content: { "application/json": { schema: Ok } } },
      401: ErrorResponses[401],
      403: ErrorResponses[403],
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/deployments/runs",
    tags: ["Deployments"],
    summary: "Record a deployment that ran elsewhere",
    description:
      "The CLI builds on the operator's own machine, so the server never sees that run. Reporting it here keeps one history across both origins.",
    request: {
      params: OrgIdParam,
      body: { content: { "application/json": { schema: DeploymentRunInput } } },
    },
    responses: {
      201: {
        description: "Recorded",
        content: { "application/json": { schema: strict({ id: Uuid }) } },
      },
      400: ErrorResponses[400],
      401: ErrorResponses[401],
      403: ErrorResponses[403],
    },
  });
}

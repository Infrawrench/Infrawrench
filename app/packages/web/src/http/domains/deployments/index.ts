/**
 * Deployments: `/api/org/:orgId/deployments`, the handlers. The logic lives
 * in `services/deployments.ts`; this is transport only, reading each body
 * raw as the routes did.
 *
 * The whole prefix is session-gateway only (`edge/gateway-routes.ts`):
 * hosted builds run for up to 20 minutes. Nothing here streams; a plan or a
 * rollback answers once, when the run finishes.
 */
import { Effect, Predicate, Schema } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { parseCostBasis } from "@infrawrench/client-core";
import { loadDeploymentCostImpact } from "@infrawrench/server-core/cost/change-impact-load";
import {
  DeploymentError,
  declaredEnvs,
  deleteDeployTrigger,
  getDeploymentRun,
  listDeployTriggers,
  listDeployableRepos,
  listDeploymentRuns,
  recordCliRun,
  resolveInfrafile,
  rollbackDeployment,
  runDeployment,
  setDeployTriggerEnabled,
  upsertDeployTrigger,
} from "../../../services/deployments";
import { PlanRequiredError } from "../../../services/entitlements";
import { requireNoChangeFreeze } from "../../change-freeze";
import { makeDomain } from "../../domain";
import { badRequest, notFound } from "../../errors";
import { fieldsOf, readJson, readJsonOr } from "../../json-body";
import { legacy } from "../../legacy";
import { OrgPrincipal, requirePermission } from "../../principal";
import { respond } from "../../response";
import { DeploymentCostImpact } from "../../schemas/change-cost-impact";
import { ok } from "../../schemas/common";
import { refuse, statusCall, type ReadRefusal } from "../status-refusals";
import {
  DeployEnvs,
  DeploymentRun,
  DeploymentRunRecorded,
  DeploymentsApi,
  DeployPlanResult,
  DeployRepo,
  DeployTrigger,
} from "./api";

/**
 * `fail(c, e)`: 402 Payment Required is the honest status for "your plan does
 * not include this", and lets the client tell it from a permission problem.
 */
const deploymentRefusal: ReadRefusal = (error) => {
  if (error instanceof PlanRequiredError) return { status: 402, message: error.message };
  if (error instanceof DeploymentError) return error;
  return undefined;
};

/** `select(...)` answers, passed to the runner as sent. */
const isAnswers = (value: unknown): value is Record<string, string> =>
  Predicate.isObject(value) && !Array.isArray(value);

const textOr = (value: unknown, fallback: string): string =>
  Predicate.isString(value) ? value : fallback;

type CliRunReport = Parameters<typeof recordCliRun>[2];

/** A CLI run report with the two fields the route required; the rest is the runner's to judge. */
const isCliRunReport = (body: unknown): body is CliRunReport =>
  Predicate.isObject(body) && Boolean(body["env"]) && Boolean(body["status"]);

/** The caller, when there is one, as the runner's optional `userId`. */
const callerId = Effect.gen(function* () {
  const { session } = yield* OrgPrincipal;
  return session.userId ? { userId: session.userId } : {};
});

const DeploymentsHandlers = HttpApiBuilder.group(DeploymentsApi, "deployments", (handlers) =>
  handlers
    .handle("repos", () =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const repos = yield* legacy(() => listDeployableRepos(organizationId));
        return yield* respond(Schema.Array(DeployRepo))(repos);
      }),
    )
    .handleRaw("envs", ({ request }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const { repo, branch } = yield* fieldsOf(yield* readJson(request));
        const envs = yield* statusCall(
          deploymentRefusal,
          { 400: refuse[400], 404: refuse[404] },
          async () => {
            const resolved = await resolveInfrafile(
              organizationId,
              textOr(repo, ""),
              textOr(branch, "main"),
            );
            return {
              envs: declaredEnvs(resolved.source),
              sha: resolved.sha,
              repo: resolved.fullName,
              branch: resolved.branch,
            };
          },
        );
        return yield* respond(DeployEnvs)(envs);
      }),
    )
    .handleRaw("plan", ({ request }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const caller = yield* callerId;
        const { repo, branch, env, answers } = yield* fieldsOf(yield* readJson(request));
        const run = yield* statusCall(
          deploymentRefusal,
          { 400: refuse[400], 404: refuse[404] },
          () =>
            runDeployment({
              organizationId,
              ...caller,
              repo: textOr(repo, ""),
              branch: textOr(branch, "main"),
              ...(Predicate.isString(env) && env ? { env } : {}),
              ...(isAnswers(answers) ? { answers } : {}),
              planOnly: true,
              interactive: false,
            }),
        );
        return yield* respond(DeployPlanResult)({ runId: run.runId, result: run.result });
      }),
    )
    .handle("runs", ({ query }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const limit = Number(query.limit ?? "50");
        const runs = yield* legacy(() =>
          listDeploymentRuns(organizationId, {
            ...(query.env ? { env: query.env } : {}),
            ...(Number.isFinite(limit) ? { limit } : {}),
          }),
        );
        return yield* respond(Schema.Array(DeploymentRun))(runs);
      }),
    )
    .handleRaw("recordRun", ({ request }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        const body = yield* readJson(request);
        if (!isCliRunReport(body)) return yield* badRequest("env and status are required");
        const recorded = yield* statusCall(deploymentRefusal, { 400: refuse[400] }, () =>
          recordCliRun(organizationId, session.userId, body),
        );
        return yield* respond(DeploymentRunRecorded, { status: 201 })(recorded);
      }),
    )
    .handle("run", ({ params }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const run = yield* statusCall(deploymentRefusal, { 404: refuse[404] }, () =>
          getDeploymentRun(organizationId, params.id),
        );
        return yield* respond(DeploymentRun)(run);
      }),
    )
    .handle("costImpact", ({ params, query }) =>
      Effect.gen(function* () {
        yield* requirePermission("deployments:read");
        yield* requirePermission("costs:read");
        const { organizationId } = yield* OrgPrincipal;
        const basis = parseCostBasis(query.costBasis);
        if (basis === null) return yield* badRequest("costBasis must be cash or amortized");
        const windowDays = Number.parseInt(query.windowDays ?? "", 10);
        const impact = yield* legacy(() =>
          loadDeploymentCostImpact(organizationId, params.id, {
            ...(Number.isFinite(windowDays) ? { windowDays } : {}),
            costBasis: basis,
          }),
        );
        if (!impact) return yield* notFound("Deployment run not found");
        return yield* respond(DeploymentCostImpact)(impact);
      }),
    )
    // Re-run a previous run's `deploy()` with the image and plan it recorded,
    // building nothing. Non-interactive by design: the plan is replayed.
    .handleRaw("rollback", ({ params, request }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        yield* requireNoChangeFreeze(request, {
          action: "deployment.rollback",
          entityType: "deployment_run",
          entityId: params.id,
        });
        const caller = yield* callerId;
        // The body is optional: a bare rollback has nothing to say.
        const { deleteCreated } = yield* fieldsOf(yield* readJsonOr(request, {}));
        const run = yield* statusCall(
          deploymentRefusal,
          { 400: refuse[400], 402: refuse[402], 404: refuse[404], 409: refuse[409] },
          () =>
            rollbackDeployment({
              organizationId,
              runId: params.id,
              ...caller,
              // Explicit true or nothing: this deletes real resources.
              ...(deleteCreated === true ? { deleteCreated: true } : {}),
            }),
        );
        return yield* respond(DeployPlanResult)({ runId: run.runId, result: run.result });
      }),
    )
    .handle("triggers", () =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const triggers = yield* legacy(() => listDeployTriggers(organizationId));
        return yield* respond(Schema.Array(DeployTrigger))(triggers);
      }),
    )
    .handleRaw("upsertTrigger", ({ request }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        const { repo, branch, env, answers } = yield* fieldsOf(yield* readJson(request));
        if (
          !Predicate.isString(repo) ||
          !repo ||
          !Predicate.isString(branch) ||
          !branch ||
          !Predicate.isString(env) ||
          !env
        ) {
          return yield* badRequest("repo, branch and env are required");
        }
        const trigger = yield* statusCall(
          deploymentRefusal,
          { 400: refuse[400], 404: refuse[404] },
          () =>
            upsertDeployTrigger(organizationId, session.userId, {
              repo,
              branch,
              env,
              ...(isAnswers(answers) ? { answers } : {}),
            }),
        );
        return yield* respond(DeployTrigger, { status: 201 })(trigger);
      }),
    )
    .handleRaw("setTriggerEnabled", ({ params, request }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const { enabled } = yield* fieldsOf(yield* readJson(request));
        // Explicit or nothing: enabling a trigger arms a real deploy on the
        // next push, not something a missing field should ever do.
        if (!Predicate.isBoolean(enabled)) {
          return yield* badRequest("enabled must be true or false");
        }
        const trigger = yield* statusCall(
          deploymentRefusal,
          { 400: refuse[400], 404: refuse[404] },
          () => setDeployTriggerEnabled(organizationId, params.id, enabled),
        );
        return yield* respond(DeployTrigger)(trigger);
      }),
    )
    .handle("deleteTrigger", ({ params }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        yield* legacy(() => deleteDeployTrigger(organizationId, params.id));
        return ok;
      }),
    ),
);

export const deploymentsDomain = makeDomain("deployments", DeploymentsApi, DeploymentsHandlers);

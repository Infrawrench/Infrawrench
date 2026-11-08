/**
 * Workflows: `/api/org/:orgId/workflows`, the handlers. The logic lives in
 * `services/workflows.ts`, shared with the MCP and chat tools; this is
 * transport only, and it reads every body raw, exactly as the routes did.
 *
 * Manual run sits with `workflows:write` rather than a permission of its own:
 * anyone who can edit a workflow can already give it a cron or git trigger.
 * Deciding approval requests is a different trust level, `workflows:approve`
 * (the workflow-approvals domain).
 */
import { Effect, Predicate } from "effect";
import type { HttpServerRequest } from "effect/http";
import { HttpApiBuilder } from "effect/http-api";
import type { MetricDef, WorkflowTrigger } from "@infrawrench/workflow-runtime";
import {
  badRequest,
  notFound,
  ok,
  Unauthorized,
  Undocumented,
  WorkflowsApi,
  WorkflowScheduleResponse,
  WorkflowSecretAssignment,
  WorkflowTypingsResponse,
} from "@infrawrench/api-contract";
import {
  WorkflowError,
  assignWorkflowSecrets,
  checkWorkflowSource,
  clearWorkflowSchedule,
  createWorkflow,
  generateWorkflowTypings,
  getWorkflow,
  listWorkflowMetrics,
  listWorkflowRuns,
  listWorkflows,
  redactWorkflow,
  setWorkflowSchedule,
  softDeleteWorkflow,
  updateWorkflow,
  workflowScheduleView,
  type WorkflowBody,
} from "../../../services/workflows";
import { runWorkflowById } from "../../../services/workflow-runner";
import { logAudit } from "../../../services/audit";
import {
  WorkflowSecretError,
  getWorkflowSecretAssignments,
  listAssignedWorkflowSecrets,
} from "../../../services/workflow-secrets";
import { makeDomain } from "../../domain";
import { fieldsOf, readJson, readJsonOr } from "../../request-body";
import { refuse, refusalCall, type ReadRefusal } from "../../refusals";
import { fireAndForget, legacy } from "../../legacy";
import { OrgPrincipal, requirePermission } from "../../principal";
import { respond } from "../../response";

/** `fail(c, e)`: the service's refusals carry their status; anything else is a 500. */
const workflowRefusal: ReadRefusal = (error) =>
  error instanceof WorkflowError || error instanceof WorkflowSecretError ? error : undefined;

/** The service's value, sent exactly as `c.json(value)` did. */
const sendAsIs = respond(Undocumented);

/**
 * The body as the route cast it: `(await c.req.json()) as WorkflowBody`. Not
 * JSON was a 500 and `null` a 500 on its first property read; the service
 * judges the fields.
 */
const isWorkflowBody = (body: unknown): body is WorkflowBody => Predicate.isObject(body);

const readWorkflowBody = Effect.fnUntraced(function* (
  request: HttpServerRequest.HttpServerRequest,
) {
  const fields = yield* fieldsOf(yield* readJson(request));
  const body: WorkflowBody = isWorkflowBody(fields) ? fields : {};
  return body;
});

/** A stored trigger, as `validateTrigger` wrote it. */
const isStoredTrigger = (value: unknown): value is WorkflowTrigger => Predicate.isObject(value);

/** Stored metric definitions, as the editor saved them. */
const isStoredMetrics = (value: unknown): value is MetricDef[] => Array.isArray(value);

type StoredWorkflow = NonNullable<Awaited<ReturnType<typeof getWorkflow>>>;

/** The typing context a workflow's own row gives: its metrics and its trigger kind. */
const typingContext = (wf: StoredWorkflow) => ({
  metrics: isStoredMetrics(wf.metricDefs) ? wf.metricDefs : [],
  ...(isStoredTrigger(wf.trigger) ? { triggerKind: wf.trigger.kind } : {}),
});

/** Load the workflow or fail with the route's 404. */
const load = Effect.fnUntraced(function* (id: string) {
  const { organizationId } = yield* OrgPrincipal;
  const wf = yield* legacy(() => getWorkflow(organizationId, id));
  if (!wf) return yield* notFound();
  return wf;
});

/**
 * An edit that changes a workflow's code or trigger makes its automated runs
 * act for the editor, and those runs load the workflow's assigned secrets. So
 * editing a workflow that has any requires `secrets:read`, the same bar as
 * assigning them in the first place.
 */
const requireSecretsReadIfAssigned = Effect.fnUntraced(function* (id: string) {
  const { organizationId } = yield* OrgPrincipal;
  const assigned = yield* legacy(() =>
    getWorkflowSecretAssignments(organizationId, id).catch((): string[] => []),
  );
  if (assigned.length > 0) yield* requirePermission("secrets:read");
});

const auditSecretAssignment = (workflowId: string, secretIds: readonly string[]) =>
  Effect.gen(function* () {
    const { organizationId, session } = yield* OrgPrincipal;
    yield* fireAndForget(() =>
      logAudit({
        organizationId,
        userId: session.userId,
        action: "workflow.secrets_assign",
        entityType: "workflow",
        entityId: workflowId,
        metadata: { secretIds },
      }),
    );
  });

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every(Predicate.isString);

const WorkflowsHandlers = HttpApiBuilder.group(WorkflowsApi, "workflows", (handlers) =>
  handlers
    .handle("list", () =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const rows = yield* legacy(() => listWorkflows(organizationId));
        return yield* sendAsIs(rows.map(redactWorkflow));
      }),
    )
    .handleRaw("create", ({ request }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        const body = yield* readWorkflowBody(request);
        if (body.secretIds !== undefined) yield* requirePermission("secrets:read");
        const workflow = yield* refusalCall(
          workflowRefusal,
          { 400: refuse[400], 404: refuse[404] },
          () => createWorkflow(organizationId, body, session.userId),
        );
        if (body.secretIds !== undefined) {
          yield* auditSecretAssignment(workflow.id, body.secretIds);
        }
        return yield* respond(Undocumented, { status: 201 })(redactWorkflow(workflow));
      }),
    )
    .handle("get", ({ params }) =>
      Effect.gen(function* () {
        const wf = yield* load(params.id);
        return yield* sendAsIs(redactWorkflow(wf));
      }),
    )
    .handleRaw("update", ({ params, request }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        const body = yield* readWorkflowBody(request);
        if (body.secretIds !== undefined) yield* requirePermission("secrets:read");
        else yield* requireSecretsReadIfAssigned(params.id);
        const workflow = yield* refusalCall(
          workflowRefusal,
          { 400: refuse[400], 404: refuse[404] },
          () => updateWorkflow(organizationId, params.id, body, session.userId),
        );
        if (body.secretIds !== undefined) {
          yield* auditSecretAssignment(workflow.id, body.secretIds);
        }
        return yield* sendAsIs(redactWorkflow(workflow));
      }),
    )
    .handle("delete", ({ params }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        yield* refusalCall(workflowRefusal, { 400: refuse[400], 404: refuse[404] }, () =>
          softDeleteWorkflow(organizationId, params.id),
        );
        return ok;
      }),
    )
    .handle("getSecrets", ({ params }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const secrets = yield* refusalCall(workflowRefusal, { 404: refuse[404] }, () =>
          listAssignedWorkflowSecrets(organizationId, params.id),
        );
        return yield* respond(WorkflowSecretAssignment)({
          secretIds: secrets.map((secret) => secret.id),
          secrets,
        });
      }),
    )
    .handleRaw("setSecrets", ({ params, request }) =>
      Effect.gen(function* () {
        yield* requirePermission("secrets:read");
        const { organizationId, session } = yield* OrgPrincipal;
        const body = yield* readJsonOr(request, null);
        const secretIds = Predicate.isObject(body) ? body["secretIds"] : undefined;
        if (!isStringArray(secretIds)) {
          return yield* badRequest("Body must include a secretIds string array.");
        }
        const assignment = yield* refusalCall(
          workflowRefusal,
          { 400: refuse[400], 404: refuse[404] },
          async () => {
            const secrets = await assignWorkflowSecrets(
              organizationId,
              params.id,
              secretIds,
              session.userId,
            );
            void logAudit({
              organizationId,
              userId: session.userId,
              action: "workflow.secrets_assign",
              entityType: "workflow",
              entityId: params.id,
              metadata: { secretIds: secrets.map((secret) => secret.id) },
            });
            return {
              secretIds: await getWorkflowSecretAssignments(organizationId, params.id),
              secrets,
            };
          },
        );
        return yield* respond(WorkflowSecretAssignment)(assignment);
      }),
    )
    .handle("getSchedule", ({ params }) =>
      Effect.gen(function* () {
        const wf = yield* load(params.id);
        return yield* respond(WorkflowScheduleResponse)({ schedule: workflowScheduleView(wf) });
      }),
    )
    .handleRaw("setSchedule", ({ params, request }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        const body = yield* readJsonOr(request, null);
        const fields = Predicate.isObject(body) ? body : undefined;
        const expression = fields?.["expression"];
        if (!fields || !Predicate.isString(expression)) {
          return yield* badRequest("Body must be JSON with an `expression` string.");
        }
        // Validate the optional fields too, or a non-boolean `enabled` reaches
        // the column while `computeSchedule` reads it as truthy (a disabled
        // workflow with a live `next_run_at`).
        const enabled = fields["enabled"];
        if (enabled !== undefined && !Predicate.isBoolean(enabled)) {
          return yield* badRequest("`enabled` must be a boolean.");
        }
        const timezone = fields["timezone"];
        if (timezone !== undefined && timezone !== null && !Predicate.isString(timezone)) {
          return yield* badRequest("`timezone` must be a string or null.");
        }
        yield* requireSecretsReadIfAssigned(params.id);
        const wf = yield* refusalCall(workflowRefusal, { 400: refuse[400], 404: refuse[404] }, () =>
          setWorkflowSchedule(
            organizationId,
            params.id,
            {
              expression,
              ...(timezone !== undefined ? { timezone } : {}),
              ...(enabled !== undefined ? { enabled } : {}),
            },
            session.userId,
          ),
        );
        return yield* respond(WorkflowScheduleResponse)({ schedule: workflowScheduleView(wf) });
      }),
    )
    .handle("clearSchedule", ({ params }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        yield* refusalCall(workflowRefusal, { 400: refuse[400], 404: refuse[404] }, () =>
          clearWorkflowSchedule(organizationId, params.id, session.userId),
        );
        return ok;
      }),
    )
    .handle("typings", ({ params, query }) =>
      Effect.gen(function* () {
        yield* requirePermission("secrets:read");
        const { organizationId } = yield* OrgPrincipal;
        const wf = yield* load(params.id);
        const enrich = query.enrich === "1" || query.enrich === "true";
        const dts = yield* legacy(async () => {
          const assignedSecrets = await listAssignedWorkflowSecrets(organizationId, wf.id);
          return generateWorkflowTypings(organizationId, {
            ...typingContext(wf),
            secrets: assignedSecrets.map((secret) => ({ key: secret.id, name: secret.name })),
            enrichCreateFields: enrich,
          });
        });
        return yield* respond(WorkflowTypingsResponse)({ dts });
      }),
    )
    .handleRaw("check", ({ params, request }) =>
      Effect.gen(function* () {
        yield* requirePermission("secrets:read");
        const { organizationId } = yield* OrgPrincipal;
        const wf = yield* load(params.id);
        const { source } = yield* fieldsOf(yield* readJsonOr(request, {}));
        const result = yield* legacy(async () => {
          const assignedSecrets = await listAssignedWorkflowSecrets(organizationId, wf.id);
          return checkWorkflowSource(
            organizationId,
            Predicate.isString(source) ? source : wf.source,
            {
              ...typingContext(wf),
              secrets: assignedSecrets.map((secret) => ({ key: secret.id, name: secret.name })),
            },
          );
        });
        return yield* sendAsIs(result);
      }),
    )
    .handle("run", ({ params }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        const wf = yield* load(params.id);
        // The sandbox acts with this user's permissions, so `workflows:write`
        // buys the right to start a run and nothing more. Refuse rather than
        // omit when there is no user: omitting `runAsUserId` silently falls
        // back to the workflow's author, the exact shape of the bug this gate
        // exists to close.
        const runAsUserId = session.userId;
        if (!runAsUserId) return yield* new Unauthorized({ error: "Unauthorized" });
        const run = yield* legacy(() =>
          runWorkflowById({
            organizationId,
            workflowId: wf.id,
            triggerSource: "manual",
            runAsUserId,
            // HTTP runs are non-interactive; interactive prompting uses the websocket.
            interactive: false,
          }),
        );
        return yield* sendAsIs({ runId: run.runId, result: run.result });
      }),
    )
    .handle("runs", ({ params }) =>
      Effect.gen(function* () {
        const wf = yield* load(params.id);
        return yield* sendAsIs(yield* legacy(() => listWorkflowRuns(wf.id)));
      }),
    )
    .handle("metrics", ({ params }) =>
      Effect.gen(function* () {
        const wf = yield* load(params.id);
        return yield* sendAsIs(yield* legacy(() => listWorkflowMetrics(wf.id)));
      }),
    ),
);

export const workflowsDomain = makeDomain("workflows", WorkflowsApi, WorkflowsHandlers);

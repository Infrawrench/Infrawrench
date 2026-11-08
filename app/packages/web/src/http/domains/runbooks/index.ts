/**
 * Runbooks: `/api/org/:orgId/runbooks`, the handlers.
 *
 * A `workflow` step does not run the workflow here. It records which workflow
 * run the responder started, and the run itself goes through the workflow
 * routes with their own permission, approvals and secrets; anything else would
 * make this a second way to execute code with a weaker gate than the first.
 *
 * Bodies are shape-checked here and content-checked by `validateRunbookInput`
 * in the store, so the message a user sees about a missing workflow id comes
 * from the same function the editor previews with.
 */
import { Effect, Predicate, Schema } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import type { RunbookInput, RunbookStepInput } from "@infrawrench/client-core";
import {
  RunbookInputError,
  createRunbook,
  deleteRunbook,
  getRunbook,
  listRunbooks,
  updateRunbook,
} from "@infrawrench/server-core/runbooks/store";
import {
  closeRunbookRun,
  getRunbookRun,
  listRunbookRuns,
  startRunbookRun,
  updateRunbookRunStep,
} from "@infrawrench/server-core/runbooks/runs";
import { logAudit } from "../../../services/audit";
import { makeDomain } from "../../domain";
import { notFound } from "../../errors";
import { fireAndForget, legacy, legacyTry } from "../../legacy";
import { inputRefusal, invalidBody, readObjectBody } from "../../object-body";
import { OrgPrincipal } from "../../principal";
import { respond } from "../../response";
import {
  RUNBOOK_STEP_STATUSES,
  Runbook,
  RunbookList,
  RunbookRun,
  RunbookRunList,
  RunbooksApi,
  RunbookStepStatus,
} from "./api";

type Body = { readonly [key: string]: unknown };
type Read<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: string };

const isStepStatus = Schema.is(RunbookStepStatus);
const isStepKind = Schema.is(Schema.Literals(["manual", "workflow", "link"]));

function readNullableString(body: Body, key: string): Read<string | null | undefined> {
  if (!(key in body)) return { ok: true, value: undefined };
  const raw = body[key];
  if (raw === null) return { ok: true, value: null };
  if (!Predicate.isString(raw)) return { ok: false, error: `${key} must be a string or null` };
  return { ok: true, value: raw };
}

function readSteps(body: Body): Read<RunbookStepInput[] | undefined> {
  if (!("steps" in body)) return { ok: true, value: undefined };
  const raw = body["steps"];
  if (!Array.isArray(raw)) return { ok: false, error: "steps must be an array" };
  const steps: RunbookStepInput[] = [];
  for (const step of raw) {
    if (!Predicate.isObject(step) || Array.isArray(step)) {
      return { ok: false, error: "Each step must be an object" };
    }
    const kind = step["kind"];
    if (!isStepKind(kind)) {
      return { ok: false, error: "Each step's kind must be manual, workflow or link" };
    }
    const title = step["title"];
    if (!Predicate.isString(title)) return { ok: false, error: "Each step needs a title" };
    const id = step["id"];
    const stepBody = step["body"];
    const workflowId = step["workflowId"];
    const url = step["url"];
    steps.push({
      ...(Predicate.isString(id) ? { id } : {}),
      kind,
      title,
      ...(Predicate.isString(stepBody) ? { body: stepBody } : {}),
      ...(Predicate.isString(workflowId) ? { workflowId } : {}),
      ...(Predicate.isString(url) ? { url } : {}),
    });
  }
  return { ok: true, value: steps };
}

function readRunbookBody(body: Body): Read<Partial<RunbookInput>> {
  const name = body["name"];
  if (name !== undefined && !Predicate.isString(name)) {
    return { ok: false, error: "name must be a string" };
  }
  const description = readNullableString(body, "description");
  if (!description.ok) return description;
  const tagKey = readNullableString(body, "tagKey");
  if (!tagKey.ok) return tagKey;
  const tagValue = readNullableString(body, "tagValue");
  if (!tagValue.ok) return tagValue;
  const steps = readSteps(body);
  if (!steps.ok) return steps;

  let resourceTypeIds: string[] | undefined;
  if ("resourceTypeIds" in body) {
    const raw = body["resourceTypeIds"];
    if (!Array.isArray(raw) || !raw.every(Predicate.isString)) {
      return { ok: false, error: "resourceTypeIds must be an array of strings" };
    }
    resourceTypeIds = raw;
  }
  const enabled = body["enabled"];
  if (enabled !== undefined && !Predicate.isBoolean(enabled)) {
    return { ok: false, error: "enabled must be a boolean" };
  }

  return {
    ok: true,
    value: {
      ...(name !== undefined ? { name } : {}),
      ...(description.value !== undefined ? { description: description.value } : {}),
      ...(steps.value !== undefined ? { steps: steps.value } : {}),
      ...(resourceTypeIds !== undefined ? { resourceTypeIds } : {}),
      ...(tagKey.value !== undefined ? { tagKey: tagKey.value } : {}),
      ...(tagValue.value !== undefined ? { tagValue: tagValue.value } : {}),
      ...(enabled !== undefined ? { enabled } : {}),
    },
  };
}

const storeRefusal = (error: unknown) =>
  error instanceof RunbookInputError ? inputRefusal(error) : undefined;

const RunbooksHandlers = HttpApiBuilder.group(RunbooksApi, "runbooks", (handlers) =>
  handlers
    .handle("list", () =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const runbooks = yield* legacy(() => listRunbooks(organizationId));
        return yield* respond(RunbookList)({ runbooks });
      }),
    )
    .handle("listRuns", ({ query }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const { runbookId, incidentId, limit } = query;
        const runs = yield* legacy(() =>
          listRunbookRuns(organizationId, {
            ...(runbookId ? { runbookId } : {}),
            ...(incidentId ? { incidentId } : {}),
            ...(limit !== undefined ? { limit } : {}),
          }),
        );
        return yield* respond(RunbookRunList)({ runs });
      }),
    )
    .handle("getRun", ({ params }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const run = yield* legacy(() => getRunbookRun(organizationId, params.runId));
        if (!run) return yield* notFound("No such runbook run");
        return yield* respond(RunbookRun)(run);
      }),
    )
    .handleRaw("tickStep", ({ params, request }) =>
      Effect.gen(function* () {
        const parsed = yield* readObjectBody(request);
        if (!parsed.ok) return yield* invalidBody(parsed.error);
        const status = parsed.body["status"];
        if (!isStepStatus(status)) {
          return yield* invalidBody(`status must be one of ${RUNBOOK_STEP_STATUSES.join(", ")}`);
        }
        const note = readNullableString(parsed.body, "note");
        if (!note.ok) return yield* invalidBody(note.error);
        const workflowRunId = readNullableString(parsed.body, "workflowRunId");
        if (!workflowRunId.ok) return yield* invalidBody(workflowRunId.error);

        const { organizationId, session } = yield* OrgPrincipal;
        const run = yield* legacyTry(
          () =>
            updateRunbookRunStep({
              organizationId,
              runId: params.runId,
              stepId: params.stepId,
              status,
              ...(note.value !== undefined ? { note: note.value } : {}),
              ...(workflowRunId.value !== undefined ? { workflowRunId: workflowRunId.value } : {}),
              userId: session.userId ?? null,
            }),
          storeRefusal,
        );
        return yield* respond(RunbookRun)(run);
      }),
    )
    .handleRaw("closeRun", ({ params, request }) =>
      Effect.gen(function* () {
        const parsed = yield* readObjectBody(request);
        if (!parsed.ok) return yield* invalidBody(parsed.error);
        const status = parsed.body["status"];
        if (status !== "completed" && status !== "abandoned") {
          return yield* invalidBody("status must be completed or abandoned");
        }
        const summary = readNullableString(parsed.body, "summary");
        if (!summary.ok) return yield* invalidBody(summary.error);

        const { organizationId, session } = yield* OrgPrincipal;
        const run = yield* legacyTry(
          () =>
            closeRunbookRun({
              organizationId,
              runId: params.runId,
              status,
              ...(summary.value !== undefined ? { summary: summary.value } : {}),
            }),
          storeRefusal,
        );
        yield* fireAndForget(() =>
          logAudit({
            organizationId,
            userId: session.userId,
            action: "runbook_run.close",
            entityType: "runbook_run",
            entityId: run.id,
            metadata: { runbook: run.runbookName, status: run.status },
          }),
        );
        return yield* respond(RunbookRun)(run);
      }),
    )
    .handle("get", ({ params }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const runbook = yield* legacy(() => getRunbook(organizationId, params.runbookId));
        if (!runbook) return yield* notFound("No such runbook");
        return yield* respond(Runbook)(runbook);
      }),
    )
    // The body is optional: an `incidentId` string attaches the run to that
    // incident, and anything else (no body, bad JSON) starts an unattached run.
    .handleRaw("startRun", ({ params, request }) =>
      Effect.gen(function* () {
        const parsed = yield* readObjectBody(request);
        const raw = parsed.ok ? parsed.body["incidentId"] : undefined;
        const incidentId = Predicate.isString(raw) ? raw : null;

        const { organizationId, session } = yield* OrgPrincipal;
        const run = yield* legacyTry(
          () =>
            startRunbookRun({
              organizationId,
              runbookId: params.runbookId,
              userId: session.userId ?? null,
              incidentId,
            }),
          storeRefusal,
        );
        yield* fireAndForget(() =>
          logAudit({
            organizationId,
            userId: session.userId,
            action: "runbook_run.start",
            entityType: "runbook_run",
            entityId: run.id,
            metadata: { runbook: run.runbookName, incidentId: run.incidentId },
          }),
        );
        return yield* respond(RunbookRun)(run);
      }),
    )
    .handleRaw("create", ({ request }) =>
      Effect.gen(function* () {
        const parsed = yield* readObjectBody(request);
        if (!parsed.ok) return yield* invalidBody(parsed.error);
        const fields = readRunbookBody(parsed.body);
        if (!fields.ok) return yield* invalidBody(fields.error);
        const name = fields.value.name;
        if (!Predicate.isString(name)) return yield* invalidBody("name is required");

        const { organizationId, session } = yield* OrgPrincipal;
        const runbook = yield* legacyTry(
          () => createRunbook(organizationId, { ...fields.value, name }, session.userId ?? null),
          storeRefusal,
        );
        yield* fireAndForget(() =>
          logAudit({
            organizationId,
            userId: session.userId,
            action: "runbook.create",
            entityType: "runbook",
            entityId: runbook.id,
            metadata: { name: runbook.name, steps: runbook.steps.length },
          }),
        );
        return yield* respond(Runbook)(runbook);
      }),
    )
    .handleRaw("update", ({ params, request }) =>
      Effect.gen(function* () {
        const parsed = yield* readObjectBody(request);
        if (!parsed.ok) return yield* invalidBody(parsed.error);
        const fields = readRunbookBody(parsed.body);
        if (!fields.ok) return yield* invalidBody(fields.error);
        if (Object.keys(fields.value).length === 0)
          return yield* invalidBody("No changes supplied");

        const { organizationId, session } = yield* OrgPrincipal;
        const runbook = yield* legacyTry(
          () => updateRunbook(organizationId, params.runbookId, fields.value),
          storeRefusal,
        );
        yield* fireAndForget(() =>
          logAudit({
            organizationId,
            userId: session.userId,
            action: "runbook.update",
            entityType: "runbook",
            entityId: runbook.id,
            metadata: { name: runbook.name, steps: runbook.steps.length, enabled: runbook.enabled },
          }),
        );
        return yield* respond(Runbook)(runbook);
      }),
    )
    .handle("delete", ({ params }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        const removed = yield* legacy(() => deleteRunbook(organizationId, params.runbookId));
        if (!removed) return yield* notFound("No such runbook");
        yield* fireAndForget(() =>
          logAudit({
            organizationId,
            userId: session.userId,
            action: "runbook.delete",
            entityType: "runbook",
            entityId: params.runbookId,
          }),
        );
      }),
    ),
);

export const runbooksDomain = makeDomain("runbooks", RunbooksApi, RunbooksHandlers);

/**
 * Reusable workflow secrets: `/api/org/:orgId/workflow-secrets`, the handlers.
 * Bodies are read raw and checked field by field, as the routes did; the
 * plaintext value goes to the store and never into a response or an audit row.
 */
import { Effect, Predicate, Schema } from "effect";
import type { HttpServerRequest } from "effect/http";
import { HttpApiBuilder } from "effect/http-api";
import { logAudit } from "../../../services/audit";
import {
  WorkflowSecretError,
  createWorkflowSecret,
  deleteWorkflowSecret,
  listWorkflowSecrets,
  updateWorkflowSecretMetadata,
  writeWorkflowSecretValue,
} from "../../../services/workflow-secrets";
import { makeDomain } from "../../domain";
import { badRequest } from "../../errors";
import { readJsonOr } from "../../json-body";
import { fireAndForget, legacy } from "../../legacy";
import { OrgPrincipal } from "../../principal";
import { respond } from "../../response";
import { ok } from "../../schemas/common";
import { WorkflowSecret } from "../../schemas/workflow-secrets";
import { refuse, statusCall, type ReadRefusal } from "../status-refusals";
import { WorkflowSecretsApi } from "./api";

const secretRefusal: ReadRefusal = (error) =>
  error instanceof WorkflowSecretError ? error : undefined;

/**
 * The body's fields, as `(await c.req.json().catch(() => null))` left them:
 * a body that is absent, not JSON or not an object has none.
 */
const bodyFields = (request: HttpServerRequest.HttpServerRequest) =>
  readJsonOr(request, null).pipe(
    Effect.map((body): { readonly [key: string]: unknown } =>
      Predicate.isObject(body) ? body : {},
    ),
  );

/** `description` as the routes accepted it: absent, a string, or null. */
const isDescription = (value: unknown): value is string | null | undefined =>
  value === undefined || value === null || Predicate.isString(value);

const WorkflowSecretsHandlers = HttpApiBuilder.group(
  WorkflowSecretsApi,
  "workflowSecrets",
  (handlers) =>
    handlers
      .handle("list", () =>
        Effect.gen(function* () {
          const { organizationId } = yield* OrgPrincipal;
          const secrets = yield* legacy(() => listWorkflowSecrets(organizationId));
          return yield* respond(Schema.Array(WorkflowSecret))(secrets);
        }),
      )
      .handleRaw("create", ({ request }) =>
        Effect.gen(function* () {
          const { organizationId, session } = yield* OrgPrincipal;
          const { name, description } = yield* bodyFields(request);
          if (!Predicate.isString(name)) {
            return yield* badRequest("Body must include a name string.");
          }
          if (!isDescription(description)) {
            return yield* badRequest("description must be a string or null.");
          }
          const secret = yield* statusCall(
            secretRefusal,
            { 400: refuse[400], 409: refuse[409] },
            () =>
              createWorkflowSecret(organizationId, {
                name,
                ...(description !== undefined ? { description } : {}),
              }),
          );
          yield* fireAndForget(() =>
            logAudit({
              organizationId,
              userId: session.userId,
              action: "workflow_secret.create",
              entityType: "workflow_secret",
              entityId: secret.id,
              metadata: { name: secret.name },
            }),
          );
          return yield* respond(WorkflowSecret, { status: 201 })(secret);
        }),
      )
      .handleRaw("update", ({ params, request }) =>
        Effect.gen(function* () {
          const { organizationId, session } = yield* OrgPrincipal;
          const { name, description } = yield* bodyFields(request);
          if (name === undefined && description === undefined) {
            return yield* badRequest("Body must include name or description.");
          }
          if (name !== undefined && !Predicate.isString(name)) {
            return yield* badRequest("name must be a string.");
          }
          if (!isDescription(description)) {
            return yield* badRequest("description must be a string or null.");
          }
          const secret = yield* statusCall(
            secretRefusal,
            { 400: refuse[400], 404: refuse[404], 409: refuse[409] },
            () =>
              updateWorkflowSecretMetadata(organizationId, params.id, {
                ...(name !== undefined ? { name } : {}),
                ...(description !== undefined ? { description } : {}),
              }),
          );
          yield* fireAndForget(() =>
            logAudit({
              organizationId,
              userId: session.userId,
              action: "workflow_secret.update",
              entityType: "workflow_secret",
              entityId: secret.id,
              metadata: { name: secret.name, hasValue: secret.hasValue },
            }),
          );
          return yield* respond(WorkflowSecret)(secret);
        }),
      )
      .handleRaw("writeValue", ({ params, request }) =>
        Effect.gen(function* () {
          const { organizationId, session } = yield* OrgPrincipal;
          const { value } = yield* bodyFields(request);
          if (!Predicate.isString(value)) {
            return yield* badRequest("Body must include a value string.");
          }
          const secret = yield* statusCall(
            secretRefusal,
            { 400: refuse[400], 404: refuse[404] },
            () => writeWorkflowSecretValue(organizationId, params.id, value),
          );
          yield* fireAndForget(() =>
            logAudit({
              organizationId,
              userId: session.userId,
              action: "workflow_secret.value_write",
              entityType: "workflow_secret",
              entityId: secret.id,
              metadata: { name: secret.name },
            }),
          );
          return yield* respond(WorkflowSecret)(secret);
        }),
      )
      .handle("delete", ({ params }) =>
        Effect.gen(function* () {
          const { organizationId, session } = yield* OrgPrincipal;
          const secret = yield* statusCall(secretRefusal, { 404: refuse[404] }, () =>
            deleteWorkflowSecret(organizationId, params.id),
          );
          yield* fireAndForget(() =>
            logAudit({
              organizationId,
              userId: session.userId,
              action: "workflow_secret.delete",
              entityType: "workflow_secret",
              entityId: secret.id,
              metadata: { name: secret.name, hadValue: secret.hasValue },
            }),
          );
          return ok;
        }),
      ),
);

export const workflowSecretsDomain = makeDomain(
  "workflow-secrets",
  WorkflowSecretsApi,
  WorkflowSecretsHandlers,
);

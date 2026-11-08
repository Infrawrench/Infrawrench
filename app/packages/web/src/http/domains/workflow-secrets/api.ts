/**
 * Reusable workflow secrets: `/api/org/:orgId/workflow-secrets`, the endpoint
 * definitions.
 *
 * The bodies are documented here and read raw by the handlers, which answer
 * a missing or mistyped field with their own sentence, as they always have.
 * The value is write-only: nothing here ever returns it.
 */
import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/http-api";
import { maxLength, minLength } from "@infrawrench/ui/schemas";
import { RequiredPermission, SuccessDescription } from "../../annotations";
import { withApiDefaults } from "../../domain";
import { BadRequest, Conflict, NotFound } from "../../errors";
import { OrgAuth } from "../../middleware-tags";
import { Ok, OrgId, OrgParams, Uuid } from "../../schemas/common";
import { WorkflowSecret, WorkflowSecretName } from "../../schemas/workflow-secrets";

const SecretParams = {
  orgId: OrgId,
  id: Uuid.annotate({ description: "Workflow secret id" }),
} as const;

const WorkflowSecretCreate = Schema.Struct({
  name: WorkflowSecretName,
  description: Schema.optionalKey(Schema.NullOr(Schema.String)),
}).annotate({ identifier: "WorkflowSecretCreate" });

const WorkflowSecretUpdate = Schema.Struct({
  name: Schema.optionalKey(WorkflowSecretName),
  description: Schema.optionalKey(Schema.NullOr(Schema.String)),
}).annotate({ identifier: "WorkflowSecretUpdate" });

export const WorkflowSecretValueWrite = Schema.Struct({
  value: Schema.String.check(minLength(1), maxLength(1024 * 1024)).annotate({
    description:
      "Write-only plaintext. It is AES-256-GCM encrypted before storage and is never returned.",
  }),
}).annotate({ identifier: "WorkflowSecretValueWrite" });

export class WorkflowSecretsGroup extends HttpApiGroup.make("workflowSecrets")
  .add(
    HttpApiEndpoint.get("list", "/", {
      params: OrgParams,
      success: Schema.Array(WorkflowSecret),
    })
      .annotate(RequiredPermission, "secrets:read")
      .annotate(OpenApi.Summary, "List reusable workflow secrets")
      .annotate(
        OpenApi.Description,
        "Returns metadata and hasValue only; plaintext values are never returned.",
      )
      .annotate(SuccessDescription, "Workflow secret metadata"),
    HttpApiEndpoint.post("create", "/", {
      params: OrgParams,
      payload: WorkflowSecretCreate,
      success: WorkflowSecret.pipe(HttpApiSchema.status(201)),
      error: [BadRequest, Conflict],
    })
      .annotate(RequiredPermission, "secrets:write")
      .annotate(OpenApi.Summary, "Create workflow secret metadata")
      .annotate(
        OpenApi.Description,
        "Creates metadata without a value. Write the value separately through the write-only value endpoint.",
      )
      .annotate(SuccessDescription, "Created metadata"),
    HttpApiEndpoint.patch("update", "/:id", {
      params: SecretParams,
      payload: WorkflowSecretUpdate,
      success: WorkflowSecret,
      error: [BadRequest, NotFound, Conflict],
    })
      .annotate(RequiredPermission, "secrets:write")
      .annotate(OpenApi.Summary, "Update workflow secret metadata")
      .annotate(SuccessDescription, "Updated metadata"),
    HttpApiEndpoint.put("writeValue", "/:id/value", {
      params: SecretParams,
      payload: WorkflowSecretValueWrite,
      success: WorkflowSecret,
      error: [BadRequest, NotFound],
    })
      .annotate(RequiredPermission, "secrets:write")
      .annotate(OpenApi.Summary, "Write a workflow secret value")
      .annotate(
        OpenApi.Description,
        "Write-only. The response contains metadata and hasValue, never the supplied plaintext.",
      )
      .annotate(SuccessDescription, "Metadata after the value write"),
    HttpApiEndpoint.delete("delete", "/:id", {
      params: SecretParams,
      success: Ok,
      error: NotFound,
    })
      .annotate(RequiredPermission, "secrets:write")
      .annotate(OpenApi.Summary, "Delete a workflow secret")
      .annotate(
        OpenApi.Description,
        "Also removes every workflow assignment through database cascades.",
      )
      .annotate(SuccessDescription, "Deleted"),
  )
  .prefix("/api/org/:orgId/workflow-secrets")
  .middleware(OrgAuth)
  .annotate(OpenApi.Title, "Workflows") {}

export class WorkflowSecretsApi extends withApiDefaults(
  HttpApi.make("workflowSecrets").add(WorkflowSecretsGroup),
) {}

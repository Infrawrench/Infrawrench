import { z } from "../zod";
import { strict, ErrorResponses, Ok, OrgIdParam, Uuid, IsoDateTime } from "../common";
import type { BuildContext } from "../context";

const WorkflowSecretName = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[$A-Z_a-z][$\w]*(?:\.[$A-Z_a-z][$\w]*)*$/)
  .openapi({
    description:
      "JavaScript dot identifier used to expose the value to workflow code, for example `API_TOKEN` or `stripe.apiKey`.",
  });

const WorkflowSecret = strict({
  id: Uuid,
  name: WorkflowSecretName,
  description: z.string().nullable(),
  hasValue: z.boolean().openapi({
    description: "Whether an encrypted value is stored. The value is never returned.",
  }),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
}).openapi("WorkflowSecret");

const WorkflowSecretCreate = strict({
  name: WorkflowSecretName,
  description: z.string().nullable().optional(),
}).openapi("WorkflowSecretCreate");

const WorkflowSecretUpdate = strict({
  name: WorkflowSecretName.optional(),
  description: z.string().nullable().optional(),
}).openapi("WorkflowSecretUpdate");

const WorkflowSecretValueWrite = strict({
  value: z
    .string()
    .min(1)
    .max(1024 * 1024)
    .openapi({
      description:
        "Write-only plaintext. It is AES-256-GCM encrypted before storage and is never returned.",
    }),
}).openapi("WorkflowSecretValueWrite");

const WorkflowSecretAssignment = strict({
  secretIds: z.array(Uuid),
  secrets: z.array(WorkflowSecret),
}).openapi("WorkflowSecretAssignment");

const WorkflowSecretAssignmentInput = strict({
  secretIds: z.array(Uuid),
}).openapi("WorkflowSecretAssignmentInput");

const ChatSecretRequestResult = strict({
  ok: z.literal(true),
  allResolved: z.boolean(),
}).openapi("ChatSecretRequestResult");

export function registerWorkflowSecretPaths(ctx: BuildContext) {
  const { registry } = ctx;
  const secretParams = () =>
    OrgIdParam.extend({
      id: Uuid.openapi({ param: { name: "id", in: "path" }, description: "Workflow secret id" }),
    });
  const workflowParams = () =>
    OrgIdParam.extend({
      id: Uuid.openapi({ param: { name: "id", in: "path" }, description: "Workflow id" }),
    });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/workflow-secrets",
    tags: ["Workflows"],
    summary: "List reusable workflow secrets",
    description: "Returns metadata and hasValue only; plaintext values are never returned.",
    request: { params: OrgIdParam },
    responses: {
      200: {
        description: "Workflow secret metadata",
        content: { "application/json": { schema: z.array(WorkflowSecret) } },
      },
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/workflow-secrets",
    tags: ["Workflows"],
    summary: "Create workflow secret metadata",
    description:
      "Creates metadata without a value. Write the value separately through the write-only value endpoint.",
    request: {
      params: OrgIdParam,
      body: {
        required: true,
        content: { "application/json": { schema: WorkflowSecretCreate } },
      },
    },
    responses: {
      201: {
        description: "Created metadata",
        content: { "application/json": { schema: WorkflowSecret } },
      },
      400: ErrorResponses[400],
      409: ErrorResponses[409],
    },
  });

  registry.registerPath({
    method: "patch",
    path: "/api/org/{orgId}/workflow-secrets/{id}",
    tags: ["Workflows"],
    summary: "Update workflow secret metadata",
    request: {
      params: secretParams(),
      body: {
        required: true,
        content: { "application/json": { schema: WorkflowSecretUpdate } },
      },
    },
    responses: {
      200: {
        description: "Updated metadata",
        content: { "application/json": { schema: WorkflowSecret } },
      },
      400: ErrorResponses[400],
      404: ErrorResponses[404],
      409: ErrorResponses[409],
    },
  });

  registry.registerPath({
    method: "put",
    path: "/api/org/{orgId}/workflow-secrets/{id}/value",
    tags: ["Workflows"],
    summary: "Write a workflow secret value",
    description:
      "Write-only. The response contains metadata and hasValue, never the supplied plaintext.",
    request: {
      params: secretParams(),
      body: {
        required: true,
        content: { "application/json": { schema: WorkflowSecretValueWrite } },
      },
    },
    responses: {
      200: {
        description: "Metadata after the value write",
        content: { "application/json": { schema: WorkflowSecret } },
      },
      400: ErrorResponses[400],
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "delete",
    path: "/api/org/{orgId}/workflow-secrets/{id}",
    tags: ["Workflows"],
    summary: "Delete a workflow secret",
    description: "Also removes every workflow assignment through database cascades.",
    request: { params: secretParams() },
    responses: {
      200: { description: "Deleted", content: { "application/json": { schema: Ok } } },
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/workflows/{id}/secrets",
    tags: ["Workflows"],
    summary: "List a workflow's assigned secrets",
    description: "Returns assigned ids and metadata only, never values.",
    request: { params: workflowParams() },
    responses: {
      200: {
        description: "Assigned secret metadata",
        content: { "application/json": { schema: WorkflowSecretAssignment } },
      },
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "put",
    path: "/api/org/{orgId}/workflows/{id}/secrets",
    tags: ["Workflows"],
    summary: "Replace a workflow's secret assignments",
    request: {
      params: workflowParams(),
      body: {
        required: true,
        content: { "application/json": { schema: WorkflowSecretAssignmentInput } },
      },
    },
    responses: {
      200: {
        description: "Assigned secret metadata",
        content: { "application/json": { schema: WorkflowSecretAssignment } },
      },
      400: ErrorResponses[400],
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/chat/conversations/{conversationId}/secret-requests/{requestId}",
    tags: ["Chat"],
    summary: "Submit a requested workflow secret",
    description:
      "Human-only, write-only handoff from the chat password field to encrypted workflow-secret storage. The value is never returned or added to chat history.",
    request: {
      params: OrgIdParam.extend({
        conversationId: Uuid.openapi({
          param: { name: "conversationId", in: "path" },
          description: "Chat conversation id",
        }),
        requestId: Uuid.openapi({
          param: { name: "requestId", in: "path" },
          description: "Pending secret request id",
        }),
      }),
      body: {
        required: true,
        content: { "application/json": { schema: WorkflowSecretValueWrite } },
      },
    },
    responses: {
      200: {
        description: "Stored without returning the value",
        content: { "application/json": { schema: ChatSecretRequestResult } },
      },
      400: ErrorResponses[400],
      403: ErrorResponses[403],
      404: ErrorResponses[404],
      409: ErrorResponses[409],
    },
  });
}

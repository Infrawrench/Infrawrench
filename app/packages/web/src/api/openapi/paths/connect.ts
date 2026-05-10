import { z } from "../zod";
import { strict, ErrorResponses, Uuid, Ok, OrgIdParam, ResourceId } from "../common";
import type { BuildContext } from "../index";

const TemplatesRequest = strict({
  sourcePluginId: z.string(),
  sourceResourceTypeId: z.string(),
  targetAccountId: Uuid,
  targetPluginId: z.string(),
}).openapi("ConnectTemplatesRequest");

const SecretExportTemplate = strict({
  id: z.string(),
  label: z.string(),
  description: z.string().optional(),
  entries: z.array(strict({ outputKey: z.string(), envKey: z.string() })),
}).openapi("SecretExportTemplate");

const TemplatesResponse = strict({
  templates: z.array(SecretExportTemplate),
  effectiveResourceTypeId: z.string(),
  supportsSecretImport: z.boolean(),
  namespaces: z.array(z.string()),
}).openapi("ConnectTemplatesResponse");

const SecretExportRequest = strict({
  sourceAccountId: Uuid,
  sourceResourceId: ResourceId,
  sourcePluginId: z.string(),
  sourceResourceTypeId: z.string(),
  sourceExternalId: z.string().optional(),
  targetAccountId: Uuid,
  targetPluginId: z.string(),
  templateId: z.string(),
  namespace: z.string(),
  secretName: z.string(),
  keyOverrides: z.record(z.string()),
}).openapi("ConnectSecretExportRequest");

const EnvDeployRequest = strict({
  sourceAccountId: Uuid,
  sourceResourceId: ResourceId,
  sourcePluginId: z.string(),
  sourceResourceTypeId: z.string(),
  sourceExternalId: z.string().optional(),
  targetSshHost: z.string(),
  sshKeyId: Uuid,
  sshUsername: z.string(),
  templateId: z.string(),
  keyOverrides: z.record(z.string()),
  format: z.enum(["dotenv", "profile"]),
  filePath: z.string(),
  append: z.boolean(),
}).openapi("ConnectEnvDeployRequest");

export function registerConnectPaths(ctx: BuildContext) {
  const { registry } = ctx;

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/connect/templates",
    tags: ["Connect"],
    summary: "List secret-export templates and target capabilities",
    request: {
      params: OrgIdParam,
      body: { content: { "application/json": { schema: TemplatesRequest } }, required: true },
    },
    responses: {
      200: {
        description: "Templates",
        content: { "application/json": { schema: TemplatesResponse } },
      },
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/connect/secret-export",
    tags: ["Connect"],
    summary: "Materialize source outputs as a secret in the target (e.g. K8s)",
    request: {
      params: OrgIdParam,
      body: { content: { "application/json": { schema: SecretExportRequest } }, required: true },
    },
    responses: {
      200: { description: "Created", content: { "application/json": { schema: Ok } } },
      400: ErrorResponses[400],
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/connect/env-deploy",
    tags: ["Connect"],
    summary: "Deploy env vars from a source resource to an SSH target",
    request: {
      params: OrgIdParam,
      body: { content: { "application/json": { schema: EnvDeployRequest } }, required: true },
    },
    responses: {
      200: { description: "Deployed", content: { "application/json": { schema: Ok } } },
      400: ErrorResponses[400],
      404: ErrorResponses[404],
    },
  });
}

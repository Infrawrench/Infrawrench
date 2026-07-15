import { z } from "../zod";
import { strict, ErrorResponses, OrgIdParam, IsoDateTime, JsonObject } from "../common";
import type { BuildContext } from "../context";

const Tool = z.enum(["codex", "claude-code"]);
const Status = z.enum(["pending", "provisioning", "setting-up", "up", "failed", "stopped"]);

const AgentVmAccount = strict({
  accountId: z.string(),
  accountName: z.string(),
  pluginId: z.string(),
  pluginName: z.string(),
  pluginLogoSvg: z.string().optional(),
  resourceTypeId: z.string(),
  resourceTypeName: z.string(),
  defaultUsername: z.string(),
  defaultFields: z.record(z.string()),
  defaultFieldLabels: z.record(z.string()).optional(),
  createFields: z.array(JsonObject).optional(),
  hiddenFieldKeys: z.array(z.string()),
}).openapi("AgentVmAccount");

const AgentSettings = strict({
  accountId: z.string(),
  pluginId: z.string(),
  resourceTypeId: z.string(),
  tool: Tool,
  fields: z.record(z.string()),
}).openapi("AgentSettings");

const AgentSession = strict({
  id: z.string(),
  repo: z.string(),
  projectName: z.string(),
  workspaceName: z.string(),
  accountId: z.string(),
  pluginId: z.string(),
  resourceTypeId: z.string(),
  tool: Tool,
  branchName: z.string(),
  status: Status,
  vmResourceId: z.string().nullable(),
  logs: z.array(z.string()),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
}).openapi("AgentSession");

const CreateAgentSession = strict({
  repo: z.string().min(1),
  projectName: z.string().optional(),
  workspaceName: z.string().optional(),
  settings: AgentSettings,
}).openapi("CreateAgentSession");

const SessionIdParam = OrgIdParam.extend({
  id: z.string().openapi({ param: { name: "id", in: "path" } }),
});

export function registerAgentPaths(ctx: BuildContext) {
  const { registry } = ctx;

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/agents/accounts",
    tags: ["Agents"],
    summary: "List accounts whose plugins can create agent VMs",
    request: { params: OrgIdParam },
    responses: {
      200: {
        description: "Accounts",
        content: { "application/json": { schema: z.array(AgentVmAccount) } },
      },
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/agents/settings",
    tags: ["Agents"],
    summary: "Get saved Agents defaults",
    request: { params: OrgIdParam },
    responses: {
      200: {
        description: "Settings",
        content: { "application/json": { schema: AgentSettings.nullable() } },
      },
    },
  });

  registry.registerPath({
    method: "put",
    path: "/api/org/{orgId}/agents/settings",
    tags: ["Agents"],
    summary: "Save Agents defaults",
    request: {
      params: OrgIdParam,
      body: { content: { "application/json": { schema: AgentSettings } }, required: true },
    },
    responses: {
      200: { description: "Settings", content: { "application/json": { schema: AgentSettings } } },
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/agents/sessions",
    tags: ["Agents"],
    summary: "List agent sessions",
    request: { params: OrgIdParam },
    responses: {
      200: {
        description: "Sessions",
        content: { "application/json": { schema: z.array(AgentSession) } },
      },
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/agents/sessions",
    tags: ["Agents"],
    summary: "Create an agent session",
    request: {
      params: OrgIdParam,
      body: { content: { "application/json": { schema: CreateAgentSession } }, required: true },
    },
    responses: {
      201: { description: "Created", content: { "application/json": { schema: AgentSession } } },
      400: ErrorResponses[400],
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/agents/sessions/{id}/open",
    tags: ["Agents"],
    summary: "Return the command and working directory for an agent session",
    request: { params: SessionIdParam },
    responses: {
      200: {
        description: "Open command",
        content: {
          "application/json": {
            schema: strict({
              command: z.string(),
              cwd: z.string(),
              sshKeyId: z.string().optional(),
              sshKeyName: z.string().optional(),
            }),
          },
        },
      },
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "delete",
    path: "/api/org/{orgId}/agents/sessions/{id}",
    tags: ["Agents"],
    summary: "Delete an agent session and destroy its VM",
    request: { params: SessionIdParam },
    responses: {
      200: {
        description: "Session deleted",
        content: { "application/json": { schema: strict({ ok: z.boolean() }) } },
      },
      404: ErrorResponses[404],
      502: {
        description: "The provider refused to delete the VM",
        content: { "application/json": { schema: strict({ error: z.string() }) } },
      },
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/agents/sessions/{id}/reconcile",
    tags: ["Agents"],
    summary: "Return reconciliation branch metadata",
    request: { params: SessionIdParam },
    responses: {
      200: {
        description: "Reconciliation metadata",
        content: {
          "application/json": { schema: strict({ branchName: z.string(), message: z.string() }) },
        },
      },
      404: ErrorResponses[404],
    },
  });
}

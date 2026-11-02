import { z } from "../zod";
import { strict, ErrorResponses, OrgIdParam, IsoDateTime, JsonObject } from "../common";
import type { BuildContext } from "../context";

const Tool = z.enum(["codex", "claude-code"]);
// How the session is driven. "terminal" attaches the tool's CLI in an SSH
// tab; "t3-code" runs the T3 Code server, which drives that same CLI and is
// used from T3 Code's own client. Orthogonal to `tool`: T3 Code is a
// control surface, not an agent. "nibblets" installs a Nibblets server (a
// host for long-running agents) whose installer signs agent CLIs in itself,
// so `tool` does not apply to it. Optional for clients predating it.
const Surface = z.enum(["terminal", "t3-code", "nibblets"]);
// How a T3 Code server is reached: T3's hosted relay ("t3-connect", the
// default) or Tailscale Serve on the tailnet ("tailscale", which needs an
// attached Tailscale service account).
const T3Access = z.enum(["t3-connect", "tailscale"]);
const ServiceAccountIds = z
  .array(z.string())
  .describe(
    "Accounts whose plugin installs a service on the VM over SSH after setup (e.g. Tailscale). See GET /resources/ssh-install/accounts.",
  );
const AgentServiceInstall = strict({
  accountId: z.string(),
  pluginId: z.string(),
  message: z.string(),
  address: z.string().optional(),
}).openapi("AgentServiceInstall");
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
  surface: Surface.optional(),
  fields: z.record(z.string()),
  serviceAccountIds: ServiceAccountIds.optional(),
  t3Access: T3Access.optional(),
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
  surface: Surface.optional(),
  serviceAccountIds: ServiceAccountIds.optional(),
  t3Access: T3Access.optional(),
  serviceInstalls: z.array(AgentServiceInstall).optional(),
  agentLinkId: z
    .string()
    .nullable()
    .optional()
    .openapi({
      description:
        "Nibblets sessions: the agent link that starts the server linked to this organization " +
        "(see Agent links). Revoked, with its agents, when the session is deleted.",
    }),
  branchName: z.string(),
  status: Status,
  vmResourceId: z.string().nullable(),
  logs: z.array(z.string()),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
}).openapi("AgentSession");

const CreateAgentSession = strict({
  // Required for terminal sessions; a "t3-code" session provisions a bare
  // server that manages its own projects, so it is omitted there.
  repo: z.string().optional(),
  projectName: z.string().optional(),
  workspaceName: z.string().optional(),
  settings: AgentSettings,
  nibbletsLink: strict({
    scopes: z.array(z.string()).min(1).openapi({ description: "The link's ceiling." }),
  })
    .optional()
    .openapi({
      description:
        "Nibblets sessions only: start the server linked to this organization through an agent " +
        "link you approve, as on the link approval page. Needs `team:invite`; `scopes` must be " +
        "within what you hold (no break-glass elevation) minus permissions no agent may hold. " +
        "Refused for API keys and agents.",
    }),
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
    method: "get",
    path: "/api/org/{orgId}/agents/link-scopes",
    tags: ["Agents"],
    summary: "What you could give a Nibblets session's agent link",
    description: "`scopes` is null when you cannot approve links here (no `team:invite`).",
    request: { params: OrgIdParam },
    responses: {
      200: {
        description: "Grantable scopes",
        content: {
          "application/json": {
            schema: strict({ scopes: z.array(z.string()).nullable() }).openapi(
              "AgentLinkableScopes",
            ),
          },
        },
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
      403: ErrorResponses[403],
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

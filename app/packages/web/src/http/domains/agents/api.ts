/**
 * Agents: `/api/org/:orgId/agents`, the endpoint definitions. Agent VMs
 * (Codex or Claude Code in a terminal, a T3 Code server, a Nibblets server)
 * provisioned on a connected account, their saved defaults, and the T3 Code
 * managed policy rolled out to them.
 *
 * The request bodies are documented, not decoded: the handlers read them raw,
 * as the Hono routes did (`index.ts`).
 */
import { Predicate, Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/http-api";
import { minLength } from "@infrawrench/ui/schemas";
import { RequiredPermission, SuccessDescription } from "../../annotations";
import { withApiDefaults } from "../../domain";
import { BadGateway, BadRequest, Forbidden, NotFound } from "../../errors";
import { OrgAuth } from "../../middleware-tags";
import { IsoDateTime, JsonObject, OrgId, OrgParams } from "../../schemas/common";

const StringMap = Schema.Record(Schema.String, Schema.String);

const Tool = Schema.Literals(["codex", "claude-code"]);
// How the session is driven. "terminal" attaches the tool's CLI in an SSH
// tab; "t3-code" runs the T3 Code server, which drives that same CLI and is
// used from T3 Code's own client. Orthogonal to `tool`: T3 Code is a control
// surface, not an agent. "nibblets" installs a Nibblets server (a host for
// long-running agents) whose installer signs agent CLIs in itself, so `tool`
// does not apply to it. Optional for clients predating it.
const Surface = Schema.Literals(["terminal", "t3-code", "nibblets"]);
// How a T3 Code server is reached: T3's hosted relay ("t3-connect", the
// default) or Tailscale Serve on the tailnet ("tailscale", which needs an
// attached Tailscale service account).
const T3Access = Schema.Literals(["t3-connect", "tailscale"]);
// T3 Code's managed policy document (upstream ManagedPolicyDocument,
// docs/user/managed-policy.md), installed at /etc/t3code/policy.json on the
// organization's T3 Code servers. Strict like T3 Code's own decoder: a key it
// does not know is a server that refuses to start.
const T3CodeRuntimeMode = Schema.Literals([
  "approval-required",
  "auto-accept-edits",
  "auto",
  "full-access",
]);

const T3CodePolicyProviderInstance = Schema.Struct({
  locked: Schema.Boolean,
  environment: Schema.optionalKey(
    Schema.Array(Schema.Struct({ name: Schema.String, value: Schema.String })),
  ),
  binaryPath: Schema.optionalKey(Schema.String),
  launchArgs: Schema.optionalKey(Schema.String),
}).annotate({ identifier: "T3CodePolicyProviderInstance" });

const T3CodePolicy = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  organization: Schema.String.annotate({
    description: 'Shown to users as "Managed by <organization>".',
  }),
  supportUrl: Schema.optionalKey(Schema.String),
  settings: Schema.optionalKey(
    Schema.Record(
      Schema.String,
      Schema.Struct({ value: Schema.optionalKey(Schema.Unknown), locked: Schema.Boolean }),
    ).annotate({
      description:
        "Keyed by the setting's dot path in T3 Code's settings.json. `locked: false` sets a default users can change; `locked: true` pins it.",
    }),
  ),
  limits: Schema.optionalKey(
    Schema.Struct({
      maxRuntimeMode: Schema.optionalKey(T3CodeRuntimeMode),
      clients: Schema.optionalKey(
        Schema.Array(Schema.Literals(["desktop", "local-browser", "remote"])).annotate({
          description: "Must include `remote`: agent VMs are only reachable remotely.",
        }),
      ),
      connect: Schema.optionalKey(Schema.Boolean),
      webhookTasks: Schema.optionalKey(Schema.Boolean),
      telemetry: Schema.optionalKey(Schema.Boolean),
      browserCookieImport: Schema.optionalKey(Schema.Boolean),
      providers: Schema.optionalKey(
        Schema.Struct({
          allowedDrivers: Schema.optionalKey(Schema.Array(Schema.String)),
          instances: Schema.optionalKey(Schema.Record(Schema.String, T3CodePolicyProviderInstance)),
        }),
      ),
      updates: Schema.optionalKey(
        Schema.Struct({
          mode: Schema.Literals(["auto", "off"]),
          feedUrl: Schema.optionalKey(Schema.String),
          allowNightly: Schema.optionalKey(Schema.Boolean),
        }),
      ),
    }),
  ),
}).annotate({ identifier: "T3CodePolicy" });

const ServiceAccountIds = Schema.Array(Schema.String).annotate({
  description:
    "Accounts whose plugin installs a service on the VM over SSH after setup (e.g. Tailscale). See GET /resources/ssh-install/accounts.",
});

const AgentServiceInstall = Schema.Struct({
  accountId: Schema.String,
  pluginId: Schema.String,
  message: Schema.String,
  address: Schema.optionalKey(Schema.String),
}).annotate({ identifier: "AgentServiceInstall" });

const Status = Schema.Literals([
  "pending",
  "provisioning",
  "setting-up",
  "up",
  "failed",
  "stopped",
]);

export const AgentVmAccount = Schema.Struct({
  accountId: Schema.String,
  accountName: Schema.String,
  pluginId: Schema.String,
  pluginName: Schema.String,
  pluginLogoSvg: Schema.optionalKey(Schema.String),
  resourceTypeId: Schema.String,
  resourceTypeName: Schema.String,
  defaultUsername: Schema.String,
  defaultFields: StringMap,
  defaultFieldLabels: Schema.optionalKey(StringMap),
  createFields: Schema.optionalKey(Schema.Array(JsonObject)),
  hiddenFieldKeys: Schema.Array(Schema.String),
}).annotate({ identifier: "AgentVmAccount" });

export const AgentSettings = Schema.Struct({
  accountId: Schema.String,
  pluginId: Schema.String,
  resourceTypeId: Schema.String,
  tool: Tool,
  surface: Schema.optionalKey(Surface),
  fields: StringMap,
  serviceAccountIds: Schema.optionalKey(ServiceAccountIds),
  t3Access: Schema.optionalKey(T3Access),
  t3Policy: Schema.optionalKey(Schema.NullOr(T3CodePolicy)).annotateKey({
    description:
      "The organization's T3 Code managed policy, installed on every T3 Code server (`/etc/t3code/policy.json`). " +
      "On save: omit to keep the stored policy, `null` to remove it. A new T3 Code session is refused when the " +
      "policy does not allow its tool or turns off the T3 Connect it is reached through.",
  }),
}).annotate({ identifier: "AgentSettings" });

/** Documented; the handler reads the body raw. */
const AgentT3PolicyApplyRequest = Schema.Struct({
  restart: Schema.Boolean.annotate({
    description:
      "Restart T3 Code so the policy applies now (interrupts running agent turns), or leave it for the next restart.",
  }),
  sessionId: Schema.optionalKey(
    Schema.String.annotate({
      description: "One server; omitted, every T3 Code server in the organization.",
    }),
  ),
}).annotate({ identifier: "AgentT3PolicyApplyRequest" });

export const AgentT3PolicyApplyResult = Schema.Struct({
  servers: Schema.Array(
    Schema.Struct({
      sessionId: Schema.String,
      projectName: Schema.String,
      outcome: Schema.Literals([
        "applied",
        "installed",
        "unchanged",
        "skipped",
        "setting-up",
        "failed",
      ]).annotate({
        description:
          "`applied`: installed and T3 Code restarted onto it. `installed`: applies at the next restart. " +
          "`unchanged`: already had it. `skipped`: the policy does not fit this server, which keeps its policy. " +
          "`setting-up`: setup has not finished; the server starts on this policy. `failed`: see `message`.",
      }),
      message: Schema.optionalKey(Schema.String),
    }),
  ),
}).annotate({ identifier: "AgentT3PolicyApplyResult" });

export const AgentSession = Schema.Struct({
  id: Schema.String,
  repo: Schema.String,
  projectName: Schema.String,
  workspaceName: Schema.String,
  accountId: Schema.String,
  pluginId: Schema.String,
  resourceTypeId: Schema.String,
  tool: Tool,
  surface: Schema.optionalKey(Surface),
  serviceAccountIds: Schema.optionalKey(ServiceAccountIds),
  t3Access: Schema.optionalKey(T3Access),
  t3Policy: Schema.optionalKey(Schema.NullOr(T3CodePolicy)).annotateKey({
    description:
      "T3 Code sessions: the managed policy last installed on the server (from the organization's defaults at " +
      "creation, refreshed when Authorize server runs or the policy is rolled out).",
  }),
  t3PolicyRestartPending: Schema.optionalKey(
    Schema.Boolean.annotate({
      description:
        "T3 Code sessions: `t3Policy` is installed but T3 Code has not restarted since, so the server still " +
        "enforces the policy it started with. Cleared by a restarting rollout or Authorize server.",
    }),
  ),
  serviceInstalls: Schema.optionalKey(Schema.Array(AgentServiceInstall)),
  agentLinkId: Schema.optionalKey(
    Schema.NullOr(Schema.String).annotate({
      description:
        "Nibblets sessions: the agent link that starts the server linked to this organization " +
        "(see Agent links). Revoked, with its agents, when the session is deleted.",
    }),
  ),
  branchName: Schema.String,
  status: Status,
  vmResourceId: Schema.NullOr(Schema.String),
  logs: Schema.Array(Schema.String),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
}).annotate({ identifier: "AgentSession" });

/** Documented; the handler reads the body raw. */
const CreateAgentSession = Schema.Struct({
  // Required for terminal sessions; a "t3-code" session provisions a bare
  // server that manages its own projects, so it is omitted there.
  repo: Schema.optionalKey(Schema.String),
  projectName: Schema.optionalKey(Schema.String),
  workspaceName: Schema.optionalKey(Schema.String),
  settings: AgentSettings,
  nibbletsLink: Schema.optionalKey(
    Schema.Struct({
      scopes: Schema.Array(Schema.String)
        .annotate({ description: "The link's ceiling." })
        .check(minLength(1)),
    }).annotate({
      description:
        "Nibblets sessions only: start the server linked to this organization through an agent " +
        "link you approve, as on the link approval page. Needs `team:invite`; `scopes` must be " +
        "within what you hold (no break-glass elevation) minus permissions no agent may hold. " +
        "Refused for API keys and agents.",
    }),
  ),
}).annotate({ identifier: "CreateAgentSession" });

export const AgentLinkableScopes = Schema.Struct({
  scopes: Schema.NullOr(Schema.Array(Schema.String)),
}).annotate({ identifier: "AgentLinkableScopes" });

export const AgentOpenCommand = Schema.Struct({
  command: Schema.String,
  cwd: Schema.String,
  sshKeyId: Schema.optionalKey(Schema.String),
  sshKeyName: Schema.optionalKey(Schema.String),
});

export const AgentSessionDeleted = Schema.Struct({ ok: Schema.Boolean });

export const AgentReconcile = Schema.Struct({ branchName: Schema.String, message: Schema.String });

/** Session ids are whatever the session row holds, so they are documented as plain strings. */
const SessionParams = { orgId: OrgId, id: Schema.String } as const;

/** The 502's description, which says what failed rather than the generic one. */
const describeProviderRefusal = (operation: Record<string, unknown>): Record<string, unknown> => {
  const responses = operation["responses"];
  if (!Predicate.isObject(responses)) return operation;
  const entries = Object.entries(responses).map(([status, response]: [string, unknown]) =>
    status === "502" && Predicate.isObject(response)
      ? [status, { ...response, description: "The provider refused to delete the VM" }]
      : [status, response],
  );
  return { ...operation, responses: Object.fromEntries(entries) };
};

export class AgentsGroup extends HttpApiGroup.make("agents")
  .add(
    HttpApiEndpoint.get("accounts", "/accounts", {
      params: OrgParams,
      success: Schema.Array(AgentVmAccount),
    })
      .annotate(RequiredPermission, "accounts:read")
      .annotate(OpenApi.Summary, "List accounts whose plugins can create agent VMs")
      .annotate(SuccessDescription, "Accounts"),
    HttpApiEndpoint.get("settings", "/settings", {
      params: OrgParams,
      success: Schema.NullOr(AgentSettings),
    })
      .annotate(RequiredPermission, "accounts:read")
      .annotate(OpenApi.Summary, "Get saved Agents defaults")
      .annotate(SuccessDescription, "Settings"),
    HttpApiEndpoint.put("saveSettings", "/settings", {
      params: OrgParams,
      payload: AgentSettings,
      success: AgentSettings,
    })
      .annotate(RequiredPermission, "accounts:write")
      .annotate(OpenApi.Summary, "Save Agents defaults")
      .annotate(SuccessDescription, "Settings"),
    HttpApiEndpoint.post("applyT3Policy", "/t3-policy/apply", {
      params: OrgParams,
      payload: AgentT3PolicyApplyRequest,
      success: AgentT3PolicyApplyResult,
      error: [BadRequest, NotFound],
    })
      .annotate(RequiredPermission, "resources:execute")
      .annotate(OpenApi.Summary, "Roll the T3 Code policy out to existing servers")
      .annotate(
        OpenApi.Description,
        "Installs the organization's current T3 Code managed policy (or removes the one Infrawrench installed, when " +
          "there is none) on existing T3 Code servers. T3 Code reads its policy only at startup: `restart: true` " +
          "restarts it so the policy applies now, interrupting running agent turns, terminals and connected clients; " +
          "`restart: false` installs the file and marks the session `t3PolicyRestartPending`. Servers that already " +
          "have the policy, that the policy does not fit, or that are still setting up are not dialled. Requires " +
          "`resources:execute`.",
      )
      .annotate(SuccessDescription, "What happened on each T3 Code server"),
    HttpApiEndpoint.get("linkScopes", "/link-scopes", {
      params: OrgParams,
      success: AgentLinkableScopes,
    })
      .annotate(RequiredPermission, "resources:write")
      .annotate(OpenApi.Summary, "What you could give a Nibblets session's agent link")
      .annotate(
        OpenApi.Description,
        "`scopes` is null when you cannot approve links here (no `team:invite`).",
      )
      .annotate(SuccessDescription, "Grantable scopes"),
    HttpApiEndpoint.get("sessions", "/sessions", {
      params: OrgParams,
      success: Schema.Array(AgentSession),
    })
      .annotate(RequiredPermission, "resources:read")
      .annotate(OpenApi.Summary, "List agent sessions")
      .annotate(SuccessDescription, "Sessions"),
    HttpApiEndpoint.post("createSession", "/sessions", {
      params: OrgParams,
      payload: CreateAgentSession,
      success: AgentSession.pipe(HttpApiSchema.status(201)),
      error: [BadRequest, Forbidden],
    })
      .annotate(RequiredPermission, "resources:write")
      .annotate(OpenApi.Summary, "Create an agent session")
      .annotate(SuccessDescription, "Created"),
    HttpApiEndpoint.post("open", "/sessions/:id/open", {
      params: SessionParams,
      success: AgentOpenCommand,
      error: NotFound,
    })
      .annotate(RequiredPermission, "resources:execute")
      .annotate(OpenApi.Summary, "Return the command and working directory for an agent session")
      .annotate(SuccessDescription, "Open command"),
    HttpApiEndpoint.delete("deleteSession", "/sessions/:id", {
      params: SessionParams,
      success: AgentSessionDeleted,
      error: [NotFound, BadGateway],
    })
      .annotate(RequiredPermission, "resources:delete")
      .annotate(OpenApi.Summary, "Delete an agent session and destroy its VM")
      .annotate(SuccessDescription, "Session deleted")
      .annotate(OpenApi.Transform, describeProviderRefusal),
    HttpApiEndpoint.post("reconcile", "/sessions/:id/reconcile", {
      params: SessionParams,
      success: AgentReconcile,
      error: NotFound,
    })
      .annotate(RequiredPermission, "resources:execute")
      .annotate(OpenApi.Summary, "Return reconciliation branch metadata")
      .annotate(SuccessDescription, "Reconciliation metadata"),
  )
  .prefix("/api/org/:orgId/agents")
  .middleware(OrgAuth)
  .annotate(OpenApi.Title, "Agents") {}

export class AgentsApi extends withApiDefaults(HttpApi.make("agents").add(AgentsGroup)) {}

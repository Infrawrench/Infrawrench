/**
 * Agents: `/api/org/:orgId/agents`, the handlers. The session rows, their VMs
 * and every plugin call are promise code in `./sessions.ts`, reached through
 * `legacy`.
 *
 * Bodies are read raw (`handleRaw`) and decoded against the shapes the Hono
 * handlers declared, which are looser than the documented requests: optional
 * fields may be `null`, and the saved defaults echo whatever else was sent.
 */
import { Effect, Predicate, Schema } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { randomUUID } from "node:crypto";
import type { AgentSurface, AgentTool } from "@infrawrench/ui/agents";
import { buildAgentLaunchCommand, isCloneableGitRepo } from "@infrawrench/ui/agents/launch-command";
import {
  agentSurfaceOrDefault,
  agentSurfaceRequiresRepo,
  buildT3CodeConnectCommand,
  isT3CodeSurface,
  resolveT3CodeAccess,
  t3CodeAccessOrDefault,
  validateT3CodePolicy,
  type T3CodePolicy,
} from "@infrawrench/ui/agents/t3-code";
import { buildNibbletsSignInCommand, isNibbletsSurface } from "@infrawrench/ui/agents/nibblets";
import { AGENT_SCOPES } from "@infrawrench/ui/settings/api-key-scopes";
import { grantablePermissions } from "@infrawrench/server-core/agent-links/links";
import { logAudit } from "../../../services/audit";
import {
  releaseAgentServices,
  resolveAgentServiceAccounts,
} from "../../../services/agent-services";
import {
  applyT3CodePolicyToSessions,
  ensureAgentVmSetupForSession,
  hasAgentSetupComplete,
  revokeT3CodeLinkOnVm,
} from "../../../services/agent-setup";
import { makeDomain } from "../../domain";
import { BadGateway, badRequest, forbidden, HttpFailure, notFound } from "../../errors";
import { decodeAsPayload, fieldsOf, readJson, readJsonOr } from "../../request-body";
import { fireAndForget, legacy } from "../../legacy";
import { OrgPrincipal } from "../../principal";
import { respond } from "../../response";
import {
  AgentLinkableScopes,
  AgentOpenCommand,
  AgentReconcile,
  AgentSession,
  AgentSessionDeleted,
  AgentSettings,
  AgentsApi,
  AgentT3PolicyApplyResult,
  AgentVmAccount,
} from "./api";
import {
  authorizeT3Policy,
  createAgentSession,
  deleteAgentVm,
  dropSession,
  ensureOrgAgentSshKey,
  forgetSession,
  listAgentSessions,
  listAgentVmAccounts,
  loadSession,
  orgT3Policy,
  projectNameFromRepo,
  readAgentSettings,
  refreshAgentSession,
  saveAgentSettings,
  sessionWorkspaceName,
} from "./sessions";

const StringMap = Schema.Record(Schema.String, Schema.String);
const OptionalString = Schema.optionalKey(Schema.NullOr(Schema.String));
const OptionalIds = Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.String)));

/** What `PUT /settings` declared its body to be. */
const SettingsBody = Schema.Struct({
  accountId: Schema.String,
  pluginId: Schema.String,
  resourceTypeId: Schema.String,
  tool: Schema.optionalKey(Schema.String),
  surface: OptionalString,
  fields: Schema.optionalKey(Schema.NullOr(StringMap)),
  serviceAccountIds: OptionalIds,
  t3Access: OptionalString,
  t3Policy: Schema.optionalKey(Schema.Unknown),
});

/** What `POST /sessions` declared its body to be. */
const CreateSessionBody = Schema.Struct({
  repo: OptionalString,
  projectName: OptionalString,
  workspaceName: OptionalString,
  settings: Schema.Struct({
    accountId: Schema.String,
    pluginId: Schema.String,
    resourceTypeId: Schema.String,
    tool: Schema.optionalKey(Schema.Unknown),
    surface: OptionalString,
    fields: StringMap,
    serviceAccountIds: OptionalIds,
    t3Access: OptionalString,
  }),
  nibbletsLink: Schema.optionalKey(Schema.Unknown),
});

/** A refusal whose body carries more than `error` (`issues`, `code`, `scopes`), sent as-is. */
const refuse = (status: number, body: Readonly<Record<string, unknown>>) =>
  Effect.die(new HttpFailure(status, body));

const toolOf = (tool: unknown): AgentTool => (tool === "claude-code" ? "claude-code" : "codex");

const AgentsHandlers = HttpApiBuilder.group(AgentsApi, "agents", (handlers) =>
  handlers
    .handle("accounts", () =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const out = yield* legacy(() => listAgentVmAccounts(organizationId));
        return yield* respond(Schema.Array(AgentVmAccount))(out);
      }),
    )
    .handle("settings", () =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const settings = yield* legacy(() => readAgentSettings(organizationId));
        return yield* respond(Schema.NullOr(AgentSettings))(settings);
      }),
    )
    .handleRaw("saveSettings", ({ request }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        const raw = yield* fieldsOf(yield* readJson(request));
        const body = yield* decodeAsPayload(SettingsBody, raw);
        const id = `${organizationId}:default`;
        const surface = agentSurfaceOrDefault(body.surface);
        const services = yield* legacy(() =>
          resolveAgentServiceAccounts(organizationId, body.serviceAccountIds ?? undefined),
        );
        const t3Access = resolveT3CodeAccess(body.t3Access, services.pluginIds);
        // `t3Policy` is three-state: absent keeps the stored policy (so a
        // client predating it cannot wipe it), null removes it, an object
        // replaces it. The policy is checked on its own here; whether it fits
        // a given Tool and access is checked when a server is created with it.
        let t3Policy: T3CodePolicy | null | undefined;
        if (body.t3Policy === null) {
          t3Policy = null;
        } else if (body.t3Policy !== undefined) {
          const validation = validateT3CodePolicy(body.t3Policy);
          if (!validation.ok || !validation.policy) {
            const first = validation.issues.find((i) => i.level === "error");
            return yield* refuse(400, {
              error: `Invalid T3 Code policy: ${first?.message ?? "not a policy"}`,
              issues: validation.issues,
            });
          }
          t3Policy = validation.policy;
        }
        const previousPolicy =
          t3Policy === undefined ? undefined : yield* legacy(() => orgT3Policy(organizationId));
        yield* legacy(() =>
          saveAgentSettings(organizationId, {
            accountId: body.accountId,
            pluginId: body.pluginId,
            resourceTypeId: body.resourceTypeId,
            tool: body.tool,
            surface,
            fields: body.fields ?? {},
            serviceAccountIds: services.accountIds,
            t3Access,
            t3Policy,
          }),
        );
        if (t3Policy !== undefined && JSON.stringify(previousPolicy) !== JSON.stringify(t3Policy)) {
          const policy = t3Policy;
          yield* fireAndForget(() =>
            logAudit({
              organizationId,
              ...(session.userId ? { userId: session.userId } : {}),
              action: policy ? "agent_t3_policy.update" : "agent_t3_policy.remove",
              entityType: "agent_settings",
              entityId: id,
              metadata: policy ? { organization: policy.organization } : {},
            }),
          );
        }
        const storedPolicy =
          t3Policy === undefined ? yield* legacy(() => orgT3Policy(organizationId)) : t3Policy;
        return yield* respond(AgentSettings)({
          ...raw,
          surface,
          serviceAccountIds: services.accountIds,
          t3Access,
          t3Policy: storedPolicy,
        });
      }),
    )
    // Roll the organization's current T3 Code policy out to existing T3 Code
    // servers, or to one. T3 Code reads its policy only at startup and a
    // restart interrupts running agent turns, so whether to restart now is the
    // caller's choice (`restart`); without it the file is installed and the
    // session is marked as owing a restart. `resources:execute` because it
    // runs commands on the servers and may restart them, the same gate as
    // Authorize server.
    .handleRaw("applyT3Policy", ({ request }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        const body = yield* readJsonOr(request, null);
        const restart = Predicate.isObject(body) ? body["restart"] : undefined;
        if (!Predicate.isObject(body) || typeof restart !== "boolean") {
          return yield* badRequest("`restart` (boolean) is required");
        }
        const rawSessionId = body["sessionId"];
        if (rawSessionId !== undefined && typeof rawSessionId !== "string") {
          return yield* badRequest("`sessionId` must be a string");
        }
        const sessionId = rawSessionId;
        if (sessionId) {
          const row = yield* legacy(() => loadSession(sessionId, organizationId));
          if (!row) return yield* notFound();
        }
        const policy = yield* legacy(() => orgT3Policy(organizationId));
        const servers = yield* legacy(() =>
          applyT3CodePolicyToSessions(organizationId, policy, {
            restart,
            ...(sessionId ? { sessionId } : {}),
          }),
        );
        const touched = servers.filter((s) => s.outcome === "applied" || s.outcome === "installed");
        if (touched.length > 0) {
          yield* fireAndForget(() =>
            logAudit({
              organizationId,
              ...(session.userId ? { userId: session.userId } : {}),
              action: "agent_t3_policy.apply",
              entityType: "agent_settings",
              entityId: `${organizationId}:default`,
              metadata: {
                restart,
                servers: touched.map((s) => s.sessionId),
                ...(policy ? { organization: policy.organization } : { removed: true }),
              },
            }),
          );
        }
        return yield* respond(AgentT3PolicyApplyResult)({ servers });
      }),
    )
    // What the caller could give a Nibblets session's agent link: the same
    // answer the link approval page computes (their role without break-glass
    // elevation, minus what no agent may hold, within the offered scopes), or
    // `null` when they lack `team:invite` and so cannot approve a link at all.
    // Keys and agents get `null`: approving a link is a person's act.
    .handle("linkScopes", () =>
      Effect.gen(function* () {
        const { organizationId, session, apiKey } = yield* OrgPrincipal;
        if (apiKey) return yield* respond(AgentLinkableScopes)({ scopes: null });
        const grantable = yield* legacy(() => grantablePermissions(organizationId, session.userId));
        if (!grantable.includes("team:invite")) {
          return yield* respond(AgentLinkableScopes)({ scopes: null });
        }
        return yield* respond(AgentLinkableScopes)({
          scopes: AGENT_SCOPES.filter((s) => grantable.includes(s)),
        });
      }),
    )
    .handle("sessions", () =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const out = yield* legacy(() => listAgentSessions(organizationId));
        return yield* respond(Schema.Array(AgentSession))(out);
      }),
    )
    .handleRaw("createSession", ({ request }) =>
      Effect.gen(function* () {
        const { organizationId, session, apiKey } = yield* OrgPrincipal;
        const { userId } = session;
        const body = yield* decodeAsPayload(
          CreateSessionBody,
          yield* fieldsOf(yield* readJson(request)),
        );
        const tool = toolOf(body.settings.tool);
        const surface: AgentSurface = agentSurfaceOrDefault(body.settings.surface);
        const repo = body.repo?.trim() ?? "";
        // T3 Code servers manage their own projects, so they are provisioned
        // without a repository; every other surface still requires one.
        if (agentSurfaceRequiresRepo(surface)) {
          if (!repo) return yield* badRequest("repo is required");
          // Web sessions have no local-folder upload path; the repo is cloned
          // on the VM during setup, so it must be a URL Git can clone.
          if (!isCloneableGitRepo(repo)) {
            return yield* badRequest(
              "repo must be a cloneable Git URL (https://, ssh://, git://, or git@host:path)",
            );
          }
        }
        const requestedServices = body.settings.serviceAccountIds ?? undefined;
        const services = yield* legacy(() =>
          resolveAgentServiceAccounts(organizationId, requestedServices),
        );
        if (services.accountIds.length !== (requestedServices?.length ?? 0)) {
          return yield* badRequest(
            "An attached service account was not found or cannot install over SSH",
          );
        }
        const isT3Code = isT3CodeSurface(surface);
        const t3Access = isT3Code
          ? resolveT3CodeAccess(body.settings.t3Access, services.pluginIds)
          : "t3-connect";
        if (isT3Code && t3CodeAccessOrDefault(body.settings.t3Access) !== t3Access) {
          return yield* badRequest("T3 Code over Tailscale needs a Tailscale account attached");
        }
        // The organization's managed policy, from the stored defaults rather
        // than the request: it is the organization's, not the creator's, to
        // choose. A policy that does not fit this server is refused before a
        // VM exists, since T3 Code would refuse to start with it (or start
        // unreachable).
        const t3Policy = isT3Code ? yield* legacy(() => orgT3Policy(organizationId)) : null;
        if (t3Policy) {
          const fit = validateT3CodePolicy(t3Policy, { tool, access: t3Access });
          if (!fit.ok) {
            const first = fit.issues.find((i) => i.level === "error");
            return yield* refuse(400, {
              error: `The organization's T3 Code policy does not fit this server: ${first?.message ?? "invalid policy"}`,
              issues: fit.issues,
            });
          }
        }
        const id = randomUUID();
        const isNibblets = isNibbletsSurface(surface);
        const projectName =
          body.projectName?.trim() ||
          (repo ? projectNameFromRepo(repo) : "") ||
          (isNibblets ? "nibblets" : "t3-code");

        // Nibblets can start linked to the org: an agent link approved by the
        // creator, exactly as if they had approved a device-flow request, so
        // the same rules hold (`team:invite`, a ceiling within their own role
        // without elevation, minus what no agent may hold). Checked before the
        // VM is created, so a refused link costs nothing.
        let linkScopes: string[] | null = null;
        if (isNibblets && body.nibbletsLink) {
          if (apiKey) {
            return yield* forbidden("Only a person can link a Nibblets server to the organization");
          }
          const requested = Predicate.isObject(body.nibbletsLink)
            ? body.nibbletsLink["scopes"]
            : undefined;
          if (
            !Array.isArray(requested) ||
            requested.length === 0 ||
            requested.some((s) => typeof s !== "string")
          ) {
            return yield* badRequest("Choose at least one permission for the link");
          }
          const grantable = yield* legacy(() => grantablePermissions(organizationId, userId));
          if (!grantable.includes("team:invite")) {
            return yield* forbidden(
              "You need permission to invite people to link a server to this organization",
            );
          }
          const unique = [...new Set(requested.filter(Predicate.isString))];
          const notAllowed = unique.filter(
            (s) => !AGENT_SCOPES.includes(s) || !grantable.includes(s),
          );
          if (notAllowed.length > 0) {
            return yield* refuse(400, {
              error: `You cannot grant: ${notAllowed.join(", ")}`,
              code: "scope_not_allowed",
              scopes: notAllowed,
            });
          }
          linkScopes = unique;
        }

        const outcome = yield* legacy(() =>
          createAgentSession({
            organizationId,
            userId,
            id,
            repo,
            projectName,
            workspaceName: sessionWorkspaceName(surface, body.workspaceName, repo, projectName),
            tool,
            surface,
            settings: body.settings,
            serviceAccountIds: services.accountIds,
            t3Access,
            t3Policy,
            linkScopes,
          }),
        );
        if (outcome.kind === "provision-failed") {
          return yield* badRequest(`VM provisioning failed: ${outcome.message}`);
        }
        return yield* respond(AgentSession, { status: 201 })(outcome.session);
      }),
    )
    .handle("open", ({ params }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        const row = yield* legacy(() => loadSession(params.id, organizationId));
        if (!row) return yield* notFound();
        const live = yield* legacy(() => refreshAgentSession(row, organizationId));
        if (!live) {
          yield* legacy(() => dropSession(row, organizationId, session.userId));
          return yield* notFound("Agent VM no longer exists");
        }
        const agentKey = yield* legacy(() => ensureOrgAgentSshKey(organizationId, session.userId));
        // Mirror the desktop client: only when setup never completed do we
        // (re)kick the full setup and hand out a launch-ready token for the
        // launch command to wait on. Re-running setup on a completed session
        // would be redundant, and an absent token makes the launch script skip
        // the marker wait entirely.
        const setupComplete = hasAgentSetupComplete(row.logs);
        const launchReadyToken = setupComplete ? undefined : randomUUID();
        yield* fireAndForget(() =>
          ensureAgentVmSetupForSession(row.id, organizationId, {
            forceSync: !setupComplete,
            ...(launchReadyToken ? { launchReadyToken } : {}),
          }).catch((error: unknown) => {
            console.warn(`Agent VM setup failed for ${row.id}`, error);
          }),
        );
        const tool = toolOf(row.tool);
        const cwd = `~/${row.workspaceName}`;
        const key = { sshKeyId: agentKey.id, sshKeyName: agentKey.name };
        // A T3 Code session's terminal is the one-off authorization flow, not
        // an attached agent: T3 Code itself runs the agent, and its own tab is
        // the session's main surface. There is no launch-ready marker to wait
        // on because nothing is being attached.
        // Nibblets: the installer's own sign-in menu and Nibblets Connect, run
        // in the session's Authorize terminal (`install.sh --sign-in`).
        if (isNibbletsSurface(row.surface)) {
          return yield* respond(AgentOpenCommand)({
            command: buildNibbletsSignInCommand(),
            cwd,
            ...key,
          });
        }
        if (isT3CodeSurface(row.surface)) {
          const access = t3CodeAccessOrDefault(row.t3Access);
          const policy = yield* legacy(() => authorizeT3Policy(row, organizationId, tool, access));
          return yield* respond(AgentOpenCommand)({
            command: buildT3CodeConnectCommand({ tool, access, ...policy }),
            cwd,
            ...key,
          });
        }
        return yield* respond(AgentOpenCommand)({
          command: buildAgentLaunchCommand({
            sessionId: row.id,
            tool,
            workspaceName: row.workspaceName,
            ...(launchReadyToken ? { launchReadyToken } : {}),
          }),
          cwd,
          ...key,
        });
      }),
    )
    .handle("deleteSession", ({ params }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        const row = yield* legacy(() => loadSession(params.id, organizationId));
        if (!row) return yield* notFound();
        // Revoke the relay link while the VM still exists: afterwards there is
        // no way to remove the environment from T3's side. Best effort: an
        // unreachable VM must not block deletion of a machine that is still
        // billing.
        if (isT3CodeSurface(row.surface)) {
          yield* legacy(() => revokeT3CodeLinkOnVm(row.id, organizationId));
        }
        const vm = yield* legacy(() => deleteAgentVm(row, organizationId));
        if (vm.kind === "rate-limited") {
          return yield* refuse(429, {
            error: "The provider is rate-limiting API requests; try deleting again in a minute.",
          });
        }
        if (vm.kind === "failed") {
          return yield* new BadGateway({ error: `Could not delete the agent VM: ${vm.message}` });
        }
        // The VM is gone; let attached services forget it too (e.g. remove the
        // tailnet device, which would otherwise linger offline).
        yield* legacy(() => releaseAgentServices(row, organizationId));
        // And a Nibblets server's link to the org, with every agent it made.
        yield* legacy(() => dropSession(row, organizationId, session.userId));
        forgetSession(row.id);
        return yield* respond(AgentSessionDeleted)({ ok: true });
      }),
    )
    .handle("reconcile", ({ params }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        const row = yield* legacy(() => loadSession(params.id, organizationId));
        if (!row) return yield* notFound();
        const live = yield* legacy(() => refreshAgentSession(row, organizationId));
        if (!live) {
          yield* legacy(() => dropSession(row, organizationId, session.userId));
          return yield* notFound("Agent VM no longer exists");
        }
        if (isNibbletsSurface(row.surface)) {
          return yield* respond(AgentReconcile)({
            branchName: row.branchName,
            message:
              "A Nibblets server has no Infrawrench-managed checkout. Infrawrench has nothing to reconcile.",
          });
        }
        if (isT3CodeSurface(row.surface)) {
          return yield* respond(AgentReconcile)({
            branchName: row.branchName,
            message:
              "T3 Code owns this server's projects and their branches; push from inside T3 Code. Infrawrench has nothing to reconcile.",
          });
        }
        return yield* respond(AgentReconcile)({
          branchName: row.branchName,
          // Web sessions clone from a Git URL on the VM; there is no local
          // checkout to fetch into, so reconciling means pushing from the VM
          // itself.
          message: `Open the agent terminal and push ${row.branchName} from the VM to your Git remote to reconcile this agent's work.`,
        });
      }),
    ),
);

export const agentsDomain = makeDomain("agents", AgentsApi, AgentsHandlers);

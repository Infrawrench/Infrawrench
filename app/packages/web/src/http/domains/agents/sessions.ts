/**
 * Agent sessions, the promise half of `/api/org/:orgId/agents`: the session
 * rows, their VMs and the plugin calls that create, verify and destroy them.
 *
 * Everything that touches a plugin client is in here and runs inside one
 * `legacy` call from the handlers (`./index.ts`), so a client is built and
 * used in promise code, inside its egress scope, and never held by Effect.
 */
import { randomUUID } from "node:crypto";
import { and, desc, eq, isNull } from "drizzle-orm";
import { Predicate } from "effect";
import {
  computeSshPublicKeyFingerprint,
  generateEd25519OpenSshKeyPair,
} from "@infrawrench/ssh-tunnel-core";
import type {
  AgentVmCapability,
  CreateFieldConfig,
  HostPlugin,
  HostPluginClient,
  ResourceInstance,
} from "@infrawrench/plugin-base";
import { normalizeResourceCreateResult } from "@infrawrench/plugin-base";
import type { AgentSurface, AgentTool } from "@infrawrench/ui/agents";
import {
  agentSurfaceOrDefault,
  createT3CodeSetupPlan,
  isT3CodeSurface,
  sameT3CodePolicy,
  t3CodeAccessOrDefault,
  t3CodePolicyOrNull,
  validateT3CodePolicy,
  type T3CodePolicy,
} from "@infrawrench/ui/agents/t3-code";
import {
  createNibbletsSetupPlan,
  isNibbletsSurface,
  NIBBLETS_DIR,
  NIBBLETS_PLATFORM,
} from "@infrawrench/ui/agents/nibblets";
import { T3_CODE_PROJECTS_DIR } from "@infrawrench/ui/agents/t3-code";
import { createApprovedLink, revokeLink } from "@infrawrench/server-core/agent-links/links";
import { upsertCreatedResource } from "@infrawrench/server-core/created-resource";
import { holdSecretWrites } from "@infrawrench/server-core/secret-states";
import { logAudit } from "../../../services/audit";
import { db } from "../../../db/client";
import { accounts, agentSessions, agentSettings, resources, sshKeys } from "../../../db/schema";
import { loadPlugins } from "../../../plugins/loader";
import { getClientForAccount } from "../../../services/plugin-clients";
import { buildAad, decrypt, encrypt } from "../../../services/encryption";
import { publicServiceInstalls } from "../../../services/agent-services";
import {
  createAgentSetupPlanForRepo,
  maybeAutoResumeAgentSetup,
  scheduleAgentVmSetup,
  setupAwareAgentStatus,
  setupPlanLogLines,
} from "../../../services/agent-setup";

type SessionRow = typeof agentSessions.$inferSelect;

const AGENT_SSH_KEY_NAME = "infrawrench-agent";
const AGENT_SESSION_DELETE_GRACE_MS = 15 * 60 * 1000;
const AGENT_SESSION_NOT_FOUND_DELETE_THRESHOLD = 3;

const agentSessionNotFoundStreak = new Map<string, number>();

// sessionId -> epoch ms before which live provider verification is skipped.
// GET /sessions polls every few seconds per open panel and verified every
// session against the provider on each poll, which burned through provider
// rate limits (DigitalOcean 429'd the whole account). Between live checks the
// session is served from its DB row; a provider 429 backs off harder.
const agentVmVerifyBackoff = new Map<string, number>();
const AGENT_VM_VERIFY_INTERVAL_MS = 15_000;
const AGENT_VM_RATE_LIMIT_COOLDOWN_MS = 60_000;

function branchName(id: string): string {
  return `infrawrench/agent-${id.slice(0, 8)}`;
}

export function projectNameFromRepo(repo: string): string {
  const trimmed = repo.trim().replace(/[\\/]+$/, "");
  return (trimmed.split(/[\\/]/).pop() ?? "project").replace(/\.git$/, "") || "project";
}

function cloudResourceName(projectName: string): string {
  const cleaned = projectName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50);
  const name = /^[a-z]/.test(cleaned) ? cleaned : `agent-${cleaned || "vm"}`;
  return name.replace(/-+$/g, "").slice(0, 63);
}

/**
 * A policy as the jsonb column stores it. The column is typed as a plain
 * record; the policy is an interface, so it is copied into one (the JSON is
 * the same).
 */
function policyColumn(policy: T3CodePolicy | null): Record<string, unknown> | null {
  return policy ? { ...policy } : null;
}

/** Accounts whose plugins can create agent VMs, with each type's create form. */
export async function listAgentVmAccounts(organizationId: string) {
  const [plugins, rows] = await Promise.all([
    loadPlugins(),
    db
      .select({
        id: accounts.id,
        pluginId: accounts.pluginId,
        displayName: accounts.displayName,
      })
      .from(accounts)
      .where(and(eq(accounts.organizationId, organizationId), isNull(accounts.deletedAt))),
  ]);
  const byPlugin = new Map(plugins.map((p) => [p.plugin.manifest.id, p.plugin]));
  const out = [];
  for (const account of rows) {
    const plugin = byPlugin.get(account.pluginId);
    if (!plugin) continue;
    const clientContext = await getClientForAccount(account.id, organizationId).catch(() => null);
    for (const rt of plugin.resourceTypes) {
      if (!rt.agentVm || !rt.supportsCreate || !rt.sshEndpoint) continue;
      out.push({
        accountId: account.id,
        accountName: account.displayName,
        pluginId: account.pluginId,
        pluginName: plugin.manifest.displayName,
        pluginLogoSvg: plugin.manifest.logoSvg,
        resourceTypeId: rt.id,
        resourceTypeName: rt.displayName,
        defaultUsername: rt.agentVm.defaultUsername,
        defaultFields: agentDefaultFields(rt.agentVm),
        defaultFieldLabels: rt.agentVm.defaultFieldLabels ?? {},
        createFields: await agentCreateFields(clientContext?.client, rt.id, rt.agentVm),
        hiddenFieldKeys: rt.agentVm.hiddenFieldKeys ?? [rt.agentVm.sshKeyFieldKey],
      });
    }
  }
  return out;
}

/** The organization's saved Agents defaults, as the settings routes answer them. */
export async function readAgentSettings(organizationId: string) {
  const [row] = await db
    .select()
    .from(agentSettings)
    .where(eq(agentSettings.organizationId, organizationId))
    .limit(1);
  if (!row) return null;
  return {
    accountId: row.accountId,
    pluginId: row.pluginId,
    resourceTypeId: row.resourceTypeId,
    tool: row.tool,
    surface: agentSurfaceOrDefault(row.surface),
    fields: row.fieldsJson,
    serviceAccountIds: row.serviceAccountIds ?? [],
    t3Access: t3CodeAccessOrDefault(row.t3Access),
    t3Policy: t3CodePolicyOrNull(row.t3Policy),
  };
}

/** The organization's stored T3 Code policy, or null. */
export async function orgT3Policy(organizationId: string): Promise<T3CodePolicy | null> {
  const [row] = await db
    .select({ t3Policy: agentSettings.t3Policy })
    .from(agentSettings)
    .where(eq(agentSettings.organizationId, organizationId))
    .limit(1);
  return t3CodePolicyOrNull(row?.t3Policy);
}

export interface AgentSettingsWrite {
  readonly accountId: string;
  readonly pluginId: string;
  readonly resourceTypeId: string;
  readonly tool: string | undefined;
  readonly surface: AgentSurface;
  readonly fields: Record<string, string>;
  readonly serviceAccountIds: string[];
  readonly t3Access: string;
  /** Absent keeps the stored policy; null removes it. */
  readonly t3Policy: T3CodePolicy | null | undefined;
}

/** Upsert the organization's defaults row. */
export async function saveAgentSettings(organizationId: string, write: AgentSettingsWrite) {
  const id = `${organizationId}:default`;
  const values = {
    accountId: write.accountId,
    pluginId: write.pluginId,
    resourceTypeId: write.resourceTypeId,
    tool: write.tool,
    surface: write.surface,
    fieldsJson: write.fields,
    serviceAccountIds: write.serviceAccountIds,
    t3Access: write.t3Access,
    ...(write.t3Policy !== undefined ? { t3Policy: policyColumn(write.t3Policy) } : {}),
    updatedAt: new Date(),
  };
  await db
    .insert(agentSettings)
    .values({ id, organizationId, ...values })
    .onConflictDoUpdate({ target: agentSettings.id, set: values });
}

/** Best effort: a session that is going away takes its agent link with it. */
async function revokeSessionLink(
  row: SessionRow,
  organizationId: string,
  userId?: string,
): Promise<void> {
  if (!row.agentLinkId) return;
  try {
    const revoked = await revokeLink(row.agentLinkId);
    if (revoked) {
      void logAudit({
        organizationId,
        ...(userId ? { userId } : {}),
        action: "agent_link.revoke",
        entityType: "agent_link",
        entityId: row.agentLinkId,
        metadata: { platform: NIBBLETS_PLATFORM, by: "agent_session", sessionId: row.id },
      });
    }
  } catch (error) {
    console.warn(`[agents] could not revoke the agent link of session ${row.id}`, error);
  }
}

/** Revoke the session's link, then delete its row. */
export async function dropSession(
  row: SessionRow,
  organizationId: string,
  userId?: string,
): Promise<void> {
  await revokeSessionLink(row, organizationId, userId);
  await db.delete(agentSessions).where(eq(agentSessions.id, row.id));
}

/** Every session, verified against its provider; one whose VM is gone is dropped. */
export async function listAgentSessions(organizationId: string) {
  const rows = await db
    .select()
    .from(agentSessions)
    .where(eq(agentSessions.organizationId, organizationId))
    .orderBy(desc(agentSessions.createdAt));
  const out = [];
  for (const row of rows) {
    const refreshed = await refreshAgentSession(row, organizationId);
    if (refreshed) {
      out.push(refreshed);
      maybeAutoResumeAgentSetup(row, organizationId);
    } else {
      await dropSession(row, organizationId);
    }
  }
  return out;
}

export interface CreateSessionInput {
  readonly organizationId: string;
  readonly userId: string;
  readonly id: string;
  readonly repo: string;
  readonly projectName: string;
  readonly workspaceName: string;
  readonly tool: AgentTool;
  readonly surface: AgentSurface;
  readonly settings: {
    readonly accountId: string;
    readonly pluginId: string;
    readonly resourceTypeId: string;
    readonly fields: Record<string, string>;
  };
  readonly serviceAccountIds: string[];
  readonly t3Access: ReturnType<typeof t3CodeAccessOrDefault>;
  readonly t3Policy: T3CodePolicy | null;
  /** The approved ceiling of the Nibblets link to create, or null for none. */
  readonly linkScopes: string[] | null;
}

export type CreateSessionOutcome =
  | { readonly kind: "provision-failed"; readonly message: string }
  | { readonly kind: "created"; readonly session: ReturnType<typeof rowToSession> };

/**
 * Provision the session's VM and record the session, once every check that
 * can refuse it has passed. A failed provision leaves nothing behind.
 */
export async function createAgentSession(input: CreateSessionInput): Promise<CreateSessionOutcome> {
  const { organizationId, userId, id, repo, projectName, workspaceName, tool, surface } = input;
  const { settings, t3Access, t3Policy, linkScopes } = input;
  const isT3Code = isT3CodeSurface(surface);
  const isNibblets = isNibbletsSurface(surface);
  const setupPlan = isNibblets
    ? createNibbletsSetupPlan(linkScopes !== null)
    : isT3Code
      ? createT3CodeSetupPlan(tool, t3Access, t3Policy)
      : createAgentSetupPlanForRepo(repo, tool, workspaceName);
  const logs = [
    isNibblets
      ? "Nibblets server session created."
      : isT3Code
        ? "T3 Code server session created."
        : "Agent session created.",
    "Setup policy: conservative detection.",
    ...setupPlanLogLines(setupPlan),
    "Provisioning VM with selected provider defaults.",
  ];

  // What the plugin stores from inside the create has no row to attach to until the upsert.
  const heldSecrets = holdSecretWrites();
  let resource;
  let warnings;
  let plugin: HostPlugin | null = null;
  try {
    const ctx = await getClientForAccount(settings.accountId, organizationId);
    if (!ctx) throw new Error("Account not found");
    if (ctx.account.pluginId !== settings.pluginId) {
      throw new Error("Selected account does not match the requested provider");
    }
    if (!ctx.client.createResource) throw new Error("Plugin does not support VM creation");
    const fields = await withAgentSshKey(
      ctx.plugin,
      settings.resourceTypeId,
      settings.fields,
      organizationId,
      userId,
    );

    const create = ctx.client.createResource.bind(ctx.client);
    const createReturn = await heldSecrets.run(() =>
      create(settings.resourceTypeId, settings.accountId, {
        name: cloudResourceName(projectName),
        ...fields,
      }),
    );
    ({ resource, warnings } = normalizeResourceCreateResult(createReturn));
    plugin = ctx.plugin;
  } catch (error) {
    const message = error instanceof Error ? error.message : "VM provisioning failed";
    return { kind: "provision-failed", message };
  }

  await upsertCreatedResource({
    organizationId,
    pluginId: resource.pluginId,
    resourceTypeId: resource.resourceTypeId,
    accountId: resource.accountId,
    resource,
  });
  await heldSecrets.flush().catch((err: unknown) => {
    console.error("[agents] Failed to persist a new VM's secret:", err);
    warnings.push({
      code: "secret-persist-failed",
      message: `${resource.displayName} was created but its credentials could not be stored.`,
    });
  });
  const updatedLogs = [
    ...logs,
    `VM created: ${resource.displayName} (${resource.id}).`,
    ...warnings.map((warning) => `Warning: ${warning.message}`),
    "Waiting for VM to report ready.",
  ];
  // Created once the VM exists, so a failed provision leaves no link behind.
  // No credential yet: setup mints it right before handing it to the VM.
  let agentLinkId: string | null = null;
  if (linkScopes) {
    const link = await createApprovedLink({
      organizationId,
      platform: NIBBLETS_PLATFORM,
      label: projectName.slice(0, 80),
      scopes: linkScopes,
      approvedByUserId: userId,
    });
    agentLinkId = link.id;
    updatedLogs.push("Linked to this organization; setup hands the server its link.");
    void logAudit({
      organizationId,
      userId,
      action: "agent_link.create",
      entityType: "agent_link",
      entityId: link.id,
      metadata: {
        platform: NIBBLETS_PLATFORM,
        label: link.label,
        scopes: linkScopes,
        sessionId: id,
      },
    });
  }
  const initialStatus = setupAwareAgentStatus(
    updatedLogs,
    agentVmStatus(plugin, settings.resourceTypeId, resource),
  );
  await db.insert(agentSessions).values({
    id,
    organizationId,
    repo,
    projectName,
    workspaceName,
    accountId: settings.accountId,
    pluginId: settings.pluginId,
    resourceTypeId: settings.resourceTypeId,
    tool,
    surface,
    serviceAccountIds: input.serviceAccountIds,
    t3Access,
    t3Policy: policyColumn(t3Policy),
    agentLinkId,
    // Kept non-empty for T3 Code servers too: nothing checks it out, but a
    // blank branch reads as data loss in the session row.
    branchName: branchName(id),
    status: initialStatus,
    vmResourceId: resource.id,
    logs: updatedLogs,
    setupPlanJson: JSON.stringify(setupPlan),
  });
  // Fire-and-forget: setup progress and failures are persisted on the session
  // row (logs/status), so the client can poll GET /sessions for them.
  scheduleAgentVmSetup(id, organizationId);

  const [created] = await db.select().from(agentSessions).where(eq(agentSessions.id, id)).limit(1);
  if (!created) throw new Error(`Agent session ${id} was not recorded`);
  return { kind: "created", session: rowToSession(created) };
}

/** Where a T3 Code or Nibblets session keeps its work, and a terminal session's checkout. */
export function sessionWorkspaceName(
  surface: AgentSurface,
  workspaceName: string | null | undefined,
  repo: string,
  projectName: string,
): string {
  if (isT3CodeSurface(surface)) return T3_CODE_PROJECTS_DIR;
  if (isNibbletsSurface(surface)) return NIBBLETS_DIR;
  return workspaceName?.trim() || projectNameFromRepo(repo) || projectName;
}

export type DeleteVmOutcome =
  | { readonly kind: "deleted" }
  | { readonly kind: "rate-limited" }
  | { readonly kind: "failed"; readonly message: string };

/**
 * Destroy the session's VM when its resource row is still live. Already gone
 * upstream is success for a delete; anything else aborts, so a still-billing
 * VM is never orphaned silently.
 */
export async function deleteAgentVm(
  row: SessionRow,
  organizationId: string,
): Promise<DeleteVmOutcome> {
  if (!row.vmResourceId) return { kind: "deleted" };
  const vmResourceId = row.vmResourceId;
  const [resourceRow] = await db
    .select({ id: resources.id })
    .from(resources)
    .where(and(eq(resources.id, vmResourceId), isNull(resources.deletedAt)))
    .limit(1);
  if (!resourceRow) return { kind: "deleted" };
  try {
    const ctx = await getClientForAccount(row.accountId, organizationId);
    if (!ctx) throw new Error("Account not found");
    if (!ctx.client.deleteResource) throw new Error("Plugin does not support VM deletion");
    await ctx.client.deleteResource(row.resourceTypeId, vmResourceId, row.accountId);
  } catch (error) {
    if (!isNotFoundError(error)) {
      if (isRateLimitError(error)) return { kind: "rate-limited" };
      const message = error instanceof Error ? error.message : String(error);
      return { kind: "failed", message };
    }
  }
  await db.delete(resources).where(eq(resources.id, vmResourceId));
  return { kind: "deleted" };
}

/** Forget the in-memory verification state of a deleted session. */
export function forgetSession(id: string): void {
  agentVmVerifyBackoff.delete(id);
  agentSessionNotFoundStreak.delete(id);
}

/**
 * Which policy Authorize server installs: the organization's current one, so
 * re-running it is how an edited policy reaches an existing server. One that
 * no longer fits this server (it forbids the server's provider, or turns off
 * the T3 Connect it is reached through) is not installed; the server keeps
 * whatever it has, since applying it would leave it unable to start or
 * unreachable. The session records what was handed out.
 */
export async function authorizeT3Policy(
  row: SessionRow,
  organizationId: string,
  tool: AgentTool,
  access: ReturnType<typeof t3CodeAccessOrDefault>,
): Promise<{ policy?: T3CodePolicy | null }> {
  const current = await orgT3Policy(organizationId);
  if (current && !validateT3CodePolicy(current, { tool, access }).ok) return {};
  // The script restarts T3 Code after installing, so nothing is left pending.
  if (!sameT3CodePolicy(current, t3CodePolicyOrNull(row.t3Policy)) || row.t3PolicyRestartPending) {
    await db
      .update(agentSessions)
      .set({
        t3Policy: policyColumn(current),
        t3PolicyRestartPending: false,
        updatedAt: new Date(),
      })
      .where(eq(agentSessions.id, row.id));
  }
  return { policy: current };
}

export async function loadSession(id: string, organizationId: string) {
  const [row] = await db
    .select()
    .from(agentSessions)
    .where(and(eq(agentSessions.id, id), eq(agentSessions.organizationId, organizationId)))
    .limit(1);
  return row;
}

function rowToSession(row: SessionRow) {
  return {
    id: row.id,
    repo: row.repo,
    projectName: row.projectName,
    workspaceName: row.workspaceName,
    accountId: row.accountId,
    pluginId: row.pluginId,
    resourceTypeId: row.resourceTypeId,
    tool: row.tool,
    surface: agentSurfaceOrDefault(row.surface),
    serviceAccountIds: row.serviceAccountIds ?? [],
    t3Access: t3CodeAccessOrDefault(row.t3Access),
    t3Policy: t3CodePolicyOrNull(row.t3Policy),
    t3PolicyRestartPending: row.t3PolicyRestartPending,
    agentLinkId: row.agentLinkId ?? null,
    serviceInstalls: publicServiceInstalls(row.serviceInstallsJson),
    branchName: row.branchName,
    status: row.status,
    vmResourceId: row.vmResourceId,
    logs: row.logs ?? [],
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * The session as it stands, verified against the provider at most every few
 * seconds, or null when its VM is gone for good.
 */
export async function refreshAgentSession(
  row: SessionRow,
  organizationId: string,
): Promise<ReturnType<typeof rowToSession> | null> {
  if (!row.vmResourceId) return null;
  const [resource] = await db
    .select({ id: resources.id })
    .from(resources)
    .where(
      and(
        eq(resources.id, row.vmResourceId),
        eq(resources.organizationId, organizationId),
        isNull(resources.deletedAt),
      ),
    )
    .limit(1);
  if (!resource) return null;

  const now = Date.now();
  if (now < (agentVmVerifyBackoff.get(row.id) ?? 0)) return rowToSession(row);
  agentVmVerifyBackoff.set(row.id, now + AGENT_VM_VERIFY_INTERVAL_MS);

  const ctx = await getClientForAccount(row.accountId, organizationId).catch(() => null);
  if (!ctx || ctx.account.pluginId !== row.pluginId) return rowToSession(row);
  try {
    const liveResource = await ctx.client.getResource(
      row.resourceTypeId,
      row.vmResourceId,
      row.accountId,
    );
    agentSessionNotFoundStreak.delete(row.id);
    const vmStatus = agentVmStatus(ctx.plugin, row.resourceTypeId, liveResource);
    // Re-read the session so the derived status reflects logs the background
    // setup pipeline appended since `row` was loaded; a VM that reports "up"
    // stays "setting-up" until setup has recorded completion.
    const [latestRow] = await db
      .select()
      .from(agentSessions)
      .where(eq(agentSessions.id, row.id))
      .limit(1);
    const latest = latestRow ?? row;
    const status =
      latest.status === "failed" ? "failed" : setupAwareAgentStatus(latest.logs, vmStatus);
    await db
      .update(resources)
      .set({
        displayName: liveResource.displayName,
        externalId: liveResource.externalId ?? null,
        fieldsJson: liveResource.fields ?? {},
        outputsJson: liveResource.resolvedOutputs ?? {},
        parentResourceId: liveResource.parentResourceId ?? null,
        updatedAt: new Date(),
      })
      .where(eq(resources.id, liveResource.id));
    if (latest.status !== status) {
      await db
        .update(agentSessions)
        .set({ status, updatedAt: new Date() })
        .where(eq(agentSessions.id, row.id));
    }
    return rowToSession({ ...latest, status });
  } catch (error) {
    if (isNotFoundError(error)) {
      // Eventually-consistent providers can 404 right after VM creation; only delete the
      // session once it is past the creation grace period and the VM has been missing on
      // several consecutive polls.
      if (shouldDeleteMissingAgentSession(row.id, row.createdAt)) {
        agentSessionNotFoundStreak.delete(row.id);
        return null;
      }
      console.warn(`Agent VM ${row.vmResourceId} reported not found; keeping session for now`);
      return rowToSession(row);
    }
    agentSessionNotFoundStreak.delete(row.id);
    if (isRateLimitError(error)) {
      agentVmVerifyBackoff.set(row.id, Date.now() + AGENT_VM_RATE_LIMIT_COOLDOWN_MS);
    }
    console.warn(`Failed to verify agent VM ${row.vmResourceId}`, error);
    return rowToSession(row);
  }
}

function agentVmStatus(
  plugin: HostPlugin | null,
  resourceTypeId: string,
  resource: ResourceInstance,
): "setting-up" | "up" {
  const runningWhen = plugin?.resourceTypes.find((rt) => rt.id === resourceTypeId)?.sshEndpoint
    ?.runningWhen;
  if (!runningWhen) return "up";
  const fieldVal = String(resource.fields[runningWhen.fieldKey] ?? "");
  return fieldVal.toLowerCase() === runningWhen.value.toLowerCase() ? "up" : "setting-up";
}

function errorHttpStatus(error: unknown): number | null {
  if (!Predicate.isObject(error)) return null;
  const response = Predicate.hasProperty(error, "response") ? error.response : undefined;
  const metadata = Predicate.hasProperty(error, "$metadata") ? error.$metadata : undefined;
  const candidates = [
    Predicate.hasProperty(error, "status") ? error.status : undefined,
    Predicate.hasProperty(error, "statusCode") ? error.statusCode : undefined,
    Predicate.hasProperty(response, "status") ? response.status : undefined,
    Predicate.hasProperty(metadata, "httpStatusCode") ? metadata.httpStatusCode : undefined,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "number" && Number.isInteger(candidate)) return candidate;
  }
  return null;
}

function isNotFoundError(error: unknown): boolean {
  const status = errorHttpStatus(error);
  if (status !== null) return status === 404;
  const message = error instanceof Error ? error.message : String(error);
  // Plugin HTTP helpers throw plain errors shaped "<vendor> API error <status> for <label>: ..."
  // and plugin clients throw "... resource <type>/<id> not found". Match only those shapes so
  // unrelated errors that merely mention "404" or "not found" are not treated as deletions.
  return /\bAPI error 404\b/.test(message) || /\bresource\b[^\n]*\bnot found\b/i.test(message);
}

function isRateLimitError(error: unknown): boolean {
  if (errorHttpStatus(error) === 429) return true;
  // Plugin HTTP helpers throw plain errors shaped "<vendor> API error <status> for <label>: ...".
  const message = error instanceof Error ? error.message : String(error);
  return /\bAPI error 429\b/.test(message);
}

function shouldDeleteMissingAgentSession(sessionId: string, createdAt: Date): boolean {
  const misses = (agentSessionNotFoundStreak.get(sessionId) ?? 0) + 1;
  agentSessionNotFoundStreak.set(sessionId, misses);
  const withinGrace = Date.now() - createdAt.getTime() < AGENT_SESSION_DELETE_GRACE_MS;
  return !withinGrace && misses >= AGENT_SESSION_NOT_FOUND_DELETE_THRESHOLD;
}

function agentDefaultFields(agentVm: AgentVmCapability) {
  return { ...(agentVm.linuxImageDefaults ?? {}), ...(agentVm.defaultFields ?? {}) };
}

async function agentCreateFields(
  client: HostPluginClient | undefined,
  resourceTypeId: string,
  agentVm: AgentVmCapability,
): Promise<CreateFieldConfig[]> {
  if (!client?.getCreateConfig) return [];
  try {
    const config = await client.getCreateConfig(resourceTypeId);
    const defaultKeys = new Set(Object.keys(agentDefaultFields(agentVm)));
    const hiddenKeys = new Set(agentVm.hiddenFieldKeys ?? [agentVm.sshKeyFieldKey]);
    return config.fields.filter(
      (field) => defaultKeys.has(field.key) && !hiddenKeys.has(field.key) && !field.hidden,
    );
  } catch (error) {
    console.warn(`Failed to load agent create fields for ${resourceTypeId}`, error);
    return [];
  }
}

async function withAgentSshKey(
  plugin: HostPlugin,
  resourceTypeId: string,
  fields: Record<string, string>,
  organizationId: string,
  userId: string,
): Promise<Record<string, string>> {
  const resourceType = plugin.resourceTypes.find((rt) => rt.id === resourceTypeId);
  const keyField = resourceType?.agentVm?.sshKeyFieldKey;
  if (!keyField) return fields;
  if (fields[keyField]?.trim()) return fields;
  const key = await ensureOrgAgentSshKey(organizationId, userId);
  return { ...fields, [keyField]: key.publicKey };
}

/** The organization's agent SSH key, generated and stored the first time. */
export async function ensureOrgAgentSshKey(
  organizationId: string,
  userId: string,
): Promise<{ id: string; name: string; publicKey: string }> {
  const [existing] = await db
    .select({
      id: sshKeys.id,
      name: sshKeys.name,
      encryptedPublicKey: sshKeys.encryptedPublicKey,
      publicKeyIv: sshKeys.publicKeyIv,
    })
    .from(sshKeys)
    .where(and(eq(sshKeys.organizationId, organizationId), eq(sshKeys.name, AGENT_SSH_KEY_NAME)))
    .limit(1);
  if (existing) {
    const publicKey = await decrypt(
      existing.encryptedPublicKey,
      existing.publicKeyIv,
      buildAad("sshKey", existing.id, "publicKey"),
    );
    return { id: existing.id, name: existing.name, publicKey };
  }

  const { publicKey, privateKey } = await generateEd25519OpenSshKeyPair(AGENT_SSH_KEY_NAME);
  const id = randomUUID();
  const encPub = await encrypt(publicKey, buildAad("sshKey", id, "publicKey"));
  const encPriv = await encrypt(privateKey, buildAad("sshKey", id, "privateKey"));
  await db.insert(sshKeys).values({
    id,
    organizationId,
    userId,
    name: AGENT_SSH_KEY_NAME,
    encryptedPublicKey: encPub.ciphertext,
    publicKeyIv: encPub.iv,
    encryptedPrivateKey: encPriv.ciphertext,
    privateKeyIv: encPriv.iv,
    keyType: "ssh-ed25519",
    isImported: false,
    fingerprint: computeSshPublicKeyFingerprint(publicKey),
  });
  return { id, name: AGENT_SSH_KEY_NAME, publicKey };
}

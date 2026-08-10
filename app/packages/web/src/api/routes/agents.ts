import { Hono } from "hono";
import { and, desc, eq, isNull } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import {
  computeSshPublicKeyFingerprint,
  generateEd25519OpenSshKeyPair,
} from "@infrawrench/ssh-tunnel-core";
import type {
  AgentVmCapability,
  CreateFieldConfig,
  Plugin,
  PluginClient,
  ResourceInstance,
} from "@infrawrench/plugin-base";
import { normalizeResourceCreateResult } from "@infrawrench/plugin-base";
import type { AgentSurface, AgentTool } from "@infrawrench/ui/agents";
import { buildAgentLaunchCommand, isCloneableGitRepo } from "@infrawrench/ui/agents/launch-command";
import {
  agentSurfaceOrDefault,
  agentSurfaceRequiresRepo,
  buildT3CodeConnectCommand,
  isT3CodeSurface,
  T3_CODE_PROJECTS_DIR,
} from "@infrawrench/ui/agents/t3-code";

import { db } from "../../db/client";
import { accounts, agentSessions, agentSettings, resources, sshKeys } from "../../db/schema";
import { loadPlugins } from "../../plugins/loader";
import { requirePermission } from "../../auth/permissions";
import { getClientForAccount } from "../../services/plugin-clients";
import { buildAad, decrypt, encrypt } from "../../services/encryption";
import { upsertCreatedResource } from "@infrawrench/server-core/created-resource";
import { createT3CodeSetupPlan } from "@infrawrench/ui/agents/t3-code";
import {
  createAgentSetupPlanForRepo,
  ensureAgentVmSetupForSession,
  hasAgentSetupComplete,
  maybeAutoResumeAgentSetup,
  scheduleAgentVmSetup,
  revokeT3CodeLinkOnVm,
  setupAwareAgentStatus,
  setupPlanLogLines,
} from "../../services/agent-setup";

const app = new Hono();
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

function orgId(c: { get(key: "organizationId"): string }) {
  return c.get("organizationId");
}

function branchName(id: string): string {
  return `infrawrench/agent-${id.slice(0, 8)}`;
}

function projectNameFromRepo(repo: string): string {
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

app.get("/accounts", async (c) => {
  requirePermission(c, "accounts:read");
  const organizationId = orgId(c);
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
  return c.json(out);
});

app.get("/settings", async (c) => {
  requirePermission(c, "accounts:read");
  const [row] = await db
    .select()
    .from(agentSettings)
    .where(eq(agentSettings.organizationId, orgId(c)))
    .limit(1);
  if (!row) return c.json(null);
  return c.json({
    accountId: row.accountId,
    pluginId: row.pluginId,
    resourceTypeId: row.resourceTypeId,
    tool: row.tool,
    surface: agentSurfaceOrDefault(row.surface),
    fields: row.fieldsJson,
  });
});

app.put("/settings", async (c) => {
  requirePermission(c, "accounts:write");
  const organizationId = orgId(c);
  const body = await c.req.json<{
    accountId: string;
    pluginId: string;
    resourceTypeId: string;
    tool: string;
    surface?: string;
    fields: Record<string, string>;
  }>();
  const id = `${organizationId}:default`;
  const surface = agentSurfaceOrDefault(body.surface);
  const values = {
    accountId: body.accountId,
    pluginId: body.pluginId,
    resourceTypeId: body.resourceTypeId,
    tool: body.tool,
    surface,
    fieldsJson: body.fields ?? {},
    updatedAt: new Date(),
  };
  await db
    .insert(agentSettings)
    .values({ id, organizationId, ...values })
    .onConflictDoUpdate({ target: agentSettings.id, set: values });
  return c.json({ ...body, surface });
});

app.get("/sessions", async (c) => {
  requirePermission(c, "resources:read");
  const organizationId = orgId(c);
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
      await db.delete(agentSessions).where(eq(agentSessions.id, row.id));
    }
  }
  return c.json(out);
});

app.post("/sessions", async (c) => {
  requirePermission(c, "resources:write");
  const organizationId = orgId(c);
  const { userId } = c.get("session");
  const body = await c.req.json<{
    repo?: string;
    projectName?: string;
    workspaceName?: string;
    settings: {
      accountId: string;
      pluginId: string;
      resourceTypeId: string;
      tool: string;
      surface?: string;
      fields: Record<string, string>;
    };
  }>();
  const tool: AgentTool = body.settings.tool === "claude-code" ? "claude-code" : "codex";
  const surface: AgentSurface = agentSurfaceOrDefault(body.settings.surface);
  const repo = body.repo?.trim() ?? "";
  // T3 Code servers manage their own projects, so they are provisioned
  // without a repository; every other surface still requires one.
  if (agentSurfaceRequiresRepo(surface)) {
    if (!repo) return c.json({ error: "repo is required" }, 400);
    // Web sessions have no local-folder upload path; the repo is cloned on the
    // VM during setup, so it must be a URL Git can clone.
    if (!isCloneableGitRepo(repo)) {
      return c.json(
        { error: "repo must be a cloneable Git URL (https://, ssh://, git://, or git@host:path)" },
        400,
      );
    }
  }
  const id = randomUUID();
  const isT3Code = isT3CodeSurface(surface);
  const projectName =
    body.projectName?.trim() || (repo ? projectNameFromRepo(repo) : "") || "t3-code";
  const workspaceName = isT3Code
    ? T3_CODE_PROJECTS_DIR
    : body.workspaceName?.trim() || projectNameFromRepo(repo) || projectName;
  const setupPlan = isT3Code
    ? createT3CodeSetupPlan(tool)
    : createAgentSetupPlanForRepo(repo, tool, workspaceName);
  const logs = [
    isT3Code ? "T3 Code server session created." : "Agent session created.",
    "Setup policy: conservative detection.",
    ...setupPlanLogLines(setupPlan),
    "Provisioning VM with selected provider defaults.",
  ];

  let resource;
  let warnings;
  let plugin: Plugin | null = null;
  try {
    const ctx = await getClientForAccount(body.settings.accountId, organizationId);
    if (!ctx) throw new Error("Account not found");
    if (ctx.account.pluginId !== body.settings.pluginId) {
      throw new Error("Selected account does not match the requested provider");
    }
    if (!ctx.client.createResource) throw new Error("Plugin does not support VM creation");
    const fields = await withAgentSshKey(
      ctx.plugin,
      body.settings.resourceTypeId,
      body.settings.fields,
      organizationId,
      userId,
    );

    const createReturn = await ctx.client.createResource(
      body.settings.resourceTypeId,
      body.settings.accountId,
      {
        name: cloudResourceName(projectName),
        ...fields,
      },
    );
    ({ resource, warnings } = normalizeResourceCreateResult(createReturn));
    plugin = ctx.plugin;
  } catch (error) {
    const message = error instanceof Error ? error.message : "VM provisioning failed";
    return c.json({ error: `VM provisioning failed: ${message}` }, 400);
  }

  await upsertCreatedResource({
    organizationId,
    pluginId: resource.pluginId,
    resourceTypeId: resource.resourceTypeId,
    accountId: resource.accountId,
    resource,
  });
  const updatedLogs = [
    ...logs,
    `VM created: ${resource.displayName} (${resource.id}).`,
    ...warnings.map((warning) => `Warning: ${warning.message}`),
    "Waiting for VM to report ready.",
  ];
  const initialStatus = setupAwareAgentStatus(
    updatedLogs,
    agentVmStatus(plugin, body.settings.resourceTypeId, resource),
  );
  await db.insert(agentSessions).values({
    id,
    organizationId,
    repo,
    projectName,
    workspaceName,
    accountId: body.settings.accountId,
    pluginId: body.settings.pluginId,
    resourceTypeId: body.settings.resourceTypeId,
    tool,
    surface,
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
  return c.json(rowToSession(created!), 201);
});

app.post("/sessions/:id/open", async (c) => {
  requirePermission(c, "resources:execute");
  const organizationId = orgId(c);
  const row = await loadSession(c.req.param("id"), organizationId);
  if (!row) return c.json({ error: "Not found" }, 404);
  if (!(await refreshAgentSession(row, organizationId))) {
    await db.delete(agentSessions).where(eq(agentSessions.id, row.id));
    return c.json({ error: "Agent VM no longer exists" }, 404);
  }
  const agentKey = await ensureOrgAgentSshKey(organizationId, c.get("session").userId);
  // Mirror the desktop client: only when setup never completed do we (re)kick
  // the full setup and hand out a launch-ready token for the launch command to
  // wait on. Re-running setup on a completed session would be redundant, and
  // an absent token makes the launch script skip the marker wait entirely.
  const setupComplete = hasAgentSetupComplete(row.logs);
  const launchReadyToken = setupComplete ? undefined : randomUUID();
  void ensureAgentVmSetupForSession(row.id, organizationId, {
    forceSync: !setupComplete,
    ...(launchReadyToken ? { launchReadyToken } : {}),
  }).catch((error) => {
    console.warn(`Agent VM setup failed for ${row.id}`, error);
  });
  const tool: AgentTool = row.tool === "claude-code" ? "claude-code" : "codex";
  // A T3 Code session's terminal is the one-off authorization flow, not an
  // attached agent: T3 Code itself runs the agent, and its own tab is the
  // session's main surface. There is no launch-ready marker to wait on
  // because nothing is being attached.
  if (isT3CodeSurface(row.surface)) {
    return c.json({
      command: buildT3CodeConnectCommand({ tool }),
      cwd: `~/${row.workspaceName}`,
      sshKeyId: agentKey.id,
      sshKeyName: agentKey.name,
    });
  }
  return c.json({
    command: buildAgentLaunchCommand({
      sessionId: row.id,
      tool,
      workspaceName: row.workspaceName,
      ...(launchReadyToken ? { launchReadyToken } : {}),
    }),
    cwd: `~/${row.workspaceName}`,
    sshKeyId: agentKey.id,
    sshKeyName: agentKey.name,
  });
});

app.delete("/sessions/:id", async (c) => {
  requirePermission(c, "resources:delete");
  const organizationId = orgId(c);
  const row = await loadSession(c.req.param("id"), organizationId);
  if (!row) return c.json({ error: "Not found" }, 404);
  // Revoke the relay link while the VM still exists — afterwards there is no
  // way to remove the environment from T3's side. Best effort: an unreachable
  // VM must not block deletion of a machine that is still billing.
  if (isT3CodeSurface(row.surface)) {
    await revokeT3CodeLinkOnVm(row.id, organizationId);
  }
  if (row.vmResourceId) {
    const [resourceRow] = await db
      .select({ id: resources.id })
      .from(resources)
      .where(and(eq(resources.id, row.vmResourceId), isNull(resources.deletedAt)))
      .limit(1);
    if (resourceRow) {
      try {
        const ctx = await getClientForAccount(row.accountId, organizationId);
        if (!ctx) throw new Error("Account not found");
        if (!ctx.client.deleteResource) throw new Error("Plugin does not support VM deletion");
        await ctx.client.deleteResource(row.resourceTypeId, row.vmResourceId, row.accountId);
      } catch (error) {
        // Already gone upstream is success for a delete; anything else must
        // abort so we don't orphan a still-billing VM silently.
        if (!isNotFoundError(error)) {
          if (isRateLimitError(error)) {
            return c.json(
              {
                error:
                  "The provider is rate-limiting API requests — try deleting again in a minute.",
              },
              429,
            );
          }
          const message = error instanceof Error ? error.message : String(error);
          return c.json({ error: `Could not delete the agent VM: ${message}` }, 502);
        }
      }
      await db.delete(resources).where(eq(resources.id, row.vmResourceId));
    }
  }
  await db.delete(agentSessions).where(eq(agentSessions.id, row.id));
  agentVmVerifyBackoff.delete(row.id);
  agentSessionNotFoundStreak.delete(row.id);
  return c.json({ ok: true });
});

app.post("/sessions/:id/reconcile", async (c) => {
  requirePermission(c, "resources:execute");
  const organizationId = orgId(c);
  const row = await loadSession(c.req.param("id"), organizationId);
  if (!row) return c.json({ error: "Not found" }, 404);
  if (!(await refreshAgentSession(row, organizationId))) {
    await db.delete(agentSessions).where(eq(agentSessions.id, row.id));
    return c.json({ error: "Agent VM no longer exists" }, 404);
  }
  if (isT3CodeSurface(row.surface)) {
    return c.json({
      branchName: row.branchName,
      message:
        "T3 Code owns this server's projects and their branches — push from inside T3 Code. Infrawrench has nothing to reconcile.",
    });
  }
  return c.json({
    branchName: row.branchName,
    // Web sessions clone from a Git URL on the VM; there is no local checkout
    // to fetch into, so reconciling means pushing from the VM itself.
    message: `Open the agent terminal and push ${row.branchName} from the VM to your Git remote to reconcile this agent's work.`,
  });
});

async function loadSession(id: string, organizationId: string) {
  const [row] = await db
    .select()
    .from(agentSessions)
    .where(and(eq(agentSessions.id, id), eq(agentSessions.organizationId, organizationId)))
    .limit(1);
  return row;
}

function rowToSession(row: typeof agentSessions.$inferSelect) {
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
    branchName: row.branchName,
    status: row.status,
    vmResourceId: row.vmResourceId,
    logs: row.logs ?? [],
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function refreshAgentSession(
  row: typeof agentSessions.$inferSelect,
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
  plugin: Plugin | null,
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
  if (!error || typeof error !== "object") return null;
  const candidates = [
    (error as { status?: unknown }).status,
    (error as { statusCode?: unknown }).statusCode,
    (error as { response?: { status?: unknown } }).response?.status,
    (error as { $metadata?: { httpStatusCode?: unknown } }).$metadata?.httpStatusCode,
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
  client: PluginClient | undefined,
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
  plugin: Plugin,
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

async function ensureOrgAgentSshKey(
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

export default app;

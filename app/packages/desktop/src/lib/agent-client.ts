import type {
  AgentClient,
  AgentCreateBody,
  AgentSession,
  AgentSettings,
  AgentSetupPlan,
  AgentSshTarget,
  AgentVmAccount,
} from "@infrawrench/ui/agents";
import {
  AGENT_ENV_REMOTE_PATH,
  AGENT_SETUP_FAILED_LOG_PREFIX,
  AGENT_SETUP_STEP_PREFIX,
  buildAgentBootstrapCommand,
  buildAgentEnvFile,
  buildAgentLaunchCommand,
  buildAgentRepoSetupCommand,
  resolveAgentEnvTemplate,
} from "@infrawrench/ui/agents";
import { dispatchResourcesChanged } from "@infrawrench/ui";
import type {
  AgentVmCapability,
  CreateFieldConfig,
  PluginClient,
  ResourceInstance,
  ResourceTypeDefinition,
} from "@infrawrench/plugin-base";
import { normalizeResourceCreateResult } from "@infrawrench/plugin-base";

import { getDb } from "../db/client";
import { loadPlugins } from "../plugins/loader";
import { invoke } from "./invoke";
import { createPluginClient } from "./plugin-client";

const AGENT_SSH_KEY_NAME = "infrawrench-agent";
const AGENT_SETUP_STARTED_LOG = "Preparing VM for coding session.";
const AGENT_SETUP_WAIT_SSH_LOG = "Waiting for VM SSH to become available.";
const AGENT_SETUP_BOOTSTRAP_LOG = "Installing coding tools and preparing workspace.";
const AGENT_SETUP_REFRESH_LOG = "Refreshing agent workspace and tool configuration.";
const AGENT_SETUP_COMPLETE_LOG = "Agent VM setup complete.";
// Must exceed the bootstrap's own remote `timeout 420s` so a slow first
// attempt still leaves budget for retries; the launch command waits 900s.
const AGENT_SETUP_TIMEOUT_MS = 15 * 60 * 1000;
const AGENT_SYNC_TIMEOUT_MS = 10 * 60 * 1000;
const AGENT_SETUP_RETRY_MS = 5 * 1000;
const AGENT_SESSION_DELETE_GRACE_MS = 15 * 60 * 1000;
const AGENT_SESSION_NOT_FOUND_DELETE_THRESHOLD = 3;

const agentSetupInflight = new Map<string, { promise: Promise<void>; forceSync: boolean }>();
const agentSetupAutoResumeAttempted = new Set<string>();
const agentSessionNotFoundStreak = new Map<string, number>();

interface AccountRow {
  id: string;
  plugin_id: string;
  display_name: string;
}

interface SettingsRow {
  account_id: string;
  plugin_id: string;
  resource_type_id: string;
  tool: "codex" | "claude-code";
  fields_json: string;
}

interface SessionRow {
  id: string;
  repo: string;
  project_name: string;
  workspace_name: string | null;
  account_id: string;
  plugin_id: string;
  resource_type_id: string;
  tool: "codex" | "claude-code";
  branch_name: string;
  status: AgentSession["status"];
  vm_resource_id: string | null;
  logs_json: string;
  setup_plan_json: string;
  setup_env_json: string;
  created_resources_json: string;
  created_at: string;
  updated_at: string;
}

interface CreatedResourceRef {
  id: string;
  pluginId: string;
  resourceTypeId: string;
  accountId: string;
}

interface ResourceRow {
  id: string;
}

interface AgentSyncFilesResult {
  repoFiles: number;
  configFiles: number;
  warnings: string[];
}

interface AgentSetupOutputLogger {
  onData(text: string): Promise<void>;
  flush(): Promise<void>;
}

function parseJson<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
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

function rowToSession(row: SessionRow): AgentSession {
  return {
    id: row.id,
    repo: row.repo,
    projectName: row.project_name,
    workspaceName: workspaceNameForRow(row),
    accountId: row.account_id,
    pluginId: row.plugin_id,
    resourceTypeId: row.resource_type_id,
    tool: row.tool,
    branchName: row.branch_name,
    status: row.status,
    vmResourceId: row.vm_resource_id,
    logs: parseJson<string[]>(row.logs_json, []),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createDesktopAgentClient(): AgentClient {
  return {
    async listAccounts(): Promise<AgentVmAccount[]> {
      const db = await getDb();
      const [plugins, accounts] = await Promise.all([
        loadPlugins(),
        db.select<AccountRow[]>(
          "SELECT id, plugin_id, display_name FROM accounts WHERE deleted_at IS NULL ORDER BY display_name",
        ),
      ]);
      const byPlugin = new Map(plugins.map((p) => [p.plugin.manifest.id, p.plugin]));
      const out: AgentVmAccount[] = [];
      for (const account of accounts) {
        const plugin = byPlugin.get(account.plugin_id);
        if (!plugin) continue;
        const client = await createPluginClient(account.id, account.plugin_id).catch(() => null);
        for (const rt of plugin.resourceTypes) {
          if (!rt.agentVm || !rt.supportsCreate || !rt.sshEndpoint) continue;
          out.push({
            accountId: account.id,
            accountName: account.display_name,
            pluginId: account.plugin_id,
            pluginName: plugin.manifest.displayName,
            pluginLogoSvg: plugin.manifest.logoSvg,
            resourceTypeId: rt.id,
            resourceTypeName: rt.displayName,
            defaultUsername: rt.agentVm.defaultUsername,
            defaultFields: agentDefaultFields(rt.agentVm),
            defaultFieldLabels: rt.agentVm.defaultFieldLabels ?? {},
            createFields: await agentCreateFields(client, rt.id, rt.agentVm),
            hiddenFieldKeys: rt.agentVm.hiddenFieldKeys ?? [rt.agentVm.sshKeyFieldKey],
          });
        }
      }
      return out;
    },
    async getSettings(): Promise<AgentSettings | null> {
      const db = await getDb();
      const rows = await db.select<SettingsRow[]>("SELECT * FROM agent_settings LIMIT 1");
      const row = rows[0];
      if (!row) return null;
      return {
        accountId: row.account_id,
        pluginId: row.plugin_id,
        resourceTypeId: row.resource_type_id,
        tool: row.tool,
        fields: parseJson<Record<string, string>>(row.fields_json, {}),
      };
    },
    async saveSettings(settings: AgentSettings): Promise<AgentSettings> {
      const db = await getDb();
      await db.execute(
        `INSERT OR REPLACE INTO agent_settings
         (id, account_id, plugin_id, resource_type_id, tool, fields_json, updated_at)
         VALUES ('default', $1, $2, $3, $4, $5, datetime('now'))`,
        [
          settings.accountId,
          settings.pluginId,
          settings.resourceTypeId,
          settings.tool,
          JSON.stringify(settings.fields),
        ],
      );
      return settings;
    },
    async pickLocalRepoPath(): Promise<string | null> {
      const result = await invoke<{ canceled?: boolean; filePaths?: string[] }>(
        "show_open_dialog",
        {
          properties: ["openDirectory"],
          title: "Choose local repository",
        },
      );
      if (result.canceled) return null;
      return result.filePaths?.[0] ?? null;
    },
    async listSessions(): Promise<AgentSession[]> {
      const db = await getDb();
      const rows = await db.select<SessionRow[]>(
        "SELECT * FROM agent_sessions ORDER BY created_at DESC",
      );
      const out: AgentSession[] = [];
      for (const row of rows) {
        const refreshed = await refreshAgentSession(row);
        if (refreshed) {
          out.push(refreshed);
          maybeAutoResumeAgentSetup(row);
        } else {
          await db.execute("DELETE FROM agent_sessions WHERE id = $1", [row.id]);
        }
      }
      return out;
    },
    async createSession(body: AgentCreateBody): Promise<AgentSession> {
      const db = await getDb();
      const id = crypto.randomUUID();
      const projectName = body.projectName?.trim() || projectNameFromRepo(body.repo);
      const workspaceName =
        body.workspaceName?.trim() || projectNameFromRepo(body.repo) || projectName;
      const setupPlan = await createAgentSetupPlan(
        body.repo,
        body.settings.tool,
        workspaceName,
      ).catch((error) => {
        throw new Error(`Agent setup plan failed: ${formatErrorMessage(error)}`);
      });
      const logs = [
        "Agent session created.",
        "Setup policy: conservative detection.",
        ...setupPlanLogLines(setupPlan),
        "Provisioning VM with selected provider defaults.",
      ];

      let resource;
      let warnings;
      try {
        const client = await createPluginClient(body.settings.accountId, body.settings.pluginId);
        if (!client.createResource) throw new Error("Plugin does not support VM creation");
        const fields = await withAgentSshKey(
          body.settings.pluginId,
          body.settings.resourceTypeId,
          body.settings.fields,
        );
        const createReturn = await client.createResource(
          body.settings.resourceTypeId,
          body.settings.accountId,
          {
            name: cloudResourceName(projectName),
            ...fields,
          },
        );
        ({ resource, warnings } = normalizeResourceCreateResult(createReturn));
      } catch (error) {
        const message = error instanceof Error ? error.message : "VM provisioning failed";
        throw new Error(`VM provisioning failed: ${message}`);
      }

      await db.execute(
        `INSERT OR REPLACE INTO resources
         (id, plugin_id, resource_type_id, account_id, display_name, external_id, fields_json, outputs_json, parent_resource_id, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, datetime('now'))`,
        [
          resource.id,
          resource.pluginId,
          resource.resourceTypeId,
          resource.accountId,
          resource.displayName,
          resource.externalId ?? resource.id,
          JSON.stringify(resource.fields ?? {}),
          JSON.stringify(resource.resolvedOutputs ?? {}),
          resource.parentResourceId ?? null,
        ],
      );
      const updatedLogs = [
        ...logs,
        `VM created: ${resource.displayName} (${resource.id}).`,
        ...warnings.map((warning) => `Warning: ${warning.message}`),
        "Waiting for VM to report ready.",
      ];
      const initialVmStatus = await agentVmStatus(
        body.settings.pluginId,
        body.settings.resourceTypeId,
        resource,
      );
      const initialStatus = setupAwareStatusFromLogs(updatedLogs, initialVmStatus);
      await db.execute(
        `INSERT INTO agent_sessions
         (id, repo, project_name, workspace_name, account_id, plugin_id, resource_type_id, tool, branch_name, status, vm_resource_id, logs_json, setup_plan_json)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
        [
          id,
          body.repo.trim(),
          projectName,
          workspaceName,
          body.settings.accountId,
          body.settings.pluginId,
          body.settings.resourceTypeId,
          body.settings.tool,
          branchName(id),
          initialStatus,
          resource.id,
          JSON.stringify(updatedLogs),
          JSON.stringify(setupPlan),
        ],
      );
      // Resources declared by .infrawrench/agent.json (e.g. a db branch).
      // Created ONCE here, not in the retryable setup pipeline — resource
      // creation is not idempotent. A failure marks the session failed so
      // the user sees it and Delete cleans up whatever was created.
      try {
        await createRepoConfigResources(db, id, setupPlan.repoConfig);
      } catch (error) {
        await appendAgentSessionLog(
          db,
          id,
          `${AGENT_SETUP_FAILED_LOG_PREFIX} ${formatErrorMessage(error)}`,
          "failed",
        );
        const failedRows = await db.select<SessionRow[]>(
          "SELECT * FROM agent_sessions WHERE id = $1",
          [id],
        );
        return rowToSession(failedRows[0]!);
      }
      scheduleAgentVmSetup(id);

      const rows = await db.select<SessionRow[]>("SELECT * FROM agent_sessions WHERE id = $1", [
        id,
      ]);
      return rowToSession(rows[0]!);
    },
    async openSession(id: string) {
      const db = await getDb();
      const rows = await db.select<SessionRow[]>("SELECT * FROM agent_sessions WHERE id = $1", [
        id,
      ]);
      const row = rows[0];
      if (!row) throw new Error("Agent session not found");
      if (!row.vm_resource_id) throw new Error("Agent session has no VM");
      const resourceRows = await db.select<ResourceRow[]>(
        "SELECT id FROM resources WHERE id = $1 AND deleted_at IS NULL LIMIT 1",
        [row.vm_resource_id],
      );
      if (!resourceRows[0]) {
        await db.execute("DELETE FROM agent_sessions WHERE id = $1", [id]);
        throw new Error("Agent VM no longer exists");
      }
      const agentKey = await ensureAgentSshKey();
      // Only run the full setup (repo upload + tool config sync) when the session has
      // never completed setup. Re-running it on reopen would wipe the remote workspace
      // (including the agent's branch commits) out from under a live screen session.
      const setupComplete = hasAgentSetupComplete(row);
      const launchReadyToken = setupComplete ? undefined : crypto.randomUUID();
      void ensureAgentVmSetupForSession(id, agentKey, {
        forceSync: !setupComplete,
        ...(launchReadyToken ? { launchReadyToken } : {}),
      }).catch((error) => {
        console.warn(`Agent VM setup failed for ${id}`, error);
      });
      return {
        command: buildAgentLaunchCommand({
          sessionId: row.id,
          tool: row.tool,
          workspaceName: workspaceNameForRow(row),
          ...(launchReadyToken ? { launchReadyToken } : {}),
        }),
        cwd: `~/${workspaceNameForRow(row)}`,
        sshKeyId: agentKey.id,
        sshKeyName: agentKey.name,
      };
    },
    async reconcileSession(id: string) {
      const db = await getDb();
      const rows = await db.select<SessionRow[]>("SELECT * FROM agent_sessions WHERE id = $1", [
        id,
      ]);
      const row = rows[0];
      if (!row) throw new Error("Agent session not found");
      if (!(await refreshAgentSession(row))) {
        await db.execute("DELETE FROM agent_sessions WHERE id = $1", [id]);
        throw new Error("Agent VM no longer exists");
      }
      // Git-URL sessions have no local checkout to fetch into — reconciling
      // means pushing from the VM (it cloned the remote, so it has origin).
      if (isCloneableGitRepo(row.repo)) {
        return {
          branchName: row.branch_name,
          message: `This session was cloned from a Git URL — open the agent terminal and push ${row.branch_name} from the VM (the local app has no checkout to fetch into).`,
        };
      }
      const agentKey = await ensureAgentSshKey();
      const privateKey = await invoke<string>("ssh_key_get_private_key", { keyId: agentKey.id });
      const resource = await loadAgentVmResource(row);
      const target = await resolveAgentSshTarget(row, resource);
      const result = await invoke<{ message: string }>("agent_reconcile_fetch", {
        config: {
          sshHost: target.host,
          sshPort: target.port,
          sshUser: target.username,
          privateKey,
        },
        workspaceName: workspaceNameForRow(row),
        branchName: row.branch_name,
        repoPath: row.repo,
      });
      return { branchName: row.branch_name, message: result.message };
    },
    async deleteSession(id: string) {
      const db = await getDb();
      const rows = await db.select<SessionRow[]>("SELECT * FROM agent_sessions WHERE id = $1", [
        id,
      ]);
      const row = rows[0];
      if (!row) return;
      // Resources created from .infrawrench/agent.json (db branches etc.)
      // go first — same rule as the VM: gone upstream is success, any other
      // failure aborts so nothing keeps billing silently.
      const createdRefs = parseJson<CreatedResourceRef[]>(row.created_resources_json ?? "[]", []);
      for (const ref of createdRefs) {
        try {
          const client = await createPluginClient(ref.accountId, ref.pluginId);
          if (client.deleteResource) {
            await client.deleteResource(ref.resourceTypeId, ref.id, ref.accountId);
          }
        } catch (error) {
          if (!isNotFoundError(error)) {
            throw new Error(
              `Could not delete ${ref.pluginId}/${ref.resourceTypeId} created for this agent: ${formatErrorMessage(error)}`,
            );
          }
        }
        await db.execute("DELETE FROM dashboard_pins WHERE resource_id = $1", [ref.id]);
        await db.execute("DELETE FROM resources WHERE id = $1", [ref.id]);
        // Checkpoint so a later failure doesn't retry already-deleted ones.
        const remaining = createdRefs.slice(createdRefs.indexOf(ref) + 1);
        await db.execute("UPDATE agent_sessions SET created_resources_json = $1 WHERE id = $2", [
          JSON.stringify(remaining),
          id,
        ]);
        dispatchResourcesChanged({ accountId: ref.accountId, resourceTypeId: ref.resourceTypeId });
      }
      if (row.vm_resource_id) {
        const resourceRows = await db.select<ResourceRow[]>(
          "SELECT id FROM resources WHERE id = $1 AND deleted_at IS NULL LIMIT 1",
          [row.vm_resource_id],
        );
        if (resourceRows[0]) {
          try {
            const client = await createPluginClient(row.account_id, row.plugin_id);
            if (!client.deleteResource) throw new Error("Plugin does not support VM deletion");
            await client.deleteResource(row.resource_type_id, row.vm_resource_id, row.account_id);
          } catch (error) {
            // Already gone upstream is success for a delete; anything else
            // must abort so we don't orphan a still-billing VM silently.
            if (!isNotFoundError(error)) {
              throw new Error(`Could not delete the agent VM: ${formatErrorMessage(error)}`);
            }
          }
          await db.execute("DELETE FROM dashboard_pins WHERE resource_id = $1", [
            row.vm_resource_id,
          ]);
          await db.execute("DELETE FROM resources WHERE id = $1", [row.vm_resource_id]);
          dispatchResourcesChanged({
            accountId: row.account_id,
            resourceTypeId: row.resource_type_id,
          });
        }
      }
      await db.execute("DELETE FROM agent_sessions WHERE id = $1", [id]);
    },
  };
}

async function withAgentSshKey(
  pluginId: string,
  resourceTypeId: string,
  fields: Record<string, string>,
): Promise<Record<string, string>> {
  const plugins = await loadPlugins();
  const plugin = plugins.find((p) => p.plugin.manifest.id === pluginId)?.plugin;
  const resourceType = plugin?.resourceTypes.find((rt) => rt.id === resourceTypeId);
  const keyField = resourceType?.agentVm?.sshKeyFieldKey;
  if (!keyField) return fields;
  if (fields[keyField]?.trim()) return fields;

  const key = await invoke<{ id: string; name: string; publicKey: string }>(
    "ssh_key_ensure_agent_key",
  );
  const publicKey = key.publicKey.trim();
  if (!publicKey) throw new Error(`Agent SSH key "${AGENT_SSH_KEY_NAME}" has no public key`);
  return { ...fields, [keyField]: publicKey };
}

async function ensureAgentSshKey() {
  return invoke<{ id: string; name: string; publicKey: string }>("ssh_key_ensure_agent_key");
}

async function createAgentSetupPlan(
  repo: string,
  tool: AgentSettings["tool"],
  workspaceName: string,
): Promise<AgentSetupPlan> {
  if (isCloneableGitRepo(repo)) {
    return {
      source: "git-url",
      workspaceName,
      initialCloneUrl: repo,
      runtimes: [
        {
          language: "node",
          version: "latest",
          versionSource: "latest",
          source: "mise latest resolver at setup time",
          reasons: [`${toolLabel(tool)} requires Node for its CLI package`],
        },
      ],
      packageManagers: [],
      configSources: [],
      warnings: [
        "Git URL sessions are cloned on the VM, so project runtime detection is deferred until the repository is available remotely.",
      ],
    };
  }

  return invoke<AgentSetupPlan>("agent_plan_setup", {
    repoPath: repo,
    tool,
    workspaceName,
  });
}

function setupPlanLogLines(plan: AgentSetupPlan): string[] {
  const lines = [`Setup plan: workspace ~/${plan.workspaceName}.`];
  if (plan.initialCloneUrl) {
    lines.push("Setup plan: initial workspace pull from Git remote.");
  }
  if (plan.runtimes.length > 0) {
    lines.push(
      `Setup plan: runtimes ${plan.runtimes
        .map((runtime) => `${runtime.language} ${runtime.version} (${runtime.versionSource})`)
        .join(", ")}.`,
    );
  }
  if (plan.packageManagers.length > 0) {
    lines.push(`Setup plan: package managers ${plan.packageManagers.join(", ")}.`);
  }
  for (const source of plan.configSources) {
    lines.push(
      `Setup plan: ${source.label} config ${source.exists ? "found" : "not found"} at ${source.localPath}.`,
    );
  }
  for (const warning of plan.warnings) {
    lines.push(`Setup plan warning: ${warning}`);
  }
  return lines;
}

function scheduleAgentVmSetup(sessionId: string) {
  void ensureAgentVmSetupForSession(sessionId).catch((error) => {
    console.warn(`Agent VM setup failed for ${sessionId}`, error);
  });
}

function maybeAutoResumeAgentSetup(row: SessionRow) {
  if (!row.vm_resource_id || row.status === "failed" || hasAgentSetupComplete(row)) return;
  if (agentSetupAutoResumeAttempted.has(row.id)) return;
  agentSetupAutoResumeAttempted.add(row.id);
  scheduleAgentVmSetup(row.id);
}

async function ensureAgentVmSetupForSession(
  sessionId: string,
  keyHint?: { id: string; name: string; publicKey: string },
  opts?: { forceSync?: boolean; launchReadyToken?: string },
): Promise<void> {
  const existing = agentSetupInflight.get(sessionId);
  if (existing) {
    if (!opts?.forceSync) return existing.promise;
    await existing.promise;
    return ensureAgentVmSetupForSession(sessionId, keyHint, opts);
  }
  const setup = (async () => {
    const db = await getDb();
    const rows = await db.select<SessionRow[]>("SELECT * FROM agent_sessions WHERE id = $1", [
      sessionId,
    ]);
    const row = rows[0];
    if (!row) throw new Error("Agent session not found");
    if (hasAgentSetupComplete(row) && !opts?.forceSync) return;
    const agentKey = keyHint ?? (await ensureAgentSshKey());
    try {
      await ensureAgentVmSetup(row, agentKey, opts);
    } catch (error) {
      await appendAgentSessionLog(
        db,
        row.id,
        `${AGENT_SETUP_FAILED_LOG_PREFIX} ${formatErrorMessage(error)}`,
        "setting-up",
      );
      throw error;
    }
  })().finally(() => {
    agentSetupInflight.delete(sessionId);
  });
  agentSetupInflight.set(sessionId, { promise: setup, forceSync: Boolean(opts?.forceSync) });
  return setup;
}

async function ensureAgentVmSetup(
  row: SessionRow,
  agentKey: { id: string; name: string; publicKey: string },
  opts?: { forceSync?: boolean; launchReadyToken?: string },
): Promise<void> {
  if (!row.vm_resource_id) throw new Error("Agent session has no VM");
  const alreadyComplete = hasAgentSetupComplete(row);
  if (alreadyComplete && !opts?.forceSync) return;

  const db = await getDb();
  await appendAgentSessionLog(
    db,
    row.id,
    alreadyComplete ? AGENT_SETUP_REFRESH_LOG : AGENT_SETUP_STARTED_LOG,
    "setting-up",
  );

  const privateKey = await invoke<string>("ssh_key_get_private_key", { keyId: agentKey.id });
  const target = await waitForAgentSshTarget(row);
  await appendAgentSessionLog(db, row.id, AGENT_SETUP_WAIT_SSH_LOG, "setting-up");
  const remoteHome = await resolveAgentRemoteHome(target, privateKey);
  // The launch command and the repo setup script both source this env file;
  // it must land before either can run, so upload it ahead of the parallel
  // bootstrap/sync pair (it is tiny).
  await uploadAgentEnvFile(row, target, privateKey, remoteHome);

  const syncLocalRepo = shouldSyncLocalRepo(row, opts);
  await appendAgentSessionLog(db, row.id, AGENT_SETUP_BOOTSTRAP_LOG, "setting-up");
  await appendAgentSessionLog(
    db,
    row.id,
    syncLocalRepo
      ? "Syncing local tool config and repository files in parallel."
      : "Syncing local tool config in parallel.",
    "setting-up",
  );

  // Bootstrap (apt/mise/CLI install) and the file sync run CONCURRENTLY:
  // they touch disjoint remote paths (the bootstrap only mkdir -p's the
  // workspace for local-folder sessions, and cloneable sessions get no repo
  // sync at all), and the sync's SFTP traffic doesn't contend with the
  // bootstrap's CPU-bound work. The branch checkout below needs both.
  const setupLogger = createAgentSetupOutputLogger(db, row.id);
  const bootstrapPromise = (async () => {
    try {
      return await runAgentSetupCommand(
        target,
        privateKey,
        buildAgentBootstrapCommand({
          tool: row.tool,
          workspaceName: workspaceNameForRow(row),
          branchName: row.branch_name,
          repo: row.repo,
          setupPlan: setupPlanForRow(row),
        }),
        setupLogger,
      );
    } finally {
      await setupLogger.flush();
    }
  })();
  // Watchdog: a wedged SFTP session would otherwise leave the session stuck
  // on "Syncing local tool config." forever with no error and no retry.
  const syncPromise = withTimeout(
    syncAgentFiles(row, target, privateKey, remoteHome, { syncLocalRepo }),
    AGENT_SYNC_TIMEOUT_MS,
    "Timed out syncing local files to the agent VM",
  );
  const [result, syncResult] = await Promise.all([bootstrapPromise, syncPromise]);
  const warning = extractBootstrapWarning(result.stderr);
  if (warning) {
    await appendAgentSessionLog(db, row.id, `Warning: ${warning}`, "setting-up");
  }
  if (syncResult.configFiles > 0) {
    await appendAgentSessionLog(
      db,
      row.id,
      `Synced ${syncResult.configFiles} ${toolLabel(row.tool)} config file${syncResult.configFiles === 1 ? "" : "s"}.`,
      "setting-up",
    );
  }
  if (syncResult.repoFiles > 0) {
    await appendAgentSessionLog(
      db,
      row.id,
      `Synced ${syncResult.repoFiles} local repo file${syncResult.repoFiles === 1 ? "" : "s"} to ~/${workspaceNameForRow(row)}.`,
      "setting-up",
    );
  }
  if (!isCloneableGitRepo(row.repo) && syncResult.repoFiles > 0) {
    await checkoutAgentWorkspaceBranch(row, target, privateKey);
  }
  for (const syncWarning of syncResult.warnings.slice(0, 10)) {
    await appendAgentSessionLog(db, row.id, `Warning: ${syncWarning}`, "setting-up");
  }
  // Repo-provided setup script — needs the workspace (sync) AND the
  // runtimes (bootstrap), so it runs after both. The bootstrap's own script
  // hook only fires on git-URL clones (web); desktop always runs it here.
  await runAgentRepoSetupScript(db, row, target, privateKey);
  if (opts?.launchReadyToken) {
    await markAgentLaunchReady(target, privateKey, opts.launchReadyToken);
  }
  await appendAgentSessionLog(db, row.id, AGENT_SETUP_COMPLETE_LOG, "up");
}

async function waitForAgentSshTarget(row: SessionRow): Promise<AgentSshTarget> {
  const startedAt = Date.now();
  let lastError = "VM is not ready for SSH yet";
  while (Date.now() - startedAt < AGENT_SETUP_TIMEOUT_MS) {
    try {
      const resource = await loadAgentVmResource(row);
      const vmStatus = await agentVmStatus(row.plugin_id, row.resource_type_id, resource);
      if (vmStatus !== "up") {
        lastError = "VM is still provisioning";
      } else {
        return await resolveAgentSshTarget(row, resource);
      }
    } catch (error) {
      if (isNotFoundError(error)) throw error;
      lastError = formatErrorMessage(error);
    }
    await sleep(AGENT_SETUP_RETRY_MS);
  }
  throw new Error(`Timed out waiting for the agent VM SSH endpoint: ${lastError}`);
}

async function runAgentSetupCommand(
  target: AgentSshTarget,
  privateKey: string,
  command: string,
  logger: AgentSetupOutputLogger,
): Promise<{ stdout: string; stderr: string; code: number }> {
  const startedAt = Date.now();
  let lastError = "SSH did not become reachable";
  while (Date.now() - startedAt < AGENT_SETUP_TIMEOUT_MS) {
    try {
      const result = await agentSshStreamCommand(
        {
          sshHost: target.host,
          sshPort: target.port,
          sshUser: target.username,
          privateKey,
        },
        command,
        logger,
      );
      if (result.code !== 0) {
        throw new Error(formatCommandFailure(result));
      }
      return result;
    } catch (error) {
      lastError = formatErrorMessage(error);
      if (!isRetryableSshSetupError(lastError)) throw error;
      await logger.onData(
        `${AGENT_SETUP_STEP_PREFIX}Retrying VM setup: ${retryReason(lastError)}\n`,
      );
    }
    await sleep(AGENT_SETUP_RETRY_MS);
  }
  throw new Error(`Timed out connecting to the agent VM over SSH: ${lastError}`);
}

/** First line of a (possibly multi-line) error, capped for a one-line log. */
function retryReason(message: string): string {
  const firstLine = message.split(/\r?\n/, 1)[0] ?? message;
  return firstLine.length > 140 ? `${firstLine.slice(0, 140)}…` : firstLine;
}

async function runAgentSshCommandWithRetry(
  target: AgentSshTarget,
  privateKey: string,
  command: string,
  action: string,
): Promise<{ stdout: string; stderr: string; code: number }> {
  const startedAt = Date.now();
  let lastError = "SSH did not become reachable";
  while (Date.now() - startedAt < AGENT_SETUP_TIMEOUT_MS) {
    try {
      const result = await agentSshExecCommand(
        {
          sshHost: target.host,
          sshPort: target.port,
          sshUser: target.username,
          privateKey,
        },
        command,
      );
      if (result.code !== 0) {
        throw new Error(formatCommandFailure(result));
      }
      return result;
    } catch (error) {
      lastError = formatErrorMessage(error);
      if (!isRetryableSshSetupError(lastError)) throw error;
    }
    await sleep(AGENT_SETUP_RETRY_MS);
  }
  throw new Error(`Timed out ${action} over SSH: ${lastError}`);
}

async function resolveAgentRemoteHome(target: AgentSshTarget, privateKey: string): Promise<string> {
  const result = await runAgentSshCommandWithRetry(
    target,
    privateKey,
    `printf '%s' "$HOME"`,
    "waiting for the agent VM to become available",
  );
  const home = result.stdout.trim();
  if (!home.startsWith("/")) throw new Error(`Could not resolve remote home directory: ${home}`);
  return home.replace(/\/+$/g, "");
}

async function syncAgentFiles(
  row: SessionRow,
  target: AgentSshTarget,
  privateKey: string,
  remoteHome: string,
  opts?: { syncLocalRepo?: boolean },
): Promise<AgentSyncFilesResult> {
  return invoke<AgentSyncFilesResult>("agent_sync_files", {
    config: {
      sshHost: target.host,
      sshPort: target.port,
      sshUser: target.username,
      privateKey,
    },
    tool: row.tool,
    remoteHome,
    projectDir: `${remoteHome}/${workspaceNameForRow(row)}`,
    ...(opts?.syncLocalRepo && !isCloneableGitRepo(row.repo) ? { repoPath: row.repo } : {}),
  });
}

/**
 * Create the resources `.infrawrench/agent.json` declares (e.g. a database
 * branch), resolve their outputs into the session's env map, and persist
 * both onto the session row. Runs exactly once per session at create time.
 */
async function createRepoConfigResources(
  db: Awaited<ReturnType<typeof getDb>>,
  sessionId: string,
  repoConfig: AgentSetupPlan["repoConfig"],
): Promise<void> {
  const env: Record<string, string> = { ...(repoConfig?.env ?? {}) };
  const created: CreatedResourceRef[] = [];

  const persist = async () => {
    await db.execute(
      `UPDATE agent_sessions SET setup_env_json = $1, created_resources_json = $2, updated_at = datetime('now') WHERE id = $3`,
      [JSON.stringify(env), JSON.stringify(created), sessionId],
    );
  };

  try {
    for (const spec of repoConfig?.resources ?? []) {
      const accounts = await db.select<AccountRow[]>(
        "SELECT id, plugin_id, display_name FROM accounts WHERE deleted_at IS NULL AND plugin_id = $1 ORDER BY display_name",
        [spec.pluginId],
      );
      const matching = spec.account
        ? accounts.filter((a) => a.display_name === spec.account)
        : accounts;
      if (matching.length === 0) {
        throw new Error(
          `agent.json asks for a ${spec.pluginId} resource but no matching ${spec.pluginId} account exists${spec.account ? ` with the name ${JSON.stringify(spec.account)}` : ""}`,
        );
      }
      if (matching.length > 1) {
        throw new Error(
          `agent.json: multiple ${spec.pluginId} accounts exist — set "account" to one of: ${matching.map((a) => a.display_name).join(", ")}`,
        );
      }
      const account = matching[0]!;
      const client = await createPluginClient(account.id, spec.pluginId);
      if (!client.createResource) {
        throw new Error(`Plugin ${spec.pluginId} does not support resource creation`);
      }
      await appendAgentSessionLog(
        db,
        sessionId,
        `Creating ${spec.pluginId}/${spec.resourceTypeId} from .infrawrench/agent.json.`,
        "setting-up",
      );
      const name = `${spec.name ?? "agent"}-${sessionId.slice(0, 8)}`;
      const createReturn = await client.createResource(spec.resourceTypeId, account.id, {
        name,
        ...(spec.fields ?? {}),
      });
      const { resource: createdResource, warnings } = normalizeResourceCreateResult(createReturn);
      await db.execute(
        `INSERT OR REPLACE INTO resources
         (id, plugin_id, resource_type_id, account_id, display_name, external_id, fields_json, outputs_json, parent_resource_id, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, datetime('now'))`,
        [
          createdResource.id,
          createdResource.pluginId,
          createdResource.resourceTypeId,
          createdResource.accountId,
          createdResource.displayName,
          createdResource.externalId ?? createdResource.id,
          JSON.stringify(createdResource.fields ?? {}),
          JSON.stringify(createdResource.resolvedOutputs ?? {}),
          createdResource.parentResourceId ?? null,
        ],
      );
      created.push({
        id: createdResource.id,
        pluginId: spec.pluginId,
        resourceTypeId: spec.resourceTypeId,
        accountId: account.id,
      });
      for (const warning of warnings) {
        await appendAgentSessionLog(db, sessionId, `Warning: ${warning.message}`, "setting-up");
      }
      for (const [key, template] of Object.entries(spec.env ?? {})) {
        env[key] = resolveAgentEnvTemplate(template, {
          fields: createdResource.fields ?? {},
          resolvedOutputs: createdResource.resolvedOutputs ?? {},
        });
      }
      await appendAgentSessionLog(
        db,
        sessionId,
        `Created ${createdResource.displayName} (${spec.pluginId}/${spec.resourceTypeId}).`,
        "setting-up",
      );
      dispatchResourcesChanged({ accountId: account.id, resourceTypeId: spec.resourceTypeId });
    }
  } finally {
    // Persist whatever was created even on failure — Delete must be able to
    // clean up partial progress, and the env map is still valid as far as it
    // got.
    await persist();
  }
}

/** Upload the session env file the launch command and setup script source. */
async function uploadAgentEnvFile(
  row: SessionRow,
  target: AgentSshTarget,
  privateKey: string,
  remoteHome: string,
): Promise<void> {
  const env = parseJson<Record<string, string>>(row.setup_env_json ?? "{}", {});
  if (Object.keys(env).length === 0) return;
  const remotePath = `${remoteHome}/${AGENT_ENV_REMOTE_PATH}`;
  const config = {
    sshHost: target.host,
    sshPort: target.port,
    sshUser: target.username,
    privateKey,
  };
  const mkdir = await agentSshExecCommand(
    config,
    `mkdir -p "$HOME/.infrawrench-agent" && chmod 700 "$HOME/.infrawrench-agent"`,
  );
  if (mkdir.code !== 0) throw new Error(formatCommandFailure(mkdir));
  await invoke("sftp_upload", {
    config: { host: target.host, port: target.port, username: target.username, privateKey },
    remotePath,
    data: new TextEncoder().encode(buildAgentEnvFile(env)),
  });
  const chmod = await agentSshExecCommand(config, `chmod 600 ${shellQuote(remotePath)}`);
  if (chmod.code !== 0) throw new Error(formatCommandFailure(chmod));
}

/** Run the repo's `.infrawrench/agent-setup.sh` on the VM (no-op if absent). */
async function runAgentRepoSetupScript(
  db: Awaited<ReturnType<typeof getDb>>,
  row: SessionRow,
  target: AgentSshTarget,
  privateKey: string,
): Promise<void> {
  const logger = createAgentSetupOutputLogger(db, row.id);
  const result = await (async () => {
    try {
      return await agentSshStreamCommand(
        {
          sshHost: target.host,
          sshPort: target.port,
          sshUser: target.username,
          privateKey,
        },
        buildAgentRepoSetupCommand(workspaceNameForRow(row)),
        logger,
      );
    } finally {
      await logger.flush();
    }
  })();
  if (result.code !== 0) {
    throw new Error(`Repository agent-setup script failed: ${formatCommandFailure(result)}`);
  }
}

function shouldSyncLocalRepo(row: SessionRow, _opts?: { forceSync?: boolean }): boolean {
  // Local folders always sync via the archive upload. Older plans set
  // initialCloneUrl from the repo's origin remote and skipped this step, but
  // the VM usually has no credentials for that remote (private/SSH URLs), so
  // the clone silently produced an empty workspace.
  return !isCloneableGitRepo(row.repo);
}

async function checkoutAgentWorkspaceBranch(
  row: SessionRow,
  target: AgentSshTarget,
  privateKey: string,
): Promise<void> {
  const workspaceName = workspaceNameForRow(row);
  const result = await agentSshExecCommand(
    {
      sshHost: target.host,
      sshPort: target.port,
      sshUser: target.username,
      privateKey,
    },
    `PROJECT_DIR="$HOME/${shellDoubleQuoteContent(workspaceName)}"; if [ -d "$PROJECT_DIR/.git" ]; then git -C "$PROJECT_DIR" checkout -B ${shellQuote(row.branch_name)} || true; else echo "workspace is not a git repository: $PROJECT_DIR" >&2; fi`,
  );
  if (result.code !== 0) throw new Error(formatCommandFailure(result));
  const warning = extractBootstrapWarning(result.stderr);
  if (warning) {
    const db = await getDb();
    await appendAgentSessionLog(db, row.id, `Warning: ${warning}`, "setting-up");
  }
}

async function markAgentLaunchReady(
  target: AgentSshTarget,
  privateKey: string,
  launchReadyToken: string,
): Promise<void> {
  const result = await agentSshExecCommand(
    {
      sshHost: target.host,
      sshPort: target.port,
      sshUser: target.username,
      privateKey,
    },
    `mkdir -p "$HOME/.infrawrench-agent/launch-ready" && touch "$HOME/.infrawrench-agent/launch-ready/${shellDoubleQuoteContent(launchReadyToken)}"`,
  );
  if (result.code !== 0) throw new Error(formatCommandFailure(result));
}

async function agentSshExecCommand(
  config: { sshHost: string; sshPort: number; sshUser: string; privateKey: string },
  command: string,
): Promise<{ stdout: string; stderr: string; code: number }> {
  const result = await invoke<{
    stdoutBase64: string;
    stderrBase64: string;
    code: number;
  }>("workflow_ssh_exec", {
    config,
    command,
    skipHostKeyCheck: true,
  });
  return {
    stdout: decodeBase64(result.stdoutBase64),
    stderr: decodeBase64(result.stderrBase64),
    code: result.code,
  };
}

async function agentSshStreamCommand(
  config: { sshHost: string; sshPort: number; sshUser: string; privateKey: string },
  command: string,
  logger: AgentSetupOutputLogger,
): Promise<{ stdout: string; stderr: string; code: number }> {
  let streamId: string | null = null;
  const started = await invoke<{ streamId: string }>("workflow_ssh_stream_start", {
    config,
    command,
    skipHostKeyCheck: true,
  });
  streamId = started.streamId;
  let stdout = "";
  let stderr = "";
  try {
    for (;;) {
      const chunk = await invoke<{
        stdoutBase64?: string;
        stderrBase64?: string;
        done: boolean;
        code?: number;
      }>("workflow_ssh_stream_read", { streamId });
      if (chunk.stdoutBase64) {
        const text = decodeBase64(chunk.stdoutBase64);
        stdout += text;
        await logger.onData(text);
      }
      if (chunk.stderrBase64) {
        const text = decodeBase64(chunk.stderrBase64);
        stderr += text;
        await logger.onData(text);
      }
      if (chunk.done) {
        streamId = null;
        return { stdout, stderr, code: chunk.code ?? 0 };
      }
    }
  } finally {
    if (streamId) {
      await invoke("workflow_ssh_stream_close", { streamId }).catch(() => undefined);
    }
  }
}

async function loadAgentVmResource(row: SessionRow): Promise<ResourceInstance> {
  if (!row.vm_resource_id) throw new Error("Agent session has no VM");
  const client = await createPluginClient(row.account_id, row.plugin_id);
  const resource = await client.getResource(
    row.resource_type_id,
    row.vm_resource_id,
    row.account_id,
  );
  const db = await getDb();
  await db.execute(
    `INSERT OR REPLACE INTO resources
     (id, plugin_id, resource_type_id, account_id, display_name, external_id, fields_json, outputs_json, parent_resource_id, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, datetime('now'))`,
    [
      resource.id,
      resource.pluginId,
      resource.resourceTypeId,
      resource.accountId,
      resource.displayName,
      resource.externalId ?? resource.id,
      JSON.stringify(resource.fields ?? {}),
      JSON.stringify(resource.resolvedOutputs ?? {}),
      resource.parentResourceId ?? null,
    ],
  );
  return resource;
}

async function resolveAgentSshTarget(
  row: SessionRow,
  resource: ResourceInstance,
): Promise<AgentSshTarget> {
  const rt = await getResourceType(row.plugin_id, row.resource_type_id);
  const endpoint = rt?.sshEndpoint;
  if (!endpoint) throw new Error("Agent VM resource type does not expose an SSH endpoint");

  const host = String(
    resource.resolvedOutputs?.[endpoint.hostOutputKey] ??
      resource.fields?.[endpoint.hostOutputKey] ??
      "",
  ).trim();
  if (!host) {
    throw new Error(`Agent VM has no SSH host yet (${endpoint.hostOutputKey})`);
  }

  let username = endpoint.defaultUsername ?? rt.agentVm?.defaultUsername ?? "root";
  if (endpoint.usernameFieldKey) {
    const fieldUsername = String(resource.fields?.[endpoint.usernameFieldKey] ?? "").trim();
    if (fieldUsername) username = fieldUsername;
  }
  return { host, port: 22, username };
}

function setupPlanForRow(row: SessionRow): AgentSetupPlan {
  return parseJson<AgentSetupPlan>(row.setup_plan_json, defaultAgentSetupPlan(row));
}

function defaultAgentSetupPlan(row: SessionRow): AgentSetupPlan {
  return {
    source: isCloneableGitRepo(row.repo) ? "git-url" : "local-folder",
    workspaceName: workspaceNameForRow(row),
    ...(isCloneableGitRepo(row.repo) ? { initialCloneUrl: row.repo } : {}),
    runtimes: [
      {
        language: "node",
        version: "latest",
        versionSource: "latest",
        source: "mise latest resolver at setup time",
        reasons: [`${toolLabel(row.tool)} requires Node for its CLI package`],
      },
    ],
    packageManagers: [],
    configSources: [],
    warnings: [],
  };
}
async function appendAgentSessionLog(
  db: Awaited<ReturnType<typeof getDb>>,
  sessionId: string,
  message: string,
  status?: AgentSession["status"],
): Promise<void> {
  const rows = await db.select<SessionRow[]>("SELECT * FROM agent_sessions WHERE id = $1", [
    sessionId,
  ]);
  const row = rows[0];
  if (!row) return;
  const logs = parseJson<string[]>(row.logs_json, []);
  const nextLogs = logs[logs.length - 1] === message ? logs : [...logs, message];
  await db.execute(
    `UPDATE agent_sessions
     SET logs_json = $1, status = $2, updated_at = datetime('now')
     WHERE id = $3`,
    [JSON.stringify(nextLogs), status ?? row.status, sessionId],
  );
}

function createAgentSetupOutputLogger(
  db: Awaited<ReturnType<typeof getDb>>,
  sessionId: string,
): AgentSetupOutputLogger {
  let buffer = "";
  let lastMessage = "";

  async function processLine(line: string): Promise<void> {
    const index = line.indexOf(AGENT_SETUP_STEP_PREFIX);
    if (index < 0) return;
    const message = line.slice(index + AGENT_SETUP_STEP_PREFIX.length).trim();
    if (!message || message === lastMessage) return;
    lastMessage = message;
    await appendAgentSessionLog(db, sessionId, message, "setting-up");
  }

  async function drain(final = false): Promise<void> {
    const lines = buffer.split(/\r?\n/);
    if (final) {
      buffer = "";
    } else {
      buffer = lines.pop() ?? "";
    }
    for (const line of lines) {
      await processLine(line);
    }
  }

  return {
    async onData(text: string) {
      buffer += text;
      await drain();
    },
    async flush() {
      if (!buffer) return;
      await drain(true);
    },
  };
}

function setupAwareStatusFromLogs(
  logs: string[],
  vmStatus: AgentSession["status"],
): AgentSession["status"] {
  const setupComplete = logs.includes(AGENT_SETUP_COMPLETE_LOG);
  if (vmStatus === "up") return setupComplete ? "up" : "setting-up";
  // A VM that already completed setup but is no longer running is "stopped" —
  // without this, a powered-off VM reads "Setting up" forever.
  if (vmStatus === "setting-up" && setupComplete) return "stopped";
  return vmStatus;
}

function setupAwareAgentStatus(
  row: SessionRow,
  vmStatus: AgentSession["status"],
): AgentSession["status"] {
  return setupAwareStatusFromLogs(parseJson<string[]>(row.logs_json, []), vmStatus);
}

function hasAgentSetupComplete(row: SessionRow): boolean {
  return parseJson<string[]>(row.logs_json, []).includes(AGENT_SETUP_COMPLETE_LOG);
}

function isCloneableGitRepo(repo: string): boolean {
  const value = repo.trim();
  return /^(?:https?|ssh|git):\/\//i.test(value) || /^git@[^:]+:.+/.test(value);
}

function workspaceNameForRow(
  row: Pick<SessionRow, "repo" | "workspace_name" | "project_name">,
): string {
  const inferred = projectNameFromRepo(row.repo);
  const stored = row.workspace_name?.trim();
  if (!stored || stored === row.project_name) return inferred || row.project_name;
  return stored;
}

function extractBootstrapWarning(stderr: string): string | null {
  const warning = stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.includes("git clone failed") || line.includes("workspace is not a git"));
  return warning ?? null;
}

function isRetryableSshSetupError(message: string): boolean {
  // The dpkg/apt lock patterns cover fresh VMs where unattended-upgrades
  // still holds the package lock on first boot, and "exit 124" is the
  // bootstrap's own `timeout 420s` expiring on a slow VM — re-running the
  // (idempotent) bootstrap resumes where the previous attempt left off.
  return /ssh connection failed|timed out|timeout|econnrefused|connection refused|handshake|ready timeout|all configured authentication methods failed|could not get lock|dpkg[^\n]*lock|lock[^\n]*\/var\/lib\/(?:dpkg|apt)|command failed with exit 124\b/i.test(
    message,
  );
}

function formatCommandFailure(result: { stdout: string; stderr: string; code: number }): string {
  // Prefer stderr (where the actual error lands) and keep only its tail —
  // the full transcript would otherwise become one unreadable log line.
  const source = result.stderr.trim() || result.stdout.trim();
  const output = tailLines(source, 15);
  return `Agent VM setup command failed with exit ${result.code}${output ? `: ${output}` : ""}`;
}

function tailLines(text: string, maxLines: number): string {
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== "");
  if (lines.length <= maxLines) return lines.join("\n");
  return [`… (${lines.length - maxLines} earlier lines omitted)`, ...lines.slice(-maxLines)].join(
    "\n",
  );
}

function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function shellDoubleQuoteContent(value: string): string {
  return value.replace(/(["\\$`])/g, "\\$1").replace(/\n/g, "\\n");
}

function toolLabel(tool: "codex" | "claude-code"): string {
  return tool === "claude-code" ? "Claude Code" : "Codex";
}

function decodeBase64(value: string): string {
  const binary = atob(value);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function refreshAgentSession(row: SessionRow): Promise<AgentSession | null> {
  if (!row.vm_resource_id) return null;
  const db = await getDb();
  const resourceRows = await db.select<ResourceRow[]>(
    "SELECT id FROM resources WHERE id = $1 AND deleted_at IS NULL LIMIT 1",
    [row.vm_resource_id],
  );
  if (!resourceRows[0]) return null;

  const client = await createPluginClient(row.account_id, row.plugin_id).catch(() => null);
  if (!client) return rowToSession(row);
  try {
    const resource = await client.getResource(
      row.resource_type_id,
      row.vm_resource_id,
      row.account_id,
    );
    agentSessionNotFoundStreak.delete(row.id);
    const vmStatus = await agentVmStatus(row.plugin_id, row.resource_type_id, resource);
    const latestRows = await db.select<SessionRow[]>("SELECT * FROM agent_sessions WHERE id = $1", [
      row.id,
    ]);
    const latestRow = latestRows[0] ?? row;
    const status =
      latestRow.status === "failed" ? "failed" : setupAwareAgentStatus(latestRow, vmStatus);
    await db.execute(
      `UPDATE resources
       SET display_name = $1, external_id = $2, fields_json = $3, outputs_json = $4, parent_resource_id = $5, updated_at = datetime('now')
       WHERE id = $6`,
      [
        resource.displayName,
        resource.externalId ?? resource.id,
        JSON.stringify(resource.fields ?? {}),
        JSON.stringify(resource.resolvedOutputs ?? {}),
        resource.parentResourceId ?? null,
        resource.id,
      ],
    );
    if (latestRow.status !== status) {
      await db.execute(
        "UPDATE agent_sessions SET status = $1, updated_at = datetime('now') WHERE id = $2",
        [status, row.id],
      );
    }
    return rowToSession({ ...latestRow, status });
  } catch (error) {
    if (isNotFoundError(error)) {
      // Eventually-consistent providers can 404 right after VM creation; only delete the
      // session once it is past the creation grace period and the VM has been missing on
      // several consecutive polls.
      if (shouldDeleteMissingAgentSession(row.id, row.created_at)) {
        agentSessionNotFoundStreak.delete(row.id);
        return null;
      }
      console.warn(`Agent VM ${row.vm_resource_id} reported not found; keeping session for now`);
      return rowToSession(row);
    }
    agentSessionNotFoundStreak.delete(row.id);
    console.warn(`Failed to verify agent VM ${row.vm_resource_id}`, error);
    return rowToSession(row);
  }
}

async function agentVmStatus(
  pluginId: string,
  resourceTypeId: string,
  resource: ResourceInstance,
): Promise<AgentSession["status"]> {
  const rt = await getResourceType(pluginId, resourceTypeId);
  const runningWhen = rt?.sshEndpoint?.runningWhen;
  if (!runningWhen) return "up";
  const fieldVal = String(resource.fields[runningWhen.fieldKey] ?? "");
  return fieldVal.toLowerCase() === runningWhen.value.toLowerCase() ? "up" : "setting-up";
}

async function getResourceType(
  pluginId: string,
  resourceTypeId: string,
): Promise<ResourceTypeDefinition | undefined> {
  const plugins = await loadPlugins();
  return plugins
    .find((loaded) => loaded.plugin.manifest.id === pluginId)
    ?.plugin.resourceTypes.find((rt) => rt.id === resourceTypeId);
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

function shouldDeleteMissingAgentSession(sessionId: string, createdAt: string): boolean {
  const misses = (agentSessionNotFoundStreak.get(sessionId) ?? 0) + 1;
  agentSessionNotFoundStreak.set(sessionId, misses);
  const createdAtMs = parseAgentSessionTimestamp(createdAt);
  const withinGrace =
    createdAtMs !== null && Date.now() - createdAtMs < AGENT_SESSION_DELETE_GRACE_MS;
  return !withinGrace && misses >= AGENT_SESSION_NOT_FOUND_DELETE_THRESHOLD;
}

function parseAgentSessionTimestamp(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  // SQLite datetime('now') stores UTC without a timezone marker; normalize before parsing
  // so the value is not misread as local time.
  const normalized = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(trimmed)
    ? trimmed
    : `${trimmed.replace(" ", "T")}Z`;
  const parsed = Date.parse(normalized);
  return Number.isNaN(parsed) ? null : parsed;
}

function agentDefaultFields(agentVm: AgentVmCapability) {
  return { ...(agentVm.linuxImageDefaults ?? {}), ...(agentVm.defaultFields ?? {}) };
}

async function agentCreateFields(
  client: PluginClient | null,
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

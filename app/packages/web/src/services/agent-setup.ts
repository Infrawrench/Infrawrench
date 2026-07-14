/**
 * Server-side agent-VM setup pipeline — the web counterpart of the desktop
 * app's `ensureAgentVmSetup` flow (desktop/src/lib/agent-client.ts).
 *
 * After POST /agents/sessions provisions a VM, this service waits for the
 * VM's SSH endpoint to come up, runs the shared bootstrap command (system
 * packages, mise runtimes, the coding-tool CLI, workspace clone + branch
 * checkout), and persists progress into the session row's `logs`/`status`
 * columns. The bootstrap writes `~/.infrawrench-agent/setup-$TOOL`, which the
 * shared launch command polls for; when an `launchReadyToken` is supplied the
 * pipeline additionally touches `~/.infrawrench-agent/launch-ready/<token>`
 * once everything finished so a freshly opened terminal waits for this exact
 * setup run.
 *
 * Unlike desktop there is no local-folder path on web: session repos are
 * always cloneable Git URLs and the clone happens on the VM, so there is no
 * config/repo file sync step.
 */
import { Client as SshClient } from "ssh2";
import { and, eq } from "drizzle-orm";
import type { Plugin, ResourceInstance } from "@infrawrench/plugin-base";
import type {
  AgentSetupPlan,
  AgentSshTarget,
  AgentStatus,
  AgentTool,
} from "@infrawrench/ui/agents";
import {
  AGENT_SETUP_FAILED_LOG_PREFIX,
  AGENT_SETUP_STEP_PREFIX,
  agentToolLabel,
  buildAgentBootstrapCommand,
  isCloneableGitRepo,
} from "@infrawrench/ui/agents/launch-command";

import { db } from "../db/client";
import { agentSessions, resources, sshKeys } from "../db/schema";
import { buildAad, decrypt } from "./encryption";
import { getClientForAccount } from "./plugin-clients";

const AGENT_SSH_KEY_NAME = "infrawrench-agent";
const AGENT_SETUP_STARTED_LOG = "Preparing VM for coding session.";
const AGENT_SETUP_WAIT_SSH_LOG = "Waiting for VM SSH to become available.";
const AGENT_SETUP_BOOTSTRAP_LOG = "Installing coding tools and preparing workspace.";
const AGENT_SETUP_REFRESH_LOG = "Refreshing agent workspace and tool configuration.";
export const AGENT_SETUP_COMPLETE_LOG = "Agent VM setup complete.";
// Must exceed the bootstrap's own remote `timeout 420s` so a slow first
// attempt still leaves budget for retries; the launch command waits 900s.
const AGENT_SETUP_TIMEOUT_MS = 15 * 60 * 1000;
const AGENT_SETUP_RETRY_MS = 5 * 1000;
const AGENT_SSH_READY_TIMEOUT_MS = 15 * 1000;

type SessionRow = typeof agentSessions.$inferSelect;

interface AgentSshExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

interface AgentSetupOptions {
  /** Re-run setup even when the session already completed it once. */
  forceSync?: boolean;
  /** Touch `~/.infrawrench-agent/launch-ready/<token>` after setup finishes. */
  launchReadyToken?: string;
}

const agentSetupInflight = new Map<string, { promise: Promise<void>; forceSync: boolean }>();
const agentSetupAutoResumeAttempted = new Set<string>();

/** Whether the session's persisted logs record a completed setup run. */
export function hasAgentSetupComplete(logs: string[] | null | undefined): boolean {
  return (logs ?? []).includes(AGENT_SETUP_COMPLETE_LOG);
}

/**
 * Downgrade an "up" VM status to "setting-up" until the setup pipeline has
 * recorded completion, mirroring the desktop client's setup-aware status.
 * Conversely, a VM that already completed setup but is no longer running is
 * "stopped" — without this, a powered-off VM reads "Setting up" forever.
 */
export function setupAwareAgentStatus(
  logs: string[] | null | undefined,
  vmStatus: AgentStatus,
): AgentStatus {
  if (vmStatus === "up") return hasAgentSetupComplete(logs) ? "up" : "setting-up";
  if (vmStatus === "setting-up" && hasAgentSetupComplete(logs)) return "stopped";
  return vmStatus;
}

/**
 * Build the setup plan for a web agent session. Web repos are always clone
 * URLs (there is no local-folder upload path outside the desktop app), so
 * runtime detection is deferred to the VM and only the Node runtime the
 * coding-tool CLI needs is planned up front — the same plan desktop produces
 * for git-URL sessions.
 */
export function createAgentSetupPlanForRepo(
  repo: string,
  tool: AgentTool,
  workspaceName: string,
): AgentSetupPlan {
  if (!isCloneableGitRepo(repo)) {
    throw new Error(
      "Agent sessions require a cloneable Git URL; local folders are only supported in the desktop app.",
    );
  }
  return {
    source: "git-url",
    workspaceName,
    initialCloneUrl: repo.trim(),
    runtimes: [
      {
        language: "node",
        version: "latest",
        versionSource: "latest",
        source: "mise latest resolver at setup time",
        reasons: [`${agentToolLabel(tool)} requires Node for its CLI package`],
      },
    ],
    packageManagers: [],
    configSources: [],
    warnings: [
      "Git URL sessions are cloned on the VM, so project runtime detection is deferred until the repository is available remotely.",
    ],
  };
}

export function setupPlanLogLines(plan: AgentSetupPlan): string[] {
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
  for (const warning of plan.warnings) {
    lines.push(`Setup plan warning: ${warning}`);
  }
  return lines;
}

/** Fire-and-forget wrapper; setup failures are captured in the session logs. */
export function scheduleAgentVmSetup(
  sessionId: string,
  organizationId: string,
  opts?: AgentSetupOptions,
): void {
  void ensureAgentVmSetupForSession(sessionId, organizationId, opts).catch((error) => {
    console.warn(`[agent-setup] setup failed for session ${sessionId}`, error);
  });
}

/**
 * Kick setup for sessions that never completed it (e.g. the server restarted
 * mid-setup). Attempted once per session per process, like desktop.
 */
export function maybeAutoResumeAgentSetup(
  row: Pick<SessionRow, "id" | "status" | "vmResourceId" | "logs">,
  organizationId: string,
): void {
  if (!row.vmResourceId || row.status === "failed" || hasAgentSetupComplete(row.logs)) return;
  if (agentSetupAutoResumeAttempted.has(row.id)) return;
  agentSetupAutoResumeAttempted.add(row.id);
  scheduleAgentVmSetup(row.id, organizationId);
}

/**
 * Run (or join) the setup pipeline for a session. Only one setup runs per
 * session at a time; a forceSync request queues behind an in-flight run.
 */
export async function ensureAgentVmSetupForSession(
  sessionId: string,
  organizationId: string,
  opts?: AgentSetupOptions,
): Promise<void> {
  const existing = agentSetupInflight.get(sessionId);
  if (existing) {
    if (!opts?.forceSync) return existing.promise;
    await existing.promise;
    return ensureAgentVmSetupForSession(sessionId, organizationId, opts);
  }
  const setup = (async () => {
    const [row] = await db
      .select()
      .from(agentSessions)
      .where(and(eq(agentSessions.id, sessionId), eq(agentSessions.organizationId, organizationId)))
      .limit(1);
    if (!row) throw new Error("Agent session not found");
    if (hasAgentSetupComplete(row.logs) && !opts?.forceSync) return;
    try {
      await runAgentVmSetup(row, organizationId, opts);
    } catch (error) {
      await appendAgentSessionLog(
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

async function runAgentVmSetup(
  row: SessionRow,
  organizationId: string,
  opts?: AgentSetupOptions,
): Promise<void> {
  if (!row.vmResourceId) throw new Error("Agent session has no VM");
  const alreadyComplete = hasAgentSetupComplete(row.logs);
  if (alreadyComplete && !opts?.forceSync) return;

  await appendAgentSessionLog(
    row.id,
    alreadyComplete ? AGENT_SETUP_REFRESH_LOG : AGENT_SETUP_STARTED_LOG,
    "setting-up",
  );

  const privateKey = await loadOrgAgentSshPrivateKey(organizationId);
  const target = await waitForAgentSshTarget(row, organizationId);
  await appendAgentSessionLog(row.id, AGENT_SETUP_WAIT_SSH_LOG, "setting-up");

  await appendAgentSessionLog(row.id, AGENT_SETUP_BOOTSTRAP_LOG, "setting-up");
  const logger = createAgentSetupOutputLogger(row.id);
  const bootstrapCommand = buildAgentBootstrapCommand({
    tool: sessionTool(row),
    workspaceName: row.workspaceName,
    branchName: row.branchName,
    repo: row.repo,
    setupPlan: setupPlanForRow(row),
  });
  const result = await (async () => {
    try {
      return await runAgentSetupCommandWithRetry(target, privateKey, bootstrapCommand, logger);
    } finally {
      await logger.flush();
    }
  })();
  const warning = extractBootstrapWarning(result.stderr);
  if (warning) {
    await appendAgentSessionLog(row.id, `Warning: ${warning}`, "setting-up");
  }
  // Web sessions are cloned from a Git URL on the VM; there is no local
  // config/repo file sync step (that path exists only in the desktop app).
  if (opts?.launchReadyToken) {
    await markAgentLaunchReady(target, privateKey, opts.launchReadyToken);
  }
  await appendAgentSessionLog(row.id, AGENT_SETUP_COMPLETE_LOG, "up");
}

function sessionTool(row: Pick<SessionRow, "tool">): AgentTool {
  return row.tool === "claude-code" ? "claude-code" : "codex";
}

export function setupPlanForRow(
  row: Pick<SessionRow, "repo" | "tool" | "workspaceName" | "setupPlanJson">,
): AgentSetupPlan {
  try {
    const parsed = JSON.parse(row.setupPlanJson) as AgentSetupPlan;
    if (parsed && typeof parsed === "object" && Array.isArray(parsed.runtimes)) return parsed;
  } catch {
    // fall through to the default plan
  }
  return createAgentSetupPlanForRepo(row.repo, sessionTool(row), row.workspaceName);
}

async function loadOrgAgentSshPrivateKey(organizationId: string): Promise<string> {
  const [keyRow] = await db
    .select({
      id: sshKeys.id,
      encryptedPrivateKey: sshKeys.encryptedPrivateKey,
      privateKeyIv: sshKeys.privateKeyIv,
    })
    .from(sshKeys)
    .where(and(eq(sshKeys.organizationId, organizationId), eq(sshKeys.name, AGENT_SSH_KEY_NAME)))
    .limit(1);
  if (!keyRow) {
    throw new Error(`Agent SSH key "${AGENT_SSH_KEY_NAME}" not found for this organization`);
  }
  if (!keyRow.encryptedPrivateKey || !keyRow.privateKeyIv) {
    throw new Error(`Agent SSH key "${AGENT_SSH_KEY_NAME}" has no private key data`);
  }
  return decrypt(
    keyRow.encryptedPrivateKey,
    keyRow.privateKeyIv,
    buildAad("sshKey", keyRow.id, "privateKey"),
  );
}

async function waitForAgentSshTarget(
  row: SessionRow,
  organizationId: string,
): Promise<AgentSshTarget> {
  const startedAt = Date.now();
  let lastError = "VM is not ready for SSH yet";
  while (Date.now() - startedAt < AGENT_SETUP_TIMEOUT_MS) {
    try {
      const ctx = await getClientForAccount(row.accountId, organizationId);
      if (!ctx || ctx.account.pluginId !== row.pluginId) {
        throw new Error("Agent session account is no longer available");
      }
      const resource = await ctx.client.getResource(
        row.resourceTypeId,
        row.vmResourceId!,
        row.accountId,
      );
      await db
        .update(resources)
        .set({
          displayName: resource.displayName,
          externalId: resource.externalId ?? null,
          fieldsJson: resource.fields ?? {},
          outputsJson: resource.resolvedOutputs ?? {},
          parentResourceId: resource.parentResourceId ?? null,
          updatedAt: new Date(),
        })
        .where(eq(resources.id, resource.id));
      if (agentVmStatus(ctx.plugin, row.resourceTypeId, resource) !== "up") {
        lastError = "VM is still provisioning";
      } else {
        return resolveAgentSshTarget(ctx.plugin, row, resource);
      }
    } catch (error) {
      if (isNotFoundError(error)) throw error;
      lastError = formatErrorMessage(error);
    }
    await sleep(AGENT_SETUP_RETRY_MS);
  }
  throw new Error(`Timed out waiting for the agent VM SSH endpoint: ${lastError}`);
}

function agentVmStatus(
  plugin: Plugin,
  resourceTypeId: string,
  resource: ResourceInstance,
): "setting-up" | "up" {
  const runningWhen = plugin.resourceTypes.find((rt) => rt.id === resourceTypeId)?.sshEndpoint
    ?.runningWhen;
  if (!runningWhen) return "up";
  const fieldVal = String(resource.fields[runningWhen.fieldKey] ?? "");
  return fieldVal.toLowerCase() === runningWhen.value.toLowerCase() ? "up" : "setting-up";
}

function resolveAgentSshTarget(
  plugin: Plugin,
  row: SessionRow,
  resource: ResourceInstance,
): AgentSshTarget {
  const rt = plugin.resourceTypes.find((type) => type.id === row.resourceTypeId);
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

async function runAgentSetupCommandWithRetry(
  target: AgentSshTarget,
  privateKey: string,
  command: string,
  logger: ReturnType<typeof createAgentSetupOutputLogger>,
): Promise<AgentSshExecResult> {
  const startedAt = Date.now();
  let lastError = "SSH did not become reachable";
  while (Date.now() - startedAt < AGENT_SETUP_TIMEOUT_MS) {
    try {
      const result = await agentSshExec(target, privateKey, command, logger.onData);
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

async function markAgentLaunchReady(
  target: AgentSshTarget,
  privateKey: string,
  launchReadyToken: string,
): Promise<void> {
  const result = await agentSshExec(
    target,
    privateKey,
    `mkdir -p "$HOME/.infrawrench-agent/launch-ready" && touch "$HOME/.infrawrench-agent/launch-ready/${shellDoubleQuoteContent(launchReadyToken)}"`,
  );
  if (result.code !== 0) throw new Error(formatCommandFailure(result));
}

/**
 * Execute a command on the agent VM over SSH. Fresh agent VMs have no pinned
 * host key yet, so — mirroring the desktop app, which runs its agent setup
 * with `skipHostKeyCheck: true` — the presented host key is accepted without
 * the org-level pinning used for user-initiated SSH connections.
 */
function agentSshExec(
  target: AgentSshTarget,
  privateKey: string,
  command: string,
  onData?: (text: string) => void,
): Promise<AgentSshExecResult> {
  return new Promise((resolve, reject) => {
    const client = new SshClient();
    client.once("ready", () => {
      client.exec(command, (err, stream) => {
        if (err) {
          client.end();
          reject(err);
          return;
        }
        let stdout = "";
        let stderr = "";
        stream.on("data", (data: Buffer) => {
          const text = data.toString("utf8");
          stdout += text;
          onData?.(text);
        });
        stream.stderr.on("data", (data: Buffer) => {
          const text = data.toString("utf8");
          stderr += text;
          onData?.(text);
        });
        stream.on("close", (code: number | null) => {
          client.end();
          resolve({ stdout, stderr, code: code ?? 0 });
        });
      });
    });
    client.once("error", (err) => {
      reject(new Error(`SSH connection failed: ${err.message}`));
    });
    client.connect({
      host: target.host,
      port: target.port,
      username: target.username,
      privateKey,
      readyTimeout: AGENT_SSH_READY_TIMEOUT_MS,
    });
  });
}

async function appendAgentSessionLog(
  sessionId: string,
  message: string,
  status?: AgentStatus,
): Promise<void> {
  const [row] = await db
    .select({ logs: agentSessions.logs, status: agentSessions.status })
    .from(agentSessions)
    .where(eq(agentSessions.id, sessionId))
    .limit(1);
  if (!row) return;
  const logs = row.logs ?? [];
  const nextLogs = logs[logs.length - 1] === message ? logs : [...logs, message];
  await db
    .update(agentSessions)
    .set({ logs: nextLogs, status: status ?? row.status, updatedAt: new Date() })
    .where(eq(agentSessions.id, sessionId));
}

/**
 * Parses `INFRAWRENCH_AGENT_STEP:` lines out of streamed bootstrap output and
 * appends them to the session logs so the UI shows live setup progress.
 * `onData` is synchronous (ssh2 stream callback); DB writes are serialized on
 * an internal promise chain awaited by `flush()`.
 */
function createAgentSetupOutputLogger(sessionId: string): {
  onData: (text: string) => void;
  flush: () => Promise<void>;
} {
  let buffer = "";
  let lastMessage = "";
  let chain: Promise<void> = Promise.resolve();

  function processLine(line: string): void {
    const index = line.indexOf(AGENT_SETUP_STEP_PREFIX);
    if (index < 0) return;
    const message = line.slice(index + AGENT_SETUP_STEP_PREFIX.length).trim();
    if (!message || message === lastMessage) return;
    lastMessage = message;
    chain = chain
      .then(() => appendAgentSessionLog(sessionId, message, "setting-up"))
      .catch((error) => {
        console.warn(`[agent-setup] failed to persist setup step for ${sessionId}`, error);
      });
  }

  function drain(final = false): void {
    const lines = buffer.split(/\r?\n/);
    if (final) {
      buffer = "";
    } else {
      buffer = lines.pop() ?? "";
    }
    for (const line of lines) {
      processLine(line);
    }
  }

  return {
    onData(text: string) {
      buffer += text;
      drain();
    },
    async flush() {
      if (buffer) drain(true);
      await chain;
    },
  };
}

export function extractBootstrapWarning(stderr: string): string | null {
  const warning = stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.includes("git clone failed") || line.includes("workspace is not a git"));
  return warning ?? null;
}

export function isRetryableSshSetupError(message: string): boolean {
  // The dpkg/apt lock patterns cover fresh VMs where unattended-upgrades
  // still holds the package lock on first boot, and "exit 124" is the
  // bootstrap's own `timeout 420s` expiring on a slow VM — re-running the
  // (idempotent) bootstrap resumes where the previous attempt left off.
  return /ssh connection failed|timed out|timeout|econnrefused|connection refused|handshake|ready timeout|all configured authentication methods failed|could not get lock|dpkg[^\n]*lock|lock[^\n]*\/var\/lib\/(?:dpkg|apt)|command failed with exit 124\b/i.test(
    message,
  );
}

function formatCommandFailure(result: AgentSshExecResult): string {
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

function shellDoubleQuoteContent(value: string): string {
  return value.replace(/(["\\$`])/g, "\\$1").replace(/\n/g, "\\n");
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

import ssh2 from "ssh2";
import { eq } from "drizzle-orm";
import type { AgentSshTarget } from "@infrawrench/ui/agents";
import { execSshScript } from "@infrawrench/ssh-tunnel-core";
import { db } from "../db/client";
import { agentSessions } from "../db/schema";
import { getClientForAccount } from "./plugin-clients";
import { listSshInstallAccounts, refreshInstallerAccount } from "./ssh-install";
import { resolveSafeHost } from "./host-validation";

/**
 * Services attached to an agent session: accounts whose plugin installs
 * something on the session's VM over SSH (any plugin declaring `sshInstall`,
 * e.g. Tailscale enrolling the VM into a tailnet). The plugin owns the
 * install; this module only supplies the VM's SSH transport, records what
 * each install reported, and hands the plugin its `ref` back on delete.
 */

type SessionRow = typeof agentSessions.$inferSelect;
type ServiceInstall = SessionRow["serviceInstallsJson"][number];

const AGENT_SERVICE_SSH_READY_TIMEOUT_MS = 30 * 1000;

/**
 * Keep only accounts in this org whose plugin can install over SSH, in the
 * order given, without duplicates. Returns their plugin ids alongside, which
 * is what decides whether T3 Code can be offered over Tailscale.
 */
export async function resolveAgentServiceAccounts(
  organizationId: string,
  requested: readonly string[] | undefined,
): Promise<{ accountIds: string[]; pluginIds: string[] }> {
  if (!requested?.length) return { accountIds: [], pluginIds: [] };
  const available = await listSshInstallAccounts(organizationId);
  const accountIds: string[] = [];
  const pluginIds: string[] = [];
  for (const id of requested) {
    const match = available.find((a) => a.accountId === id);
    if (!match || accountIds.includes(id)) continue;
    accountIds.push(id);
    pluginIds.push(match.pluginId);
  }
  return { accountIds, pluginIds };
}

/**
 * Open one SSH connection to the agent VM for a plugin's install. Scripts go
 * over stdin (`execSshScript`) because installers carry short-lived secrets
 * such as enrollment keys, which must never appear in remote argv. Like the
 * rest of the agent pipeline, the VM's host key is not pinned: the VM was
 * created moments ago by this same pipeline (see `agentSshExec`).
 */
async function connectAgentServiceTransport(target: AgentSshTarget, privateKey: string) {
  const dialAddress = await resolveSafeHost(target.host);
  return new Promise<{ exec(script: string): Promise<string>; close(): void }>(
    (resolve, reject) => {
      const client = new ssh2.Client();
      client.once("ready", () =>
        resolve({ exec: (script) => execSshScript(client, script), close: () => client.end() }),
      );
      client.once("error", (err) => reject(new Error(`SSH connection failed: ${err.message}`)));
      client.connect({
        host: dialAddress,
        port: target.port,
        username: target.username,
        privateKey,
        readyTimeout: AGENT_SERVICE_SSH_READY_TIMEOUT_MS,
      });
    },
  );
}

/**
 * Install every attached service on the VM, in order. Re-running is safe:
 * plugins treat an already-installed host as a no-op (Tailscale reports
 * "already connected"). A failure throws, so setup is marked failed and
 * "Retry setup" runs the remaining services again.
 */
export async function installAgentServices(
  row: SessionRow,
  organizationId: string,
  target: AgentSshTarget,
  privateKey: string,
  log: (message: string) => Promise<void>,
): Promise<void> {
  const accountIds = row.serviceAccountIds ?? [];
  if (accountIds.length === 0) return;
  let installs: ServiceInstall[] = [...(row.serviceInstallsJson ?? [])];
  for (const accountId of accountIds) {
    const ctx = await getClientForAccount(accountId, organizationId);
    const manifest = ctx?.plugin.manifest;
    if (!ctx || !manifest?.sshInstall || !ctx.client.installOnSsh) {
      await log(`Skipped an attached service: its account is gone or cannot install over SSH.`);
      continue;
    }
    await log(`Installing ${manifest.displayName} on the VM.`);
    const transport = await connectAgentServiceTransport(target, privateKey);
    let result;
    try {
      result = await ctx.client.installOnSsh(transport);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`${manifest.displayName} installation failed: ${message}`);
    } finally {
      transport.close();
    }
    await log(`${manifest.displayName}: ${result.message}`);
    if (result.address) await log(`${manifest.displayName} address: ${result.address}`);
    for (const warning of result.warnings ?? [])
      await log(`Warning: ${manifest.displayName}: ${warning}`);
    installs = [
      ...installs.filter((i) => i.accountId !== accountId),
      {
        accountId,
        pluginId: manifest.id,
        message: result.message,
        ...(result.address ? { address: result.address } : {}),
        ...(result.ref ? { ref: result.ref } : {}),
      },
    ];
    await db
      .update(agentSessions)
      .set({ serviceInstallsJson: installs, updatedAt: new Date() })
      .where(eq(agentSessions.id, row.id));
    // So the new device shows up under the account without a manual Refresh.
    await refreshInstallerAccount(accountId, organizationId);
  }
}

/**
 * Undo each service install before the VM is destroyed (e.g. remove the
 * device from the tailnet, which would otherwise linger offline). Best effort
 * by construction: a missing account or a plugin error must not block the
 * session's deletion.
 */
export async function releaseAgentServices(
  row: Pick<SessionRow, "serviceInstallsJson">,
  organizationId: string,
): Promise<void> {
  for (const install of row.serviceInstallsJson ?? []) {
    if (!install.ref) continue;
    try {
      const ctx = await getClientForAccount(install.accountId, organizationId);
      await ctx?.client.releaseSshInstall?.(install.ref);
    } catch {
      // Best effort; see above.
      continue;
    }
    // Drop the removed device from the account's listing too.
    await refreshInstallerAccount(install.accountId, organizationId);
  }
}

/** The client-facing install list: `ref` stays on the server. */
export function publicServiceInstalls(installs: readonly ServiceInstall[] | null | undefined) {
  return (installs ?? []).map(({ accountId, pluginId, message, address }) => ({
    accountId,
    pluginId,
    message,
    ...(address ? { address } : {}),
  }));
}

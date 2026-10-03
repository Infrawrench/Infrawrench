import type { AgentServiceInstall, AgentSshTarget } from "@infrawrench/ui";
import { getDb } from "../db/client";
import { createPluginClient } from "./plugin-client";
import { invoke } from "./invoke";
import { listLocalSshInstallAccounts } from "./ssh-install";

/**
 * Desktop mirror of the cloud's `web/src/services/agent-services.ts`: accounts
 * attached to an agent session whose plugin installs a service on the VM over
 * SSH (e.g. Tailscale). The plugin owns the install; this supplies the VM's
 * SSH transport, records what each install reported, and hands the plugin its
 * `ref` back when the session is deleted.
 */

/** As stored in `agent_sessions.service_installs_json`; `ref` never leaves this module's callers. */
export type StoredServiceInstall = AgentServiceInstall & { ref?: string };

/** Keep only local accounts whose plugin can install over SSH, deduplicated, in order. */
export async function resolveLocalAgentServiceAccounts(
  requested: readonly string[] | undefined,
): Promise<{ accountIds: string[]; pluginIds: string[] }> {
  if (!requested?.length) return { accountIds: [], pluginIds: [] };
  const available = await listLocalSshInstallAccounts();
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
 * Install every attached service on the VM, in order. Scripts travel on stdin
 * (installers carry short-lived secrets), and like the rest of local agent
 * setup the freshly created VM's host key is not pinned. Plugins treat an
 * already-installed host as a no-op, so "Retry setup" is safe; a failure
 * throws so the session is marked failed.
 */
export async function installLocalAgentServices(
  sessionId: string,
  accountIds: readonly string[],
  existing: readonly StoredServiceInstall[],
  target: AgentSshTarget,
  privateKey: string,
  log: (message: string) => Promise<void>,
): Promise<void> {
  if (accountIds.length === 0) return;
  const available = await listLocalSshInstallAccounts();
  let installs: StoredServiceInstall[] = [...existing];
  const config = {
    sshHost: target.host,
    sshPort: target.port,
    sshUser: target.username,
    privateKey,
  };
  for (const accountId of accountIds) {
    const account = available.find((a) => a.accountId === accountId);
    const client = account
      ? await createPluginClient(account.accountId, account.pluginId).catch(() => null)
      : null;
    if (!account || !client?.installOnSsh) {
      await log("Skipped an attached service: its account is gone or cannot install over SSH.");
      continue;
    }
    await log(`Installing ${account.serviceName} on the VM.`);
    let result;
    try {
      result = await client.installOnSsh({
        exec: (script) =>
          invoke<string>("workflow_ssh_exec_script", { config, script, skipHostKeyCheck: true }),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`${account.serviceName} installation failed: ${message}`);
    }
    await log(`${account.serviceName}: ${result.message}`);
    if (result.address) await log(`${account.serviceName} address: ${result.address}`);
    for (const warning of result.warnings ?? [])
      await log(`Warning: ${account.serviceName}: ${warning}`);
    installs = [
      ...installs.filter((i) => i.accountId !== accountId),
      {
        accountId,
        pluginId: account.pluginId,
        message: result.message,
        ...(result.address ? { address: result.address } : {}),
        ...(result.ref ? { ref: result.ref } : {}),
      },
    ];
    const db = await getDb();
    await db.execute("UPDATE agent_sessions SET service_installs_json = $1 WHERE id = $2", [
      JSON.stringify(installs),
      sessionId,
    ]);
  }
}

/**
 * Undo each install once the VM is gone (e.g. remove the tailnet device).
 * Best effort: a missing account or a plugin error never blocks deletion.
 */
export async function releaseLocalAgentServices(
  installs: readonly StoredServiceInstall[],
): Promise<void> {
  for (const install of installs) {
    if (!install.ref) continue;
    try {
      const client = await createPluginClient(install.accountId, install.pluginId);
      await client.releaseSshInstall?.(install.ref);
    } catch {
      // Best effort; see above.
    }
  }
}

/** The client-facing install list: `ref` stays local to the pipeline. */
export function publicLocalServiceInstalls(
  installs: readonly StoredServiceInstall[],
): AgentServiceInstall[] {
  return installs.map(({ accountId, pluginId, message, address }) => ({
    accountId,
    pluginId,
    message,
    ...(address ? { address } : {}),
  }));
}

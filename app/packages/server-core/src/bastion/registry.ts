/**
 * Where plugin HTTP code finds a bastion agent's `Dispatcher`.
 *
 * Two places, in order: an agent connected to this very process (the Node
 * endpoint, `web/services/bastion-ws.ts`, which is what local development and
 * a single-process self-host use), then the realtime relay
 * (`realtime/protocol.ts`), where production agents connect: a Durable Object
 * per bastion that every Node runtime can reach, so a bastion-bound account
 * works from any session gateway replica and from the Lambdas alike.
 */

import { eq, and, isNull } from "drizzle-orm";
import { db } from "../db/client.js";
import { accounts, bastionVms } from "../db/schema.js";
import { buildAad, decrypt } from "../encryption.js";
import { getPlugin } from "../plugin-loader.js";
import { providerHostsOf } from "./account-hosts.js";
import { PUBLIC_ONLY_PREFIX } from "./protocol.js";
import { BastionAgentConnection } from "./dispatcher.js";
import { remoteDispatcherFor, updateRemoteAllowlist } from "./remote.js";
import { realtimeEnabled, realtimeFetch } from "../realtime/client.js";
import { bastionAllowlistPath, REALTIME_PREFIX } from "../realtime/protocol.js";

export { BastionAgentConnection };

const connections = new Map<string, BastionAgentConnection>();

/** Register a freshly authenticated agent. Replaces any prior connection for the same bastion. */
export async function registerAgentConnection(conn: BastionAgentConnection): Promise<void> {
  const prior = connections.get(conn.bastionId);
  if (prior) {
    await prior.destroy(new Error("Replaced by a newer agent connection"));
  }
  connections.set(conn.bastionId, conn);
  await refreshAllowlistFromDb(conn);
}

/** Drop an agent from the registry (called on WS close). */
export async function unregisterAgentConnection(bastionId: string): Promise<void> {
  const conn = connections.get(bastionId);
  if (!conn) return;
  connections.delete(bastionId);
  await conn.destroy();
}

/**
 * Return the dispatcher for `bastionId` if an agent is currently connected.
 * `null` ⇒ bastion is bound but offline: callers should surface
 * `BastionDisconnectedError` rather than falling back to direct egress.
 */
export function getDispatcherFor(bastionId: string): import("undici").Dispatcher | null {
  const conn = connections.get(bastionId);
  return conn?.dispatcher ?? null;
}

/**
 * The dispatcher for `bastionId`: the local agent if it dialled this process,
 * else the relay's. `null` ⇒ the agent is offline everywhere: callers surface
 * `BastionDisconnectedError` rather than falling back to direct egress.
 */
export async function resolveDispatcher(
  bastionId: string,
): Promise<import("undici").Dispatcher | null> {
  return (
    getDispatcherFor(bastionId) ??
    (await remoteDispatcherFor(bastionId, () => computeAllowlist(bastionId)))
  );
}

/** `true` when an agent is live for this bastion in this process. */
export function isBastionConnected(bastionId: string): boolean {
  return connections.has(bastionId);
}

export interface BastionLiveStatus {
  connected: boolean;
  /** Reported by the agent on connect (relay only; the local path writes it to the row). */
  agentVersion: string | null;
}

/**
 * Live status for a set of bastions: connected here, or connected to the
 * relay. A relay that cannot be asked reports everyone as not connected
 * rather than failing the caller (a status list).
 */
export async function bastionLiveStatuses(ids: string[]): Promise<Map<string, BastionLiveStatus>> {
  const out = new Map<string, BastionLiveStatus>(
    ids.map((id) => [id, { connected: connections.has(id), agentVersion: null }]),
  );
  const remote = ids.filter((id) => !connections.has(id));
  if (remote.length === 0 || !realtimeEnabled()) return out;
  try {
    const response = await realtimeFetch(`${REALTIME_PREFIX}/bastions/status`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ids: remote }),
    });
    if (!response.ok) throw new Error(`relay answered HTTP ${response.status}`);
    const statuses = (await response.json()) as Record<
      string,
      { connected: boolean; agentVersion: string | null }
    >;
    for (const id of remote) {
      const status = statuses[id];
      if (status) out.set(id, { connected: status.connected, agentVersion: status.agentVersion });
    }
  } catch (err) {
    console.error(
      "[bastion] relay status lookup failed:",
      err instanceof Error ? err.message : err,
    );
  }
  return out;
}

/**
 * Recompute and push the destination allowlist to the agent. Called when
 * accounts referencing this bastion change, or the host one of them configured.
 */
export async function refreshAllowlistFromDb(conn: BastionAgentConnection): Promise<void> {
  conn.setAllowlist(await computeAllowlist(conn.bastionId));
}

/** The destination allowlist for a bastion, from the accounts that reference it. */
export async function computeAllowlist(bastionId: string): Promise<string[]> {
  const rows = await db
    .select({
      id: accounts.id,
      pluginId: accounts.pluginId,
      encryptedCredentials: accounts.encryptedCredentials,
      credentialsIv: accounts.credentialsIv,
    })
    .from(accounts)
    .where(and(eq(accounts.bastionId, bastionId), isNull(accounts.deletedAt)));
  const [manifestHosts, ownHosts] = await Promise.all([
    allowlistForPlugins(new Set(rows.map((r) => r.pluginId))),
    Promise.all(rows.map(accountOwnHosts)),
  ]);
  const own = [...new Set(ownHosts.flat())];
  return [...manifestHosts, ...own.map((host) => `${PUBLIC_ONLY_PREFIX}${host}`)];
}

/**
 * The hosts this account's credentials name, for a plugin with a field marked
 * `providerHost`. One account that cannot be read must not take the rest of the
 * bastion's accounts down with it, so its host is left off and its calls are refused.
 */
async function accountOwnHosts(row: {
  id: string;
  pluginId: string;
  encryptedCredentials: string;
  credentialsIv: string;
}): Promise<string[]> {
  const loaded = await getPlugin(row.pluginId);
  const fields = loaded?.plugin.manifest.credentialFields ?? [];
  if (!fields.some((field) => field.providerHost)) return [];
  try {
    const credentials = JSON.parse(
      await decrypt(
        row.encryptedCredentials,
        row.credentialsIv,
        buildAad("account", row.id, "credentials"),
      ),
    ) as Record<string, string>;
    return providerHostsOf(fields, credentials);
  } catch (err) {
    console.error(
      `[bastion] reading the configured host of account ${row.id} failed:`,
      err instanceof Error ? err.message : err,
    );
    return [];
  }
}

/** Record an agent connect: `status` active and `lastSeenAt` now. */
export async function markBastionActive(bastionId: string): Promise<void> {
  await db
    .update(bastionVms)
    .set({ status: "active", lastSeenAt: new Date() })
    .where(eq(bastionVms.id, bastionId));
}

/**
 * Map plugin ids → wildcard hostnames the agent should permit. Conservative
 * by design: each plugin contributes only the cloud-control-plane suffixes
 * it actually calls, so a compromised backend can't ask the agent to fetch
 * `169.254.169.254` or arbitrary user URLs. A host a user typed comes from
 * `computeAllowlist` instead, under a prefix the agent treats as public only.
 *
 * Entries starting with `*.` are suffix matches.
 */
export async function allowlistForPlugins(pluginIds: Iterable<string>): Promise<string[]> {
  const out = new Set<string>();
  for (const id of pluginIds) {
    const loaded = await getPlugin(id);
    for (const host of loaded?.plugin.manifest.egressHosts ?? []) out.add(host);
  }
  return [...out];
}

/**
 * Trigger an allowlist refresh for the bastion (if connected): call after
 * routes that mutate which accounts reference the bastion.
 */
export async function refreshAllowlistById(bastionId: string): Promise<void> {
  const conn = connections.get(bastionId);
  if (conn) await refreshAllowlistFromDb(conn);
  if (!realtimeEnabled()) return;
  const allowlist = await computeAllowlist(bastionId);
  await updateRemoteAllowlist(bastionId, allowlist);
  // The relay re-sends hello with it, which is how the agent learns.
  const response = await realtimeFetch(bastionAllowlistPath(bastionId), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ allowlist }),
  });
  if (!response.ok) throw new Error(`relay answered HTTP ${response.status}`);
}

/**
 * Look up a bastion row by hashed token. Returns `null` for unknown / revoked
 * tokens. Used at WS-connect time to authenticate the agent.
 */
export async function findBastionByHashedToken(
  hashedToken: string,
): Promise<{ id: string; organizationId: string } | null> {
  const [row] = await db
    .select({
      id: bastionVms.id,
      organizationId: bastionVms.organizationId,
      revokedAt: bastionVms.revokedAt,
    })
    .from(bastionVms)
    .where(eq(bastionVms.hashedToken, hashedToken))
    .limit(1);
  if (!row) return null;
  if (row.revokedAt) return null;
  return { id: row.id, organizationId: row.organizationId };
}

/** For tests / shutdown: tear down everything. */
export async function destroyAllAgentConnections(): Promise<void> {
  const all = [...connections.values()];
  connections.clear();
  await Promise.all(all.map((c) => c.destroy()));
}

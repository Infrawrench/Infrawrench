/**
 * In-memory registry of currently-connected bastion agents.
 *
 * The web process accepts WS connections from bastion-agent containers; each
 * connection registers itself here so plugin HTTP code can resolve a
 * `Dispatcher` by bastion id. The map is single-process; for multi-instance
 * routing we'd need cross-process lookup (out of scope for v1, but the
 * `Promise<Dispatcher | null>` interface makes the swap local).
 */

import { eq, and } from "drizzle-orm";
import { db } from "../db/client.js";
import { accounts, bastionVms } from "../db/schema.js";
import { BastionAgentConnection } from "./dispatcher.js";

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
 * `null` ⇒ bastion is bound but offline — callers should surface
 * `BastionDisconnectedError` rather than falling back to direct egress.
 */
export function getDispatcherFor(bastionId: string): import("undici").Dispatcher | null {
  const conn = connections.get(bastionId);
  return conn?.dispatcher ?? null;
}

/** `true` when an agent is live for this bastion. Used by status endpoints. */
export function isBastionConnected(bastionId: string): boolean {
  return connections.has(bastionId);
}

/**
 * Recompute and push the destination allowlist to the agent. Called when
 * accounts referencing this bastion change.
 */
export async function refreshAllowlistFromDb(conn: BastionAgentConnection): Promise<void> {
  const rows = await db
    .select({ pluginId: accounts.pluginId })
    .from(accounts)
    .where(and(eq(accounts.bastionId, conn.bastionId)));
  const plugins = new Set(rows.map((r) => r.pluginId));
  conn.setAllowlist(allowlistForPlugins(plugins));
}

/**
 * Map plugin ids → wildcard hostnames the agent should permit. Conservative
 * by design: each plugin contributes only the cloud-control-plane suffixes
 * it actually calls, so a compromised backend can't ask the agent to fetch
 * `169.254.169.254` or arbitrary user URLs.
 *
 * Entries starting with `*.` are suffix matches.
 */
export function allowlistForPlugins(pluginIds: Iterable<string>): string[] {
  const out = new Set<string>();
  for (const id of pluginIds) {
    for (const host of PLUGIN_ALLOWLIST[id] ?? []) out.add(host);
  }
  return [...out];
}

const PLUGIN_ALLOWLIST: Record<string, string[]> = {
  aws: ["*.amazonaws.com", "*.aws.amazon.com"],
  gcp: ["*.googleapis.com", "*.google.com"],
  azure: [
    "*.azure.com",
    "*.windows.net",
    "*.microsoftonline.com",
    "management.azure.com",
    "login.microsoftonline.com",
  ],
  digitalocean: ["api.digitalocean.com"],
  hetzner: ["api.hetzner.cloud", "robot-ws.your-server.de"],
  fly: ["api.machines.dev", "api.fly.io"],
  vercel: ["api.vercel.com"],
  netlify: ["api.netlify.com"],
  planetscale: ["api.planetscale.com"],
  cloudflare: ["api.cloudflare.com"],
  cloudinary: ["api.cloudinary.com"],
  databricks: ["*.cloud.databricks.com", "*.azuredatabricks.net", "*.gcp.databricks.com"],
  neon: ["console.neon.tech"],
  turso: ["api.turso.tech"],
  ovh: ["*.ovh.com"],
  scaleway: ["api.scaleway.com"],
  vultr: ["api.vultr.com"],
  kubernetes: [], // kubeconfig-relative; v1 doesn't bastion-route Kubernetes
};

/**
 * Trigger an allowlist refresh for the bastion (if connected) — call after
 * routes that mutate which accounts reference the bastion.
 */
export async function refreshAllowlistById(bastionId: string): Promise<void> {
  const conn = connections.get(bastionId);
  if (!conn) return;
  await refreshAllowlistFromDb(conn);
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

/**
 * Resolves tunneled connections for accounts with ssh_tunnel_configs rows.
 * When a plugin client needs to connect to a remote service, this checks if
 * the account has an SSH tunnel config and transparently rewrites the
 * connection string to route through a server-side tunnel.
 */
import { eq } from "drizzle-orm";
import {
  openTunnel as coreOpenTunnel,
  findTunnel,
  type TunnelExtras,
} from "@infrawrench/ssh-tunnel-core";
import { db } from "./db/client";
import { sshTunnelConfigs } from "./db/schema";
import { decrypt } from "./encryption";

function findTunnelForAccount(accountId: string): { localPort: number } | null {
  const r = findTunnel<TunnelExtras>((rec) => rec.extras.accountId === accountId);
  return r ? { localPort: r.localPort } : null;
}

export type TunnelResolution =
  | { status: "ok"; localPort: number }
  | { status: "none" }
  | { status: "error"; cause: unknown };

/**
 * If the account has an ssh_tunnel_configs row, ensures the SSH tunnel is open
 * and returns `{ status: "ok", localPort }`. If the account has no tunnel
 * config, returns `{ status: "none" }`. If tunnel resolution itself fails
 * (DB lookup, decryption, openTunnel), returns `{ status: "error", cause }`
 * — callers can disambiguate "no tunnel configured" from "tunnel resolution
 * exploded" instead of treating both as null.
 */
async function resolveTunnelForAccount(accountId: string): Promise<TunnelResolution> {
  try {
    const existing = findTunnelForAccount(accountId);
    if (existing) return { status: "ok", localPort: existing.localPort };

    const [config] = await db
      .select()
      .from(sshTunnelConfigs)
      .where(eq(sshTunnelConfigs.accountId, accountId))
      .limit(1);

    if (!config) return { status: "none" };

    const privateKey = await decrypt(config.encryptedPrivateKey, config.privateKeyIv);
    const { localPort } = await coreOpenTunnel<TunnelExtras>(
      {
        sshHost: config.sshHost,
        sshPort: config.sshPort,
        sshUser: config.sshUser,
        privateKey,
        remoteHost: config.remoteHost,
        remotePort: config.remotePort,
      },
      { organizationId: config.organizationId, accountId },
    );

    return { status: "ok", localPort };
  } catch (cause) {
    return { status: "error", cause };
  }
}

/**
 * Rewrites all credential values for an account through a tunnel if one exists.
 * Should be called before creating a plugin client from decrypted credentials.
 */
export async function rewriteCredentialsThroughTunnel(
  accountId: string,
  credentials: Record<string, string>,
): Promise<void> {
  const tunnel = await tryResolveTunnel(accountId);
  if (!tunnel) return;
  for (const key of Object.keys(credentials)) {
    credentials[key] = applyTunnelToConnectionString(credentials[key]!, tunnel.localPort);
  }
}

/**
 * Rewrites a single connection string to route through a tunnel if the account has one.
 * Handles common connection string formats:
 *   - tcp://host:port  → tcp://127.0.0.1:{localPort}
 *   - protocol://user:pass@host:port/db → protocol://user:pass@127.0.0.1:{localPort}/db
 *   - host:port → 127.0.0.1:{localPort}
 */
export async function rewriteConnectionForTunnel(
  accountId: string,
  connectionString: string,
): Promise<string> {
  const tunnel = await tryResolveTunnel(accountId);
  if (!tunnel) return connectionString;
  return applyTunnelToConnectionString(connectionString, tunnel.localPort);
}

async function tryResolveTunnel(accountId: string): Promise<{ localPort: number } | null> {
  const result = await resolveTunnelForAccount(accountId);
  if (result.status === "ok") return { localPort: result.localPort };
  if (result.status === "error") {
    console.error(
      "[tunnel-resolver] Failed to resolve tunnel for account",
      accountId,
      result.cause instanceof Error ? result.cause.message : result.cause,
    );
  }
  return null;
}

function applyTunnelToConnectionString(connectionString: string, localPort: number): string {
  try {
    const url = new URL(connectionString);
    url.hostname = "127.0.0.1";
    url.port = String(localPort);
    return url.toString();
  } catch {
    // Not a URL — try host:port pattern
    if (/^(.+):(\d+)$/.test(connectionString)) {
      return `127.0.0.1:${localPort}`;
    }
    return connectionString;
  }
}

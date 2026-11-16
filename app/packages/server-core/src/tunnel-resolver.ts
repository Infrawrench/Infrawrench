/**
 * Resolves tunneled connections for accounts with ssh_tunnel_configs rows.
 * When a plugin client needs to connect to a remote service, this checks if
 * the account has an SSH tunnel config and transparently rewrites the
 * service's address to route through a server-side tunnel. What is rewritten,
 * and how, is `credential-rewriters/tunnel-form.ts`.
 */
import { eq } from "drizzle-orm";
import {
  openTunnel as coreOpenTunnel,
  findTunnel,
  type TunnelExtras,
} from "@infrawrench/ssh-tunnel-core";
import { db } from "./db/client";
import { sshTunnelConfigs } from "./db/schema";
import { decrypt, buildAad } from "./encryption";
import { resolveSafeHost } from "./egress-guard";
import type { CredentialField } from "@infrawrench/plugin-base";
import {
  rewriteCredentialFields,
  rewriteValueThroughTunnel,
  type TunnelEnds,
} from "./credential-rewriters/tunnel-form";

function findTunnelForAccount(accountId: string): { localPort: number } | null {
  const r = findTunnel<TunnelExtras>((rec) => rec.extras.accountId === accountId);
  return r ? { localPort: r.localPort } : null;
}

export type TunnelResolution =
  { status: "ok"; tunnel: TunnelEnds } | { status: "none" } | { status: "error"; cause: unknown };

/**
 * If the account has an ssh_tunnel_configs row, ensures the SSH tunnel is open
 * and returns `{ status: "ok", tunnel }`: its local port and the remote end the
 * config names, which the rewriter matches addresses against. If the account
 * has no tunnel config, returns `{ status: "none" }`. If tunnel resolution
 * itself fails (DB lookup, decryption, openTunnel), returns
 * `{ status: "error", cause }`: callers can disambiguate "no tunnel configured"
 * from "tunnel resolution exploded" instead of treating both as null.
 */
async function resolveTunnelForAccount(accountId: string): Promise<TunnelResolution> {
  try {
    const [config] = await db
      .select()
      .from(sshTunnelConfigs)
      .where(eq(sshTunnelConfigs.accountId, accountId))
      .limit(1);

    if (!config) return { status: "none" };
    const remote = { remoteHost: config.remoteHost, remotePort: config.remotePort };

    const existing = findTunnelForAccount(accountId);
    if (existing) return { status: "ok", tunnel: { localPort: existing.localPort, ...remote } };

    const privateKey = await decrypt(
      config.encryptedPrivateKey,
      config.privateKeyIv,
      buildAad("sshTunnelConfig", config.id, "privateKey"),
    );
    // The bastion endpoint is the one hop this process dials itself; vet it
    // like every other tenant-supplied destination. `remoteHost` is reached
    // from the bastion, so a private address there is the point.
    await resolveSafeHost(config.sshHost);
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

    return { status: "ok", tunnel: { localPort, ...remote } };
  } catch (cause) {
    return { status: "error", cause };
  }
}

/**
 * Points an account's credentials at its SSH tunnel, if it has one: the fields
 * the plugin marked `tunnel`, and only their addresses (see `tunnel-form.ts`).
 * `peer` is set for a peer plugin's credentials, which only an address naming
 * the tunnel's remote end changes. Should be called before creating a plugin
 * client from decrypted credentials. Returns the keys it changed.
 */
export async function rewriteCredentialsThroughTunnel(
  accountId: string,
  fields: readonly CredentialField[],
  credentials: Record<string, string>,
  { peer = false }: { peer?: boolean } = {},
): Promise<string[]> {
  if (!fields.some((f) => f.tunnel)) return [];
  const tunnel = await tryResolveTunnel(accountId);
  if (!tunnel) return [];
  return rewriteCredentialFields(fields, credentials, tunnel, { fallback: !peer });
}

/**
 * Points one of the account's own connection strings (a driver's credential, or
 * one a resource of the account resolves to) at its SSH tunnel, if it has one,
 * as an `address` field is. A value already pointed there is left as it is.
 */
export async function rewriteConnectionForTunnel(
  accountId: string,
  connectionString: string,
): Promise<string> {
  const tunnel = await tryResolveTunnel(accountId);
  if (!tunnel) return connectionString;
  return rewriteValueThroughTunnel("address", connectionString, tunnel, { fallback: true });
}

async function tryResolveTunnel(accountId: string): Promise<TunnelEnds | null> {
  const result = await resolveTunnelForAccount(accountId);
  if (result.status === "ok") return result.tunnel;
  if (result.status === "error") {
    console.error(
      "[tunnel-resolver] Failed to resolve tunnel for account",
      accountId,
      result.cause instanceof Error ? result.cause.message : result.cause,
    );
  }
  return null;
}

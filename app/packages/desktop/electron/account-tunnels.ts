/**
 * Local accounts' SSH tunnels: the desktop's counterpart of server-core's
 * `tunnel-resolver.ts`. An account made with "Connect to service via SSH" (or
 * Docker setup on a VM) stores its service's address as the bastion sees it,
 * `postgresql://localhost:5432/postgres`, plus an `ssh_tunnel_configs` row.
 * Before a plugin client connects with those credentials, the fields its plugin
 * marked `tunnel` are pointed at the local end of the account's tunnel, which is
 * opened here when it is not already (after a restart, or once the modal's own
 * tunnel is gone). What changes in a value, and what never does, is
 * `@infrawrench/client-core/tunnel-form`, shared with the server.
 *
 * Callers: the renderer's rewriter chain over `SshTunnelAccountCredentials`
 * (every client the GUI builds for a local account), and `plugin-runtime.ts`
 * (the CLI and the environment diff). Never store what this returns: the local
 * port changes every time a tunnel opens.
 *
 * No import-time side effects: the CLI loads it with `plugin-runtime.ts`.
 */
import {
  rewriteCredentialFields,
  type TunnelEnds,
  type TunnelFieldDeclaration,
} from "@infrawrench/client-core/tunnel-form";
import { Context, Effect, Layer } from "effect";
import { errorMessage } from "../shared/rpc/errors";
import { SshError } from "../shared/rpc/groups/ssh-common";
import { getSqlite } from "./db";
import { buildAad, decryptValue, getEncryptionKey } from "./main-utils";
import { findAccountTunnel, openTunnel } from "./ssh-tunnel";

interface TunnelConfigRow {
  id: string;
  sshHost: string;
  sshPort: number;
  sshUser: string;
  remoteHost: string;
  remotePort: number;
  encryptedPrivateKey: string;
  privateKeyIv: string;
}

async function readTunnelConfig(accountId: string): Promise<TunnelConfigRow | null> {
  const db = await getSqlite();
  const stmt = db.prepare(
    `SELECT id, ssh_host, ssh_port, ssh_user, remote_host, remote_port, encrypted_private_key, private_key_iv
     FROM ssh_tunnel_configs WHERE account_id = ? LIMIT 1`,
  );
  try {
    stmt.bind([accountId]);
    if (!stmt.step()) return null;
    const row = stmt.getAsObject();
    return {
      id: String(row["id"]),
      sshHost: String(row["ssh_host"]),
      sshPort: Number(row["ssh_port"]),
      sshUser: String(row["ssh_user"]),
      remoteHost: String(row["remote_host"]),
      remotePort: Number(row["remote_port"]),
      encryptedPrivateKey: String(row["encrypted_private_key"]),
      privateKeyIv: String(row["private_key_iv"]),
    };
  } finally {
    stmt.free();
  }
}

/** One open account tunnel per account at a time, however many clients ask at once. */
const opening = new Map<string, Promise<number>>();

/**
 * The local port of the account's tunnel: one already open to the same place (this
 * account's, or the one the modal opened when it made the account), or a new one.
 */
async function ensureTunnel(accountId: string, config: TunnelConfigRow): Promise<number> {
  const open = findAccountTunnel(accountId, config);
  if (open !== null) return open;
  const pending = opening.get(accountId);
  if (pending) return pending;
  const started = (async () => {
    const privateKey = decryptValue(
      config.encryptedPrivateKey,
      config.privateKeyIv,
      getEncryptionKey(),
      // The AAD `LocalSecrets.encryptTunnelConfigKey` stored it under.
      buildAad("sshTunnelConfig", config.id, "privateKey"),
    );
    const { localPort } = await openTunnel(
      {
        sshHost: config.sshHost,
        sshPort: config.sshPort,
        sshUser: config.sshUser,
        privateKey,
        remoteHost: config.remoteHost,
        remotePort: config.remotePort,
      },
      { accountId },
    );
    return localPort;
  })().finally(() => opening.delete(accountId));
  opening.set(accountId, started);
  return started;
}

/**
 * Points a local account's credentials at its SSH tunnel, in place, when it has one:
 * the fields marked `tunnel`, and only their addresses. `peer` is set for a peer
 * plugin's credentials (resolved from a resource's outputs), which only an address
 * naming the tunnel's remote end changes. Returns the keys it changed. Throws when
 * the account has a tunnel that cannot be opened, so the caller does not quietly
 * connect to whatever listens on this computer's own port.
 */
export async function tunnelAccountCredentials(
  accountId: string,
  fields: readonly TunnelFieldDeclaration[],
  credentials: Record<string, string>,
  { peer = false }: { peer?: boolean } = {},
): Promise<string[]> {
  if (!fields.some((f) => f.tunnel !== undefined)) return [];
  const config = await readTunnelConfig(accountId);
  if (!config) return [];
  let localPort: number;
  try {
    localPort = await ensureTunnel(accountId, config);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`Could not open the SSH tunnel through ${config.sshHost}: ${reason}`);
  }
  const tunnel: TunnelEnds = {
    localPort,
    remoteHost: config.remoteHost,
    remotePort: config.remotePort,
  };
  return rewriteCredentialFields(fields, credentials, tunnel, { fallback: !peer });
}

/** {@link tunnelAccountCredentials} for the RPC handlers, on a copy of the credentials. */
export class AccountTunnels extends Context.Service<
  AccountTunnels,
  {
    readonly credentials: (
      accountId: string,
      fields: readonly TunnelFieldDeclaration[],
      credentials: Readonly<Record<string, string>>,
      options: { peer: boolean },
    ) => Effect.Effect<Record<string, string>, SshError>;
  }
>()("infrawrench/desktop/AccountTunnels") {
  static readonly layer = Layer.succeed(AccountTunnels)(
    AccountTunnels.of({
      credentials: (accountId, fields, credentials, options) =>
        Effect.tryPromise({
          try: async () => {
            const copy = { ...credentials };
            await tunnelAccountCredentials(accountId, fields, copy, options);
            return copy;
          },
          catch: (cause) => new SshError({ message: errorMessage(cause) }),
        }),
    }),
  );
}

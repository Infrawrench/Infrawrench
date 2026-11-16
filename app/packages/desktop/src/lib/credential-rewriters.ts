/**
 * Renderer-side credential-rewriter chain. Mirrors
 * `app/packages/server-core/src/credential-rewriters/` so the desktop and web
 * use the same `CredentialRewriter` shape (declared in `@infrawrench/plugin-base`),
 * but the desktop chain is its own registry because it runs in the renderer
 * with renderer-flavored data lookups (no server-core DB imports).
 *
 * Run it over a local account's credentials (or a peer plugin's, resolved from
 * one of its resources) before building a plugin client from them, never over
 * credentials that are about to be stored or shown for editing.
 */

import type { CredentialRewriter, RewriterContext } from "@infrawrench/plugin-base";
import { DesktopRpcClient, runRpc } from "./rpc/client";

/**
 * SSH tunnel: an account made with "Connect to service via SSH" stores its service's
 * address as the bastion sees it. The main process opens the account's tunnel (from
 * `ssh_tunnel_configs`) when it is not open, and points the fields the plugin marked
 * `tunnel` at its local end, the same way the server does for cloud accounts
 * (`@infrawrench/client-core/tunnel-form`). Nothing to ask for when the plugin marks
 * no field.
 */
const sshTunnelRewriter: CredentialRewriter = {
  async rewrite(ctx, credentials) {
    const fields = ctx.credentialFields.flatMap((f) =>
      f.tunnel ? [{ key: f.key, tunnel: f.tunnel }] : [],
    );
    // Only the marked values cross: nothing else is ever rewritten.
    const marked: Record<string, string> = {};
    for (const { key } of fields) {
      const value = credentials[key];
      if (value !== undefined) marked[key] = value;
    }
    if (Object.keys(marked).length === 0) return;
    const rewritten = await runRpc(
      DesktopRpcClient.use((rpc) =>
        rpc.SshTunnelAccountCredentials({
          accountId: ctx.accountId,
          fields,
          credentials: marked,
          ...(ctx.peerPluginId === undefined ? {} : { peer: true }),
        }),
      ),
    );
    for (const key of Object.keys(marked)) {
      const value = rewritten[key];
      if (value !== undefined) credentials[key] = value;
    }
  },
};

const rewriters: CredentialRewriter[] = [sshTunnelRewriter];

/**
 * Run the chain over `credentials` in place. True when it changed any of them:
 * they then point at something only this computer can reach.
 */
export async function applyCredentialRewriters(
  ctx: RewriterContext,
  credentials: Record<string, string>,
): Promise<boolean> {
  const before = { ...credentials };
  for (const r of rewriters) {
    await r.rewrite(ctx, credentials);
  }
  const keys = new Set([...Object.keys(before), ...Object.keys(credentials)]);
  return [...keys].some((key) => before[key] !== credentials[key]);
}

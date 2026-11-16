import { rewriteCredentialsThroughTunnel } from "../tunnel-resolver";
import type { CredentialRewriter } from "./types";

/**
 * SSH-tunnel rewriter. Thin adapter around `tunnel-resolver` that points the
 * fields a plugin marked `tunnel` at a per-account SSH tunnel when one is
 * configured. Always applies: `rewriteCredentialsThroughTunnel` is a no-op
 * for accounts without a tunnel. A peer plugin's credentials only have the
 * addresses that name the tunnel's remote end rewritten.
 */
export const sshTunnelRewriter: CredentialRewriter = {
  async rewrite(ctx, credentials) {
    await rewriteCredentialsThroughTunnel(ctx.accountId, ctx.credentialFields, credentials, {
      peer: ctx.peerPluginId !== undefined,
    });
  },
};

import { rewriteCredentialsThroughTunnel } from "../tunnel-resolver";
import type { CredentialRewriter } from "./types";

/**
 * SSH-tunnel rewriter. Thin adapter around the legacy `tunnel-resolver` that
 * routes account credentials through a per-account SSH tunnel when one is
 * configured. Always applies — `rewriteCredentialsThroughTunnel` is a no-op
 * for accounts without a tunnel.
 */
export const sshTunnelRewriter: CredentialRewriter = {
  async rewrite(ctx, credentials) {
    await rewriteCredentialsThroughTunnel(ctx.accountId, credentials);
  },
};

import { sshTunnelRewriter } from "./ssh-tunnel";
import type { CredentialRewriter, RewriterContext } from "./types";

const rewriters: CredentialRewriter[] = [sshTunnelRewriter];

/**
 * Register an additional rewriter. Rewriters run in registration order, so
 * later registrations see credentials already mutated by earlier ones. Use
 * this to plug in transports that depend on a tunneled base (rare — most
 * rewriters operate on the raw credential values).
 */
export function registerCredentialRewriter(rewriter: CredentialRewriter): void {
  rewriters.push(rewriter);
}

/** Run the registered rewriter chain over `credentials` in place. */
export async function applyCredentialRewriters(
  ctx: RewriterContext,
  credentials: Record<string, string>,
): Promise<void> {
  for (const r of rewriters) {
    await r.rewrite(ctx, credentials);
  }
}

export type { CredentialRewriter, RewriterContext } from "./types";

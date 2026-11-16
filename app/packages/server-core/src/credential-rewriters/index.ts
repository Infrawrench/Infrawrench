import { sshTunnelRewriter } from "./ssh-tunnel";
import type { CredentialRewriter, RewriterContext } from "./types";

const rewriters: CredentialRewriter[] = [sshTunnelRewriter];

/**
 * Register an additional rewriter. Rewriters run in registration order, so
 * later registrations see credentials already mutated by earlier ones. Use
 * this to plug in transports that depend on a tunneled base (rare: most
 * rewriters operate on the raw credential values).
 */
export function registerCredentialRewriter(rewriter: CredentialRewriter): void {
  rewriters.push(rewriter);
}

/**
 * Run the registered rewriter chain over `credentials` in place. True when it
 * changed any of them: they then point at something only this process can
 * reach (the local end of an SSH tunnel), which CI lending refuses to hand out.
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

export type { CredentialRewriter, RewriterContext } from "./types";

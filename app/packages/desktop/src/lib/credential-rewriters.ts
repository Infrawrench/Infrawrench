/**
 * Renderer-side credential-rewriter chain. Mirrors
 * `app/packages/server-core/src/credential-rewriters/` so the desktop and web
 * use the same `CredentialRewriter` shape (declared in `@infrawrench/plugin-base`),
 * but the desktop chain is its own registry because it runs in the renderer
 * with renderer-flavored data lookups (no server-core DB imports).
 */

import type { CredentialRewriter, RewriterContext } from "@infrawrench/plugin-base";

const rewriters: CredentialRewriter[] = [];

export async function applyCredentialRewriters(
  ctx: RewriterContext,
  credentials: Record<string, string>,
): Promise<void> {
  for (const r of rewriters) {
    await r.rewrite(ctx, credentials);
  }
}

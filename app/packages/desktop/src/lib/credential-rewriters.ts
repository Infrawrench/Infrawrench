/**
 * Renderer-side credential-rewriter chain. Mirrors
 * `app/packages/server-core/src/credential-rewriters/` so the desktop and web
 * use the same `CredentialRewriter` shape, but the desktop chain is its own
 * registry because it runs in the renderer with renderer-flavored data
 * lookups (no server-core DB imports).
 */

export interface RewriterContext {
  accountId: string;
  resourcePluginId?: string | undefined;
  resourceTypeId?: string | undefined;
  resourceId?: string | undefined;
  /**
   * Live fields and outputs of the resource the credentials will be used
   * against. The peer-pane code passes these from the in-memory parent
   * `ResourceInstance` so rewriters don't have to re-fetch from SQLite (which
   * on desktop only stores pinned resources, and never persists outputs).
   */
  resourceFields?: Record<string, unknown> | undefined;
  resourceOutputs?: Record<string, unknown> | undefined;
}

export interface CredentialRewriter {
  rewrite(ctx: RewriterContext, credentials: Record<string, string>): Promise<void>;
}

const rewriters: CredentialRewriter[] = [];

export function registerCredentialRewriter(r: CredentialRewriter): void {
  rewriters.push(r);
}

export async function applyCredentialRewriters(
  ctx: RewriterContext,
  credentials: Record<string, string>,
): Promise<void> {
  for (const r of rewriters) {
    await r.rewrite(ctx, credentials);
  }
}

/**
 * Credential rewriters transform a plugin's resolved credentials before the
 * plugin client is created. Each rewriter inspects the context — which
 * account / resource the credentials belong to — and decides whether to
 * mutate the credential map in place.
 *
 * The chain is composed in `./index.ts`. Today it contains the SSH-tunnel
 * rewriter (legacy `tunnel-resolver.ts`); other rewriters (e.g. Cloud SQL
 * Auth Proxy) are added by registering them at startup.
 */

export interface RewriterContext {
  /** Org the account belongs to. Optional for desktop / single-tenant flows. */
  orgId?: string | undefined;
  /** Account whose credentials are being rewritten. Always present. */
  accountId: string;
  /**
   * The resource the credentials will be used against. Set for rewriters
   * that need resource-level context — e.g. Cloud SQL Auth Proxy needs the
   * cloudsql-instance's `databaseVersion` field and `connectionName` output.
   *
   * Callers that have the parent resource on hand (peer-pane render, resource
   * detail) populate `resourceFields` / `resourceOutputs` directly so rewriters
   * never have to round-trip through storage to read what's already in memory.
   */
  resourcePluginId?: string | undefined;
  resourceTypeId?: string | undefined;
  resourceId?: string | undefined;
  resourceFields?: Record<string, unknown> | undefined;
  resourceOutputs?: Record<string, unknown> | undefined;
}

export interface CredentialRewriter {
  /**
   * Mutate `credentials` in place if this rewriter applies to `ctx`. Errors
   * thrown here propagate to the caller; rewriters that can't apply should
   * silently return.
   */
  rewrite(ctx: RewriterContext, credentials: Record<string, string>): Promise<void>;
}

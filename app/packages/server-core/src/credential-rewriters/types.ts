/**
 * Credential rewriters transform a plugin's resolved credentials before the
 * plugin client is created. Each rewriter inspects the context — which
 * account / resource the credentials belong to — and decides whether to
 * mutate the credential map in place.
 *
 * The chain is composed in `./index.ts`. Today it contains the SSH-tunnel
 * rewriter (legacy `tunnel-resolver.ts`); other rewriters (e.g. Cloud SQL
 * Auth Proxy) are added by registering them at startup.
 *
 * The `RewriterContext` and `CredentialRewriter` shapes are declared in
 * `@infrawrench/plugin-base` so the desktop renderer's own rewriter chain
 * (which can't import server-core) shares the exact same contract.
 */

export type { RewriterContext, CredentialRewriter } from "@infrawrench/plugin-base";

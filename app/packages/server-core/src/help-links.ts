/**
 * Re-export of the plugin help-link boundary, which lives in
 * `@infrawrench/client-core` because the UI enforces the same rule at the
 * point of render (see that module's header for why storage is not the only
 * way an unsafe URL arrives).
 *
 * Kept as a server-core path so `cost/failure.ts` and `quotas/collect.ts`
 * import it from where they always did.
 */
export { renderableHelpLink, renderableHelpUrl } from "@infrawrench/client-core";

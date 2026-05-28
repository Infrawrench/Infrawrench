/**
 * Desktop wrapper over the shared in-process SSH agent in
 * `@infrawrench/ssh-tunnel-core`. The desktop host does not record audit
 * events for agent sign-requests (single-user, local) so we just re-export
 * `buildInProcessAgent` with no `onSign` hook.
 *
 * The shared implementation lives in `plugin-architecture/packages/ssh-tunnel-core/src/in-process-agent.ts`
 * and is consumed identically (with an `onSign` hook for audit logging) by
 * `app/packages/web/src/services/ssh-agent.ts`.
 */
export { buildInProcessAgent } from "@infrawrench/ssh-tunnel-core";

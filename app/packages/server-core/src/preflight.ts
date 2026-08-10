/**
 * Server-side entry point for credential preflight.
 *
 * The runner itself lives in `@infrawrench/client-core` because the desktop
 * renderer executes the same normalization against its locally-instantiated
 * plugin clients — keeping one implementation stops the two hosts drifting
 * on how probe failures and unsafe help links are handled.
 */
export { runAccountPreflight } from "@infrawrench/client-core";
export type { PreflightCheck, PreflightReport } from "@infrawrench/client-core";

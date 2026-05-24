/**
 * Shared client-side TypeScript types for API responses.
 *
 * The canonical definitions live in `@infrawrench/ui` (the one package both
 * the web SPA and the desktop app depend on). This module re-exports them
 * so existing `@/lib/api-types` imports keep working.
 */

export type { Account, AccountListItem, Dashboard, SshKey } from "@infrawrench/ui";

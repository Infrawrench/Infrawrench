/**
 * Shared HTTP wire-format types for the Infrawrench Cloud API.
 *
 * These mirror the shapes produced by the server routes under
 * `app/packages/web/src/api/routes/*` (and described by the Zod schemas in
 * `app/packages/web/src/api/openapi/paths/*`). Both the web SPA and the
 * desktop app talk to the same backend, so the canonical client-side type
 * definitions live in `@infrawrench/ui` — the one package both consumers
 * already depend on.
 *
 * If you change a response shape on the server, update the corresponding
 * type here too (and update the Zod schema in `web/src/api/openapi/paths/`
 * to keep the OpenAPI doc honest).
 */

/**
 * Full account row as returned by `GET /api/org/:orgId/accounts`.
 *
 * `bastionId` is `null` when the account egresses directly; a uuid when it
 * routes through a bastion. `createdAt` is an ISO-8601 timestamp.
 */
export interface Account {
  id: string;
  pluginId: string;
  displayName: string;
  bastionId?: string | null;
  createdAt: string;
}

/**
 * Minimal account entry used by pickers (Add Account modal, Connect Through
 * Jumpbox, etc.) that only need to render a name + plugin badge.
 */
export type AccountListItem = Pick<Account, "id" | "pluginId" | "displayName">;

/**
 * A dashboard entry as returned by `GET /api/org/:orgId/dashboards` and
 * `POST /api/org/:orgId/dashboards`.
 */
export interface Dashboard {
  id: string;
  name: string;
  isDefault: boolean;
}

/**
 * An SSH key entry as returned by `GET /api/org/:orgId/ssh-keys`.
 * Components that only need a subset can `Pick<SshKey, ...>`.
 */
export interface SshKey {
  id: string;
  name: string;
  keyType: string;
  isImported: boolean;
  fingerprint: string | null;
  publicKey: string;
  userId: string;
  ownerEmail: string;
  ownerName: string;
  createdAt: string;
}

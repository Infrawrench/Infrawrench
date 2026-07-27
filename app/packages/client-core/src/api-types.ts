/**
 * Shared HTTP wire-format types for the Infrawrench Cloud API.
 *
 * These mirror the shapes produced by the server routes under
 * `app/packages/web/src/api/routes/*` (and described by the Zod schemas in
 * `app/packages/web/src/api/openapi/paths/*`).
 *
 * They live here rather than in `@infrawrench/ui` because mobile doesn't
 * depend on that package, and every client that talks to the cloud API has to
 * describe the same bytes. `@infrawrench/ui` re-exports the whole module, so
 * web and desktop keep importing them from there.
 *
 * If you change a response shape on the server, update the corresponding type
 * here too (and update the Zod schema in `web/src/api/openapi/paths/` to keep
 * the OpenAPI doc honest).
 */

import type { AttachTarget } from "@infrawrench/plugin-base";

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

/**
 * A bastion agent as returned by `GET /api/org/:orgId/bastions`. Tracks
 * registration metadata plus a live `connected` flag indicating whether the
 * agent currently has a WebSocket session to the cloud server.
 */
export interface Bastion {
  id: string;
  name: string;
  tokenPrefix: string;
  agentVersion: string | null;
  lastSeenAt: string | null;
  status: "pending" | "active" | "revoked";
  revokedAt: string | null;
  createdAt: string;
  createdByUserId: string;
  /** True iff an agent is currently connected to this bastion's WebSocket. */
  connected: boolean;
  /** Number of accounts in this org that have this bastion attached. */
  accountCount: number;
}

/**
 * A single resource as returned by `GET /api/org/:orgId/accounts/:id/resources`
 * and `POST /api/org/:orgId/accounts/:id/sync-type/:typeId`. The `fieldsJson` /
 * `outputsJson` values arrive as already-parsed JSON objects on the wire (the
 * server returns them as objects, not strings, per the `JsonObject` OpenAPI
 * schema).
 */
export interface Resource {
  id: string;
  pluginId: string;
  resourceTypeId: string;
  accountId: string;
  displayName: string;
  externalId: string | null;
  fieldsJson: Record<string, unknown>;
  outputsJson: Record<string, unknown>;
  parentResourceId: string | null;
}

/**
 * A resource type entry inside `AccountDetail.resourceTypes` and the equivalent
 * shape consumed by `AccountDetailView`. `parentTypeId` is set when this type's
 * instances are children of a parent type; `attachTargets` carries drag-drop
 * compatibility.
 */
export interface ResourceTypeSummary {
  id: string;
  displayName: string;
  pluralDisplayName: string;
  parentTypeId: string | undefined;
  supportsCreate: boolean;
  attachTargets?: AttachTarget[];
  /** True when this type declares an sshEndpoint — a valid SSH-tunnel drop target. */
  isSshHost?: boolean;
  /** True when this type can be dragged onto SSH hosts to set up a tunnel. */
  sshTunnelAttachSource?: boolean;
}

/**
 * `GET /api/org/:orgId/accounts/:id/detail` — account metadata plus the list
 * of resource types this plugin exposes. Used to render the per-account page.
 */
export interface AccountDetail {
  account: { id: string; pluginId: string; displayName: string };
  resourceTypes: ResourceTypeSummary[];
  pluginDisplayName: string;
  pluginLogoSvg: string;
}

/**
 * A paging recipient as returned by `GET /api/org/:orgId/twilio/recipients`
 * (and created via `POST .../recipients`). Mirrors the server-side
 * `Recipient` shape in `@infrawrench/server-core`'s twilio-pager.
 */
export interface Recipient {
  id: string;
  displayName: string;
  phoneNumber: string;
  sms: boolean;
  voice: boolean;
}

/**
 * The Stripe subscription backing a paid org, as nested inside
 * `BillingStatus`. `null` there when the org has never subscribed.
 */
export interface SubscriptionStatus {
  status: string;
  seatCount: number;
  currentPeriodEnd: string | null;
  stripeCustomerId: string;
}

/**
 * `GET /api/org/:orgId/billing/status`.
 *
 * Note the envelope: the subscription is *nested*, and `complimentary` orgs
 * have every paid perk with `subscription === null`. Reading the response as a
 * bare subscription silently renders blanks for a paying org.
 */
export interface BillingStatus {
  /** Platform-granted access: all paid perks, uncapped AI chat, never billed. */
  complimentary: boolean;
  subscription: SubscriptionStatus | null;
}

/** A row of `GET /api/org/:orgId/team/members`. */
export interface TeamMember {
  id: string;
  email: string;
  displayName: string | null;
  role: string;
  roleId: string | null;
  roleName: string | null;
  roleSystemKey: string | null;
  createdAt: string;
}

/** A row of `GET /api/org/:orgId/team/invitations`. */
export interface InvitationSummary {
  id: string;
  email: string;
  role: string;
  roleId: string | null;
  roleName: string | null;
  acceptedAt: string | null;
  expiresAt: string;
  createdAt: string;
}

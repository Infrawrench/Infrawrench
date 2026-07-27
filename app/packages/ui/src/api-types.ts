/**
 * Shared HTTP wire-format types for the Infrawrench Cloud API.
 *
 * The definitions live in `@infrawrench/client-core` so mobile — which doesn't
 * depend on this package — describes the same bytes as web and desktop. They
 * are re-exported here because web and desktop depend on `@infrawrench/ui`,
 * not on client-core directly, so every existing import keeps working.
 *
 * Add or change a wire type in `client-core/src/api-types.ts`, not here.
 */
export type {
  Account,
  AccountDetail,
  AccountListItem,
  Bastion,
  BillingStatus,
  Dashboard,
  InvitationSummary,
  Recipient,
  Resource,
  ResourceTypeSummary,
  SshKey,
  SubscriptionStatus,
  TeamMember,
} from "@infrawrench/client-core";

/**
 * Personal-account types and formatters for Settings → General.
 *
 * As with `api-types`, the canonical definitions live upstream — here in
 * `@infrawrench/client-core`, re-exported through `@infrawrench/ui` — so the
 * mobile app shares exactly the same contract.
 */

// `ownershipTransferRequired` is deliberately not re-exported: it narrows a
// `CloudApiError`, which only the CloudFetch hosts (mobile) throw. Web's
// `apiFetch` throws a plain Error carrying the server's message, so the web
// deletion card reads the blockers from `/api/profile/deletion-preview`
// up front instead of discovering them from a rejection.
export {
  formatProvider,
  formatAuthMethod,
  describeUserAgent,
  type Profile,
  type ProfileIdentity,
  type AuthFactor,
  type TotpEnrollment,
  type PendingEmailChange,
  type UserSession,
  type OrganizationRef,
  type OwnershipBlocker,
  type AccountDeletionPreview,
} from "@infrawrench/ui";

/**
 * Personal-account types and formatters for Settings → General.
 *
 * As with `api-types`, the canonical definitions live upstream — here in
 * `@infrawrench/client-core`, re-exported through `@infrawrench/ui` — so the
 * mobile app shares exactly the same contract.
 */

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
} from "@infrawrench/ui";

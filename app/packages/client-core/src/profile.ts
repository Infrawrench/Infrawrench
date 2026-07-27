import { CloudApiError, type CloudFetch } from "./fetch";

/**
 * The signed-in user's own account — name, two-factor factors, and active
 * sessions. Server contract: user-scoped `/api/profile` routes (see web
 * `api/routes/profile.ts`), which wrap WorkOS user management.
 *
 * Lives here rather than in `@infrawrench/ui` so mobile can use it without
 * pulling in DOM-dependent code; `@infrawrench/ui` re-exports it for the web
 * and desktop apps.
 */

export interface ProfileIdentity {
  /** WorkOS provider id, e.g. `GoogleOAuth`. */
  provider: string;
}

export interface Profile {
  id: string;
  email: string;
  emailVerified: boolean;
  firstName: string | null;
  lastName: string | null;
  profilePictureUrl: string | null;
  lastSignInAt: string | null;
  createdAt: string;
  identities: ProfileIdentity[];
}

/** An email change waiting on a code delivered to `newEmail`. */
export interface PendingEmailChange {
  newEmail: string;
  expiresAt: string;
}

export interface AuthFactor {
  id: string;
  type: "totp" | "sms" | "generic_otp";
  createdAt: string;
  updatedAt: string;
  totpIssuer: string | null;
  totpUser: string | null;
}

export interface TotpEnrollment {
  factorId: string;
  challengeId: string;
  /** Data-URI image of the enrolment QR code. */
  qrCode: string | null;
  /** Base32 secret, for authenticator apps that take manual entry. */
  secret: string | null;
  uri: string | null;
}

export interface UserSession {
  id: string;
  ipAddress: string | null;
  userAgent: string | null;
  authMethod: string;
  status: string;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
  /** True for the session making the request. */
  current: boolean;
}

export async function fetchProfile(api: CloudFetch): Promise<Profile | null> {
  return api.api<Profile>("/api/profile");
}

export async function updateProfile(
  api: CloudFetch,
  patch: { firstName?: string; lastName?: string },
): Promise<void> {
  await api.api("/api/profile", { method: "PATCH", body: JSON.stringify(patch) });
}

export async function createPasswordResetLink(api: CloudFetch): Promise<string | null> {
  const result = await api.api<{ passwordResetUrl: string }>("/api/profile/password-reset", {
    method: "POST",
  });
  return result?.passwordResetUrl ?? null;
}

/**
 * Sends a confirmation code to `newEmail`. The account does not move until
 * {@link confirmEmailChange} redeems that code, so an abandoned or mistyped
 * change leaves the current address intact.
 */
export async function startEmailChange(
  api: CloudFetch,
  newEmail: string,
): Promise<PendingEmailChange | null> {
  return api.api<PendingEmailChange>("/api/profile/email-change", {
    method: "POST",
    body: JSON.stringify({ newEmail }),
  });
}

export async function confirmEmailChange(api: CloudFetch, code: string): Promise<string | null> {
  const result = await api.api<{ email: string }>("/api/profile/email-change/confirm", {
    method: "POST",
    body: JSON.stringify({ code }),
  });
  return result?.email ?? null;
}

export async function listAuthFactors(api: CloudFetch): Promise<AuthFactor[]> {
  return (await api.api<AuthFactor[]>("/api/profile/mfa")) ?? [];
}

export async function startTotpEnrollment(api: CloudFetch): Promise<TotpEnrollment | null> {
  return api.api<TotpEnrollment>("/api/profile/mfa", { method: "POST" });
}

export async function verifyTotpEnrollment(
  api: CloudFetch,
  factorId: string,
  challengeId: string,
  code: string,
): Promise<void> {
  await api.api(`/api/profile/mfa/${encodeURIComponent(factorId)}/verify`, {
    method: "POST",
    body: JSON.stringify({ challengeId, code }),
  });
}

export async function challengeAuthFactor(
  api: CloudFetch,
  factorId: string,
): Promise<string | null> {
  const result = await api.api<{ challengeId: string }>(
    `/api/profile/mfa/${encodeURIComponent(factorId)}/challenge`,
    { method: "POST" },
  );
  return result?.challengeId ?? null;
}

export async function deleteAuthFactor(api: CloudFetch, factorId: string): Promise<void> {
  await api.api(`/api/profile/mfa/${encodeURIComponent(factorId)}`, { method: "DELETE" });
}

export async function listUserSessions(api: CloudFetch): Promise<UserSession[]> {
  return (await api.api<UserSession[]>("/api/profile/sessions")) ?? [];
}

export async function revokeUserSession(api: CloudFetch, sessionId: string): Promise<void> {
  await api.api(`/api/profile/sessions/${encodeURIComponent(sessionId)}`, { method: "DELETE" });
}

export async function revokeOtherUserSessions(api: CloudFetch): Promise<number> {
  const result = await api.api<{ revoked: number }>("/api/profile/sessions/revoke-others", {
    method: "POST",
  });
  return result?.revoked ?? 0;
}

/* ------------------------------------------------------------------ *
 * Account deletion.
 * ------------------------------------------------------------------ */

export interface OrganizationRef {
  id: string;
  name: string;
}

/** An organization that must be handed over before the account can go. */
export interface OwnershipBlocker extends OrganizationRef {
  memberCount: number;
}

export interface AccountDeletionPreview {
  /** Deleted with the account — the user is their only member. */
  organizationsToDelete: OrganizationRef[];
  /** These survive; the user's membership is removed. */
  organizationsToLeave: OrganizationRef[];
  /** Non-empty means {@link deleteAccount} will refuse. */
  blockers: OwnershipBlocker[];
}

/**
 * What deleting the account would do, so a confirmation screen can say it out
 * loud instead of letting the user find out by pressing the button.
 */
export async function fetchAccountDeletionPreview(
  api: CloudFetch,
): Promise<AccountDeletionPreview> {
  const result = await api.api<AccountDeletionPreview>("/api/profile/deletion-preview");
  return result ?? { organizationsToDelete: [], organizationsToLeave: [], blockers: [] };
}

/**
 * Delete the account. Irreversible.
 *
 * Throws `CloudApiError`; use {@link ownershipTransferRequired} to pick out the
 * one failure the user can act on, and {@link isReauthenticationRequired} for
 * the step-up 403 this route shares with the rest of the sensitive ones.
 *
 * The caller is responsible for signing out afterwards — every session is
 * revoked server-side, so anything still holding a token is already dead.
 */
export async function deleteAccount(api: CloudFetch): Promise<{ organizationsDeleted: number }> {
  const result = await api.api<{ organizationsDeleted: number }>("/api/profile", {
    method: "DELETE",
  });
  return { organizationsDeleted: result?.organizationsDeleted ?? 0 };
}

/** Marker on the 409 returned when the user still solely owns a shared org. */
export const TRANSFER_OWNERSHIP_REQUIRED = "transfer_ownership_required";

/**
 * The organizations blocking a deletion, or null when the rejection was
 * something else. Nothing was deleted when this returns a list.
 */
export function ownershipTransferRequired(error: unknown): OwnershipBlocker[] | null {
  if (!(error instanceof CloudApiError) || error.status !== 409) return null;
  try {
    const parsed = JSON.parse(error.body) as { code?: unknown; organizations?: unknown };
    if (parsed?.code !== TRANSFER_OWNERSHIP_REQUIRED) return null;
    return Array.isArray(parsed.organizations) ? (parsed.organizations as OwnershipBlocker[]) : [];
  } catch {
    return null;
  }
}

/**
 * Marker the server puts on a 403 when an operation needs a fresh sign-in.
 * Mirrors `REAUTHENTICATION_REQUIRED` in web `auth/step-up.ts`.
 */
export const REAUTHENTICATION_REQUIRED = "reauthentication_required";

/**
 * True when a rejection is the server asking the user to sign in again before
 * the action is allowed (see `auth/step-up.ts`). Callers should route the user
 * back through sign-in rather than surfacing the raw error — the request is
 * well-formed and will succeed once the session is fresh.
 */
export function isReauthenticationRequired(error: unknown): boolean {
  if (!(error instanceof CloudApiError) || error.status !== 403) return false;
  try {
    const parsed = JSON.parse(error.body) as { code?: unknown };
    return parsed?.code === REAUTHENTICATION_REQUIRED;
  } catch {
    return false;
  }
}

/** `GoogleOAuth` → `Google`. Unknown providers pass through unchanged. */
export function formatProvider(provider: string): string {
  return provider.replace(/OAuth$/, "") || provider;
}

/** `magic_code` → `Magic code`. */
export function formatAuthMethod(method: string): string {
  const spaced = method.replace(/_/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * A short "browser on OS" label for a session row. Deliberately coarse: the
 * point is to help someone recognise their own devices in a list, not to
 * fingerprint them, and the full string stays available for anyone who cares.
 */
export function describeUserAgent(userAgent: string | null): string {
  if (!userAgent) return "Unknown device";

  const client = /Edg\//.test(userAgent)
    ? "Edge"
    : /OPR\//.test(userAgent)
      ? "Opera"
      : /Firefox\//.test(userAgent)
        ? "Firefox"
        : /Chrome\//.test(userAgent)
          ? "Chrome"
          : /Safari\//.test(userAgent)
            ? "Safari"
            : /Infrawrench/i.test(userAgent)
              ? "Infrawrench app"
              : null;

  const platform = /iPhone|iPad|iOS/.test(userAgent)
    ? "iOS"
    : /Android/.test(userAgent)
      ? "Android"
      : /Mac OS X|Macintosh/.test(userAgent)
        ? "macOS"
        : /Windows/.test(userAgent)
          ? "Windows"
          : /Linux/.test(userAgent)
            ? "Linux"
            : null;

  if (client && platform) return `${client} on ${platform}`;
  return client ?? platform ?? userAgent.slice(0, 40);
}

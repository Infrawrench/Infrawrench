/**
 * Leaked credentials: secrets a scanner plugin (GitHub secret scanning,
 * GitLab secret detection) found committed to code, attributed to the
 * account or stored secret they belong to, and closed by rotating it.
 *
 * The shared half: the wire shapes of `/api/org/:orgId/leaked-secrets`, the
 * two outbound event types, the labels every surface renders and the fetch
 * helpers the web, desktop, mobile and CLI clients call. The server owns the
 * ingestion and the matching (`server-core/leaked-secrets/`); nothing here
 * ever sees a secret value, only the masked hint the server keeps.
 */
import { defineEventType, ef } from "./event-catalog";
import type { CloudFetch } from "./fetch";

/** Where a leak stands in Infrawrench. */
export type LeakedSecretStatus =
  /** Needs rotating. */
  | "open"
  /** Rotated: through Infrawrench, or detected because the stored value changed. */
  | "rotated"
  /** Accepted as not a risk: false positive, test credential, won't fix. */
  | "dismissed"
  /** Closed on the scanner by someone else before it was rotated here. */
  | "resolved";

export const LEAKED_SECRET_STATUSES: readonly LeakedSecretStatus[] = [
  "open",
  "rotated",
  "dismissed",
  "resolved",
];

export const LEAKED_SECRET_STATUS_LABELS: Record<LeakedSecretStatus, string> = {
  open: "Open",
  rotated: "Rotated",
  dismissed: "Dismissed",
  resolved: "Resolved upstream",
};

/** What the leak was matched to. */
export type LeakedSecretMatchKind =
  /** A credential field of a connected account. */
  | "account"
  /** A secret Infrawrench stores on a resource (a literal field value). */
  | "secret-field"
  /** A resource output another resource references; rotating reissues it. */
  | "output"
  /** Nothing Infrawrench holds. */
  | "none";

/**
 * How sure the match is. `fingerprint`: the leaked value is byte-for-byte a
 * value Infrawrench stores (compared by keyed hash, never by value).
 * `token-type`: the scanner did not return the value, so the leak is only
 * known to be a token of a provider the org has accounts on.
 */
export type LeakedSecretMatchConfidence = "fingerprint" | "token-type" | "none";

/**
 * What the one-click action does for this leak, decided by the server from
 * the match and the owning plugin's capabilities:
 *
 * - `reissue`: the plugin can mint a new value itself (`rerollOutput`); one
 *   click rotates it and the references that consume it follow.
 * - `replace`: the stored value is a literal; the user pastes the new value
 *   and the plugin pushes it upstream when it can (`applySecretReroll`).
 * - `account`: an account credential; rotate it at the provider (`manageUrl`)
 *   and update the account. The change is detected and recorded.
 * - `manual`: nothing Infrawrench holds; rotate it at the provider.
 */
export type LeakRotationMode = "reissue" | "replace" | "account" | "manual";

/** How a rotation was recorded. */
export type LeakRotationMethod = "reissued" | "replaced" | "detected" | "manual";

export const LEAK_ROTATION_METHOD_LABELS: Record<LeakRotationMethod, string> = {
  reissued: "Reissued in Infrawrench",
  replaced: "New value stored",
  detected: "Stored value changed",
  manual: "Marked rotated",
};

export type LeakDismissReason = "false-positive" | "wont-fix" | "used-in-tests";

export const LEAK_DISMISS_REASON_LABELS: Record<LeakDismissReason, string> = {
  "false-positive": "False positive",
  "used-in-tests": "Used in tests",
  "wont-fix": "Won't fix",
};

export interface LeakedSecret {
  id: string;
  status: LeakedSecretStatus;
  /** The scanner account the finding came from. */
  scannerAccountId: string;
  scannerAccountName: string;
  scannerPluginId: string;
  /** The scanner's identifier for the token, e.g. `github_personal_access_token`. */
  tokenType: string;
  /** Best human label: the owning plugin's, else the scanner's, else the identifier. */
  tokenTypeLabel: string;
  /** The plugin that issues this kind of token, when one declares it. */
  ownerPluginId: string | null;
  ownerPluginName: string | null;
  /** First and last few characters of the value, e.g. `ghp_…3f9a`. Never more. */
  secretHint: string | null;
  repository: string | null;
  path: string | null;
  line: number | null;
  commitSha: string | null;
  /** The finding on the scanner. */
  url: string | null;
  upstreamState: "open" | "resolved";
  upstreamResolution: string | null;
  validity: "active" | "inactive" | "unknown" | null;
  publiclyLeaked: boolean;
  detectedAt: string;
  firstSeenAt: string;
  matchKind: LeakedSecretMatchKind;
  matchConfidence: LeakedSecretMatchConfidence;
  matchedAccountId: string | null;
  matchedAccountName: string | null;
  matchedResourceId: string | null;
  matchedResourceName: string | null;
  matchedResourceTypeId: string | null;
  matchedPluginId: string | null;
  matchedFieldKey: string | null;
  /** Accounts the leak may belong to when the match is by token type and ambiguous. */
  candidateAccountIds: string[];
  rotation: { mode: LeakRotationMode; manageUrl: string | null };
  rotatedAt: string | null;
  rotatedBy: string | null;
  rotationMethod: LeakRotationMethod | null;
  dismissedReason: LeakDismissReason | null;
  dismissedComment: string | null;
  dismissedAt: string | null;
  dismissedBy: string | null;
  /** When Infrawrench closed the finding on the scanner. */
  upstreamResolvedAt: string | null;
  /** Why closing it on the scanner failed, when it did. */
  upstreamResolveError: string | null;
  /** The scanner can close this finding from here. */
  canResolveUpstream: boolean;
}

export interface LeakedSecretScanner {
  accountId: string;
  accountName: string;
  pluginId: string;
  /** The scanner's product name, e.g. "Secret scanning". */
  label: string;
  canResolve: boolean;
  returnsSecretValue: boolean;
  lastScannedAt: string | null;
  lastError: string | null;
  /** Findings returned by the last scan. */
  lastCount: number | null;
}

export type LeakedSecretCounts = Record<LeakedSecretStatus, number>;

/** Wire shape of `GET /api/org/:orgId/leaked-secrets`. */
export interface LeakedSecretListResponse {
  /** Open first, newest first within a status. */
  leaks: LeakedSecret[];
  counts: LeakedSecretCounts;
  scanners: LeakedSecretScanner[];
  generatedAt: string;
}

/**
 * The posture tab's "Leaked credentials" category: the part of the leak list
 * the posture feed carries so every posture surface can show the count
 * without a second request.
 */
export interface LeakedCredentialsSummary {
  open: number;
  /** Open leaks that matched something Infrawrench holds. */
  matched: number;
  /** Scanner accounts connected; zero means the category has nothing to say. */
  scanners: number;
}

/** Severity of a leak for display and alerting: critical unless the scanner says the token is dead. */
export function leakSeverity(
  leak: Pick<LeakedSecret, "validity" | "matchKind">,
): "critical" | "high" {
  if (leak.validity === "inactive" && leak.matchKind === "none") return "high";
  return "critical";
}

/** `owner/repo: path/to/file.ts:12`, or as much of it as is known. */
export function leakLocationLabel(
  leak: Pick<LeakedSecret, "repository" | "path" | "line">,
): string {
  const file = leak.path ? `${leak.path}${leak.line != null ? `:${leak.line}` : ""}` : "";
  if (leak.repository && file) return `${leak.repository}: ${file}`;
  return leak.repository ?? file;
}

/** Open leaks that matched, or may belong to, an account. Drives the account-page banner. */
export function openLeaksForAccount(
  leaks: readonly LeakedSecret[],
  accountId: string,
): LeakedSecret[] {
  return leaks.filter(
    (l) =>
      l.status === "open" &&
      (l.matchedAccountId === accountId || l.candidateAccountIds.includes(accountId)),
  );
}

/**
 * A masked hint of a secret: up to the first four and the last four
 * characters, and nothing for a value too short to mask safely. Shared so the
 * server's stored hint and any test agree on exactly how much is kept.
 */
export function leakedSecretHint(secret: string): string | null {
  const value = secret.trim();
  if (value.length < 16) return null;
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

// --- Outbound events ---

const leakFields = {
  leakId: ef.str("Infrawrench leaked secret id."),
  tokenType: ef.str("The scanner's identifier for the token type."),
  tokenTypeLabel: ef.str("Human name of the token type."),
  ownerPluginId: ef.str("Plugin that issues this token type.", { nullable: true }),
  matchKind: ef.str("What the leak was matched to.", {
    enum: ["account", "secret-field", "output", "none"],
  }),
  matchedAccountId: ef.str("The connected account the leak belongs to.", { nullable: true }),
  matchedResourceId: ef.str("The resource whose stored secret leaked.", { nullable: true }),
} as const;

export const SECRET_LEAKED = defineEventType({
  type: "secret.leaked",
  version: 1,
  label: "Secret leaked",
  description:
    "A secret scanner found a credential committed to code. Each finding is sent once; the value itself is never included.",
  category: "security",
  defaultSeverity: "critical",
  fields: {
    ...leakFields,
    scannerPluginId: ef.str("Plugin of the scanner that found it."),
    scannerAccountId: ef.str("Scanner account that found it."),
    matchConfidence: ef.str("How the match was made.", {
      enum: ["fingerprint", "token-type", "none"],
    }),
    repository: ef.str("Repository the secret was found in.", { nullable: true }),
    path: ef.str("File the secret was found in.", { nullable: true }),
    url: ef.str("The finding on the scanner.", { nullable: true }),
    validity: ef.str("The scanner's validity check.", {
      enum: ["active", "inactive", "unknown"],
      nullable: true,
    }),
    publiclyLeaked: ef.bool("The scanner also found it in a public place."),
    detectedAt: ef.time("When the scanner first saw it."),
  },
});

export const SECRET_ROTATED = defineEventType({
  type: "secret.rotated",
  version: 1,
  label: "Leaked secret rotated",
  description: "A leaked credential was rotated, or its stored value was seen to change.",
  category: "security",
  defaultSeverity: "info",
  fields: {
    ...leakFields,
    method: ef.str("How the rotation was recorded.", {
      enum: ["reissued", "replaced", "detected", "manual"],
    }),
    rotatedBy: ef.str("Who rotated it, when a person did.", { nullable: true }),
    upstreamResolved: ef.bool("The finding was closed on the scanner as revoked."),
  },
});

// --- Client calls ---

const EMPTY_COUNTS: LeakedSecretCounts = { open: 0, rotated: 0, dismissed: 0, resolved: 0 };

/** `GET /api/org/:orgId/leaked-secrets` (permission `resources:read`). */
export async function fetchLeakedSecrets(
  api: CloudFetch,
  orgId: string,
  query: { status?: LeakedSecretStatus; accountId?: string } = {},
): Promise<LeakedSecretListResponse> {
  const params = new URLSearchParams();
  if (query.status) params.set("status", query.status);
  if (query.accountId) params.set("accountId", query.accountId);
  const qs = params.toString();
  const res = await api.org<LeakedSecretListResponse>(
    orgId,
    `/leaked-secrets${qs ? `?${qs}` : ""}`,
  );
  return (
    res ?? {
      leaks: [],
      counts: { ...EMPTY_COUNTS },
      scanners: [],
      generatedAt: new Date().toISOString(),
    }
  );
}

export interface LeakRotateInput {
  /** The new value, for a `replace` rotation. */
  value?: string;
  /** Close the finding on the scanner as revoked afterwards. Defaults to true. */
  resolveUpstream?: boolean;
}

async function leakAction(
  api: CloudFetch,
  orgId: string,
  id: string,
  action: string,
  body: unknown,
): Promise<LeakedSecret> {
  const res = await api.org<{ leak: LeakedSecret }>(
    orgId,
    `/leaked-secrets/${encodeURIComponent(id)}/${action}`,
    { method: "POST", body: JSON.stringify(body ?? {}) },
  );
  if (!res) throw new Error("The server returned no leak");
  return res.leak;
}

/** `POST /leaked-secrets/:id/rotate` (permission `secrets:write`): reissue or replace the matched secret. */
export function rotateLeakedSecret(
  api: CloudFetch,
  orgId: string,
  id: string,
  input: LeakRotateInput = {},
): Promise<LeakedSecret> {
  return leakAction(api, orgId, id, "rotate", input);
}

/** `POST /leaked-secrets/:id/mark-rotated`: record a rotation done at the provider. */
export function markLeakedSecretRotated(
  api: CloudFetch,
  orgId: string,
  id: string,
  input: { resolveUpstream?: boolean } = {},
): Promise<LeakedSecret> {
  return leakAction(api, orgId, id, "mark-rotated", input);
}

/** `POST /leaked-secrets/:id/dismiss`: accept the finding as not a risk. */
export function dismissLeakedSecret(
  api: CloudFetch,
  orgId: string,
  id: string,
  input: { reason: LeakDismissReason; comment?: string; resolveUpstream?: boolean },
): Promise<LeakedSecret> {
  return leakAction(api, orgId, id, "dismiss", input);
}

/** `POST /leaked-secrets/:id/reopen`: undo a dismissal or a manual rotation. */
export function reopenLeakedSecret(
  api: CloudFetch,
  orgId: string,
  id: string,
): Promise<LeakedSecret> {
  return leakAction(api, orgId, id, "reopen", {});
}

/** `POST /leaked-secrets/scan`: scan every scanner account now. */
export async function scanLeakedSecrets(
  api: CloudFetch,
  orgId: string,
): Promise<{ scanned: number; newLeaks: number; errors: number }> {
  const res = await api.org<{ scanned: number; newLeaks: number; errors: number }>(
    orgId,
    "/leaked-secrets/scan",
    { method: "POST", body: "{}" },
  );
  return res ?? { scanned: 0, newLeaks: 0, errors: 0 };
}

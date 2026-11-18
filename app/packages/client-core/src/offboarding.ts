/**
 * Offboarding sweep: everything tied to one person across the organization's
 * connected providers and Infrawrench itself, lined up as a saved checklist.
 *
 * The data is already collected elsewhere (access-review principals, SaaS
 * seats, resource ownership, on-call rotations, leases, just-in-time grants,
 * the org's own members, API keys and SSH keys); nothing lined it up by
 * person. This module is the shared, pure half: the wire contract, how a
 * synced value is matched against a person (email plus known aliases), the
 * checklist's progress and its CSV evidence file. The server
 * (`server-core/offboarding/`) collects candidates and persists the
 * checklist; the web, desktop and CLI surfaces read the same shapes.
 *
 * Matching is deliberately conservative. An exact email is a match; a handle
 * the operator listed as an alias is a match; anything weaker (the part
 * before the `@`, the same name at another domain, the person's full name) is
 * only ever a *possible* match that a human confirms before any action is
 * offered. Revoking the wrong person's access is the failure this feature
 * must never cause.
 */
import type { CloudFetch } from "./fetch";

export type OffboardingStatus = "open" | "completed" | "canceled";
export type OffboardingSource = "manual" | "directory";

/** What a checklist row is about. */
export type OffboardingItemKind =
  | "member"
  | "api-key"
  | "ssh-key"
  | "principal"
  | "seat"
  | "resource"
  | "on-call"
  | "on-call-cover"
  | "lease"
  | "jit-grant";

export const OFFBOARDING_ITEM_KINDS: readonly OffboardingItemKind[] = [
  "member",
  "api-key",
  "ssh-key",
  "principal",
  "seat",
  "resource",
  "on-call",
  "on-call-cover",
  "lease",
  "jit-grant",
];

/** How sure the sweep is that the row belongs to the person. */
export type OffboardingMatchConfidence = "exact" | "alias" | "possible";

/**
 * Whether a human has looked at the match. A `possible` match starts
 * `unconfirmed` and offers no action until it is `confirmed`; `rejected`
 * rows ("not them") leave the checklist and its progress.
 */
export type OffboardingMatchState = "matched" | "unconfirmed" | "confirmed" | "rejected";

/**
 * Where a row stands. `gone` means a later scan no longer found it (removed
 * outside Infrawrench, or the provider no longer reports it): resolved, but
 * not by anyone here.
 */
export type OffboardingItemStatus = "open" | "done" | "skipped" | "failed" | "gone";

/** The actions a row can offer, each dispatched by the server. */
export type OffboardingActionId =
  | "revoke"
  | "remove"
  | "remove-seat"
  | "remove-member"
  | "revoke-api-key"
  | "delete-ssh-key"
  | "transfer-ownership"
  | "reassign-on-call"
  | "remove-from-rotation"
  | "cancel-cover"
  | "cancel-lease"
  | "revoke-jit";

export const OFFBOARDING_ACTION_IDS: readonly OffboardingActionId[] = [
  "revoke",
  "remove",
  "remove-seat",
  "remove-member",
  "revoke-api-key",
  "delete-ssh-key",
  "transfer-ownership",
  "reassign-on-call",
  "remove-from-rotation",
  "cancel-cover",
  "cancel-lease",
  "revoke-jit",
];

/**
 * The permission each action needs on top of the offboarding routes' own
 * (`team:remove`). Null: the action's own service decides (a just-in-time
 * revoke lets the holder, an approver or `org:settings:write` through).
 */
export const OFFBOARDING_ACTION_PERMISSIONS: Record<OffboardingActionId, string | null> = {
  revoke: "resources:write",
  remove: "resources:delete",
  "remove-seat": "resources:write",
  "remove-member": "team:remove",
  "revoke-api-key": "apikeys:write",
  "delete-ssh-key": "team:role:write",
  "transfer-ownership": "resources:write",
  "reassign-on-call": "org:settings:write",
  "remove-from-rotation": "org:settings:write",
  "cancel-cover": "team:read",
  "cancel-lease": "resources:write",
  "revoke-jit": null,
};

/** Actions that hand something to another member, and so need one picked. */
export const OFFBOARDING_ACTIONS_NEEDING_TARGET: ReadonlySet<OffboardingActionId> = new Set([
  "transfer-ownership",
  "reassign-on-call",
]);

/** Actions that reach a provider and so respect the org's change freeze. */
export const OFFBOARDING_PROVIDER_ACTIONS: ReadonlySet<OffboardingActionId> = new Set([
  "revoke",
  "remove",
  "remove-seat",
  "revoke-jit",
]);

export interface OffboardingItem {
  id: string;
  kind: OffboardingItemKind;
  /** What the row is: a principal's name, a seat's product, a rotation. */
  title: string;
  /** One line of context: the type, the account, the shift dates. */
  detail: string | null;
  pluginId: string | null;
  /** Provider display name, or null for Infrawrench's own records. */
  providerName: string | null;
  accountId: string | null;
  accountName: string | null;
  /** Infrawrench resource id, when the row is a synced resource. */
  resourceId: string | null;
  resourceTypeId: string | null;
  confidence: OffboardingMatchConfidence;
  /** Why the sweep thinks this is theirs, in a sentence. */
  matchReason: string;
  matchState: OffboardingMatchState;
  /** What can be done from here; empty means "do it in the provider, then mark it done". */
  actions: OffboardingActionId[];
  status: OffboardingItemStatus;
  /** The action taken, or "manual" for a row marked done by hand. */
  resolution: string | null;
  lastError: string | null;
  note: string | null;
  resolvedByName: string | null;
  resolvedAt: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
}

export interface OffboardingProgress {
  /** Rows on the checklist, rejected matches excluded. */
  total: number;
  /** Done, skipped or gone. */
  resolved: number;
  open: number;
  failed: number;
  /** Possible matches still waiting for a person to confirm or reject them. */
  unconfirmed: number;
}

export interface OffboardingSummary {
  id: string;
  email: string;
  /** Display name, when the person is (or was) a member. */
  name: string | null;
  /** Their Infrawrench user id, when known. */
  userId: string | null;
  aliases: string[];
  status: OffboardingStatus;
  source: OffboardingSource;
  /** For a directory-started offboarding: which directory event, in a phrase. */
  sourceDetail: string | null;
  startedByName: string | null;
  note: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  lastScannedAt: string | null;
  /**
   * The last scan matched more synced resources than one scan reads, so some
   * may be missing: "we found nothing more" and "we stopped looking" must not
   * read the same.
   */
  scanTruncated: boolean;
  progress: OffboardingProgress;
}

export interface Offboarding extends OffboardingSummary {
  items: OffboardingItem[];
}

export interface OffboardingListResponse {
  offboardings: OffboardingSummary[];
}

/** A row the sweep found, before it is saved on a checklist. */
export interface OffboardingCandidate {
  /** Stable across scans: what the row upserts on. */
  key: string;
  kind: OffboardingItemKind;
  title: string;
  detail: string | null;
  pluginId: string | null;
  providerName: string | null;
  accountId: string | null;
  accountName: string | null;
  resourceId: string | null;
  resourceTypeId: string | null;
  confidence: OffboardingMatchConfidence;
  matchReason: string;
  actions: OffboardingActionId[];
  /** What the server needs to act: ids, never secrets. */
  ref: Record<string, string>;
}

export interface OffboardingPreview {
  email: string;
  aliases: string[];
  candidates: Omit<OffboardingCandidate, "ref">[];
  scanTruncated: boolean;
}

/** A member who can take something over (a resource, an on-call slot). */
export interface OffboardingMember {
  userId: string;
  name: string | null;
  email: string;
}

export interface OffboardingStartResponse {
  offboarding: Offboarding;
  /** False when an open offboarding for this person already existed. */
  created: boolean;
}

export interface OffboardingActionResult {
  item: OffboardingItem;
  message: string | null;
}

export interface OffboardingStartInput {
  email: string;
  aliases?: string[];
  note?: string | null;
}

export interface OffboardingActionInput {
  action: OffboardingActionId;
  /** The member taking over, for a transfer or a reassignment. */
  targetUserId?: string | null;
}

export interface OffboardingItemUpdate {
  /** Confirm or reject a possible match. */
  matchState?: "confirmed" | "rejected" | "unconfirmed";
  /** Mark a row done by hand, skip it, or reopen it. */
  status?: "done" | "skipped" | "open";
  note?: string | null;
}

export const OFFBOARDING_LIMITS = {
  maxAliases: 20,
  maxAliasLength: 200,
  maxNoteLength: 1000,
  /** A handle shorter than this matches too much to be worth trusting. */
  minAliasLength: 2,
  /** The part before `@` is only a possible match from this length up. */
  minLocalPartLength: 3,
} as const;

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/** Who is leaving: the email they signed in with, plus the names providers know them by. */
export interface OffboardingIdentity {
  email: string;
  aliases: readonly string[];
  /** Full name, when known. Only ever a possible match. */
  name?: string | null;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** True for something shaped like an email address. */
export function isEmailAddress(value: string): boolean {
  return EMAIL_RE.test(value.trim());
}

/** Lower-cased and trimmed: how emails and handles are compared. */
export function normalizeIdentityValue(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * Clean an alias list: trimmed, a leading `@` dropped (`@jdoe` and `jdoe` are
 * one handle), lower-cased, de-duplicated, the email itself and too-short
 * handles removed.
 */
export function normalizeAliases(aliases: readonly string[], email?: string): string[] {
  const own = email ? normalizeIdentityValue(email) : null;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of aliases) {
    const value = normalizeIdentityValue(raw).replace(/^@/, "");
    if (value.length < OFFBOARDING_LIMITS.minAliasLength) continue;
    if (value === own || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

/** Validate a start or alias edit. One sentence, or null. */
export function validateOffboardingIdentity(
  email: string,
  aliases: readonly string[],
): string | null {
  if (!isEmailAddress(email)) return "Enter the email address the person signed in with.";
  if (aliases.length > OFFBOARDING_LIMITS.maxAliases) {
    return `List at most ${OFFBOARDING_LIMITS.maxAliases} aliases.`;
  }
  for (const alias of aliases) {
    if (alias.length > OFFBOARDING_LIMITS.maxAliasLength) {
      return `An alias may be at most ${OFFBOARDING_LIMITS.maxAliasLength} characters.`;
    }
  }
  return null;
}

function localPart(email: string): string {
  return email.slice(0, email.indexOf("@"));
}

export interface IdentityMatch {
  confidence: OffboardingMatchConfidence;
  /** What matched, for the reason sentence. */
  matched: string;
  basis: "email" | "alias" | "local-part" | "other-domain" | "name";
}

const RANK: Record<OffboardingMatchConfidence, number> = { exact: 3, alias: 2, possible: 1 };

/** The stronger of two matches (exact beats alias beats possible). */
export function strongerMatch<T extends { confidence: OffboardingMatchConfidence }>(
  a: T | null,
  b: T | null,
): T | null {
  if (!a) return b;
  if (!b) return a;
  return RANK[b.confidence] > RANK[a.confidence] ? b : a;
}

/**
 * Match one synced value against a person.
 *
 * - **exact**: the value is their email.
 * - **alias**: the value is one of their listed aliases (a handle, an old
 *   email), with or without a leading `@`.
 * - **possible**: the value is the part of their email before the `@`, the
 *   same address at another domain, or their full name. Never acted on until
 *   a person confirms it.
 */
export function matchIdentityValue(
  value: string,
  identity: OffboardingIdentity,
): IdentityMatch | null {
  const v = normalizeIdentityValue(value);
  if (!v) return null;
  const email = normalizeIdentityValue(identity.email);
  if (v === email) return { confidence: "exact", matched: value.trim(), basis: "email" };
  const handle = v.replace(/^@/, "");
  for (const alias of identity.aliases) {
    if (handle === normalizeIdentityValue(alias).replace(/^@/, "")) {
      return { confidence: "alias", matched: value.trim(), basis: "alias" };
    }
  }
  const local = localPart(email);
  if (local.length >= OFFBOARDING_LIMITS.minLocalPartLength) {
    if (handle === local) {
      return { confidence: "possible", matched: value.trim(), basis: "local-part" };
    }
    if (isEmailAddress(v) && localPart(v) === local) {
      return { confidence: "possible", matched: value.trim(), basis: "other-domain" };
    }
  }
  const name = identity.name ? normalizeIdentityValue(identity.name) : "";
  // A one-word name ("admin", "deploy") matches far too much to suggest.
  if (name.includes(" ") && v === name) {
    return { confidence: "possible", matched: value.trim(), basis: "name" };
  }
  return null;
}

export interface FieldMatch extends IdentityMatch {
  /** The field key the value was found under ("" for a top-level value). */
  field: string;
}

/**
 * The strongest match anywhere in a synced resource's fields: strings at any
 * depth, under any key, so a `createdBy`, an `owner` tag or a member's
 * `email` all count. Bounded so a pathological document cannot stall a scan.
 */
export function matchIdentityFields(
  fields: unknown,
  identity: OffboardingIdentity,
): FieldMatch | null {
  let best: FieldMatch | null = null;
  let budget = 2000;
  const walk = (value: unknown, key: string, depth: number) => {
    if (budget-- <= 0 || depth > 6 || best?.confidence === "exact") return;
    if (typeof value === "string") {
      // Long strings are documents (a policy, a certificate), not identities.
      if (value.length > 320) return;
      const hit = matchIdentityValue(value, identity);
      if (hit) best = strongerMatch(best, { ...hit, field: key });
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) walk(item, key, depth + 1);
      return;
    }
    if (value && typeof value === "object") {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        // A tag map's key is the label; its value is what names someone.
        walk(v, key ? `${key}.${k}` : k, depth + 1);
      }
    }
  };
  walk(fields, "", 0);
  return best;
}

/** The sentence a match reads as on the checklist. */
export function describeIdentityMatch(match: IdentityMatch, where?: string): string {
  const at = where ? ` in ${where}` : "";
  switch (match.basis) {
    case "email":
      return `Their email${at}`;
    case "alias":
      return `Alias "${match.matched}"${at}`;
    case "local-part":
      return `"${match.matched}"${at} matches the start of their email`;
    case "other-domain":
      return `${match.matched}${at} has the same name at another domain`;
    case "name":
      return `Their name${at}`;
  }
}

/** The initial match state for a fresh row. */
export function initialMatchState(confidence: OffboardingMatchConfidence): OffboardingMatchState {
  return confidence === "possible" ? "unconfirmed" : "matched";
}

/** Whether a row's actions may be offered: never on an unconfirmed or rejected match. */
export function offboardingItemActionable(
  item: Pick<OffboardingItem, "matchState" | "status">,
): boolean {
  if (item.matchState === "unconfirmed" || item.matchState === "rejected") return false;
  return item.status === "open" || item.status === "failed";
}

// ---------------------------------------------------------------------------
// Progress
// ---------------------------------------------------------------------------

export function offboardingProgress(
  items: readonly Pick<OffboardingItem, "status" | "matchState">[],
): OffboardingProgress {
  const progress: OffboardingProgress = {
    total: 0,
    resolved: 0,
    open: 0,
    failed: 0,
    unconfirmed: 0,
  };
  for (const item of items) {
    if (item.matchState === "rejected") continue;
    progress.total += 1;
    if (item.status === "done" || item.status === "skipped" || item.status === "gone") {
      progress.resolved += 1;
    } else if (item.status === "failed") {
      progress.failed += 1;
    } else {
      progress.open += 1;
    }
    if (item.matchState === "unconfirmed" && item.status === "open") progress.unconfirmed += 1;
  }
  return progress;
}

/** Order for display: open work first (failed at the top), then by kind and title. */
export function sortOffboardingItems<T extends OffboardingItem>(items: readonly T[]): T[] {
  const statusRank: Record<OffboardingItemStatus, number> = {
    failed: 0,
    open: 1,
    done: 2,
    skipped: 3,
    gone: 4,
  };
  const kindRank = new Map(OFFBOARDING_ITEM_KINDS.map((k, i) => [k, i]));
  return [...items].sort(
    (a, b) =>
      statusRank[a.status] - statusRank[b.status] ||
      (kindRank.get(a.kind) ?? 99) - (kindRank.get(b.kind) ?? 99) ||
      a.title.localeCompare(b.title),
  );
}

// ---------------------------------------------------------------------------
// Labels (CLI and CSV; the UI translates its own)
// ---------------------------------------------------------------------------

export const OFFBOARDING_ITEM_KIND_LABELS: Record<OffboardingItemKind, string> = {
  member: "Infrawrench membership",
  "api-key": "Infrawrench API key",
  "ssh-key": "Infrawrench SSH key",
  principal: "Cloud access",
  seat: "Paid seat",
  resource: "Resource",
  "on-call": "On-call rotation",
  "on-call-cover": "On-call cover",
  lease: "Resource lease",
  "jit-grant": "Just-in-time grant",
};

export const OFFBOARDING_ACTION_LABELS: Record<OffboardingActionId, string> = {
  revoke: "Revoke",
  remove: "Remove",
  "remove-seat": "Remove seat",
  "remove-member": "Remove from organization",
  "revoke-api-key": "Revoke key",
  "delete-ssh-key": "Delete key",
  "transfer-ownership": "Transfer ownership",
  "reassign-on-call": "Reassign",
  "remove-from-rotation": "Remove from rotation",
  "cancel-cover": "Cancel cover",
  "cancel-lease": "Cancel lease",
  "revoke-jit": "Revoke grant",
};

// ---------------------------------------------------------------------------
// CSV evidence
// ---------------------------------------------------------------------------

/**
 * RFC 4180 quoting, every cell quoted, with a leading `=`/`+`/`-`/`@`
 * neutralised: names come from the customer's providers, and an evidence file
 * that executed them would be a formula-injection hole (the access review's
 * export makes the same choice).
 */
function csvCell(value: string | null): string {
  const text = value ?? "";
  const guarded = /^[=+\-@\t\r]/.test(text) ? `\t${text}` : text;
  return `"${guarded.replace(/"/g, '""')}"`;
}

const CSV_COLUMNS: readonly [string, (o: Offboarding, i: OffboardingItem) => string | null][] = [
  ["Person", (o) => o.email],
  ["Offboarding status", (o) => o.status],
  ["Started", (o) => o.createdAt],
  ["Item", (_, i) => i.title],
  ["Kind", (_, i) => OFFBOARDING_ITEM_KIND_LABELS[i.kind] ?? i.kind],
  ["Provider", (_, i) => i.providerName ?? "Infrawrench"],
  ["Account", (_, i) => i.accountName],
  ["Detail", (_, i) => i.detail],
  ["Match", (_, i) => i.confidence],
  ["Match reason", (_, i) => i.matchReason],
  ["Confirmation", (_, i) => i.matchState],
  ["Status", (_, i) => i.status],
  ["Resolution", (_, i) => i.resolution],
  ["Resolved by", (_, i) => i.resolvedByName],
  ["Resolved at", (_, i) => i.resolvedAt],
  ["Note", (_, i) => i.note],
  ["Last error", (_, i) => i.lastError],
];

/**
 * The checklist as CSV, one row per item, rejected matches included and
 * labelled: an auditor asks what was found and what was decided, and "we
 * looked and it was not them" is a decision.
 */
export function offboardingToCsv(offboarding: Offboarding): string {
  const lines = [CSV_COLUMNS.map(([label]) => csvCell(label)).join(",")];
  for (const item of sortOffboardingItems(offboarding.items)) {
    lines.push(CSV_COLUMNS.map(([, read]) => csvCell(read(offboarding, item))).join(","));
  }
  return `${lines.join("\r\n")}\r\n`;
}

// ---------------------------------------------------------------------------
// Bearer helpers
// ---------------------------------------------------------------------------

/** `GET /api/org/:orgId/offboardings` (`team:remove`). */
export async function fetchOffboardings(
  api: CloudFetch,
  orgId: string,
): Promise<OffboardingListResponse> {
  return (await api.org<OffboardingListResponse>(orgId, "/offboardings")) ?? { offboardings: [] };
}

/** `GET /api/org/:orgId/offboardings/:id`. */
export async function fetchOffboarding(
  api: CloudFetch,
  orgId: string,
  id: string,
): Promise<Offboarding | null> {
  return api.org<Offboarding>(orgId, `/offboardings/${encodeURIComponent(id)}`);
}

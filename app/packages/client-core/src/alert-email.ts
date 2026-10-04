/**
 * Email as an alert transport: the recipient contract, the external-address
 * policy and the pure checks both ends run.
 *
 * Two places name email recipients, and they share this one shape:
 *
 * - **Alert routing** destinations (`email-member` / `email-address` in
 *   {@link AlertDestination}), the general path: any trigger, any condition.
 * - **Per-object recipients** on the cost alerts that people set up one at a
 *   time (a budget, a change alert, the anomaly settings, the commitment and
 *   unit-cost settings). Those are delivered *in addition to* whatever the
 *   routing rules decide, because "tell finance when this budget hits 80%"
 *   belongs on the budget, not in a rule somebody else maintains.
 *
 * Members are stored by **user id**, never by address: the address is read at
 * send time, so somebody who changes their email keeps getting alerts and a
 * leaver stops the moment their membership ends. Extra addresses are the
 * escape hatch for a `finance@` alias or an exec with no login, and that is
 * where the policy below applies: by default an address must be on a domain
 * the org's own members use (or one an admin allowlisted), so a cost-object
 * editor cannot quietly mail the org's spend to an outside inbox.
 *
 * Pure: no I/O, no clock. The server validates writes with these functions
 * and re-checks at send time (a policy can tighten after a save); the editors
 * run the same checks so a form fails before the round trip.
 */

import type { CloudFetch } from "./fetch";

/** Who an alert email goes to. Both lists may be empty (no email). */
export interface AlertEmailRecipients {
  /** Org members, by user id. Resolved to their current address at send time. */
  userIds: string[];
  /** Extra addresses, lowercased. Subject to {@link AlertEmailSettings}. */
  addresses: string[];
}

export const EMPTY_ALERT_EMAIL_RECIPIENTS: AlertEmailRecipients = Object.freeze({
  userIds: [],
  addresses: [],
}) as AlertEmailRecipients;

/** Bounds the API enforces, exported so editors can enforce the same ones. */
export const ALERT_EMAIL_LIMITS = {
  /** Members per recipient list. Past this it is an all-hands mail, not an alert. */
  maxMembers: 50,
  /** Extra addresses per recipient list. */
  maxAddresses: 20,
  /** Allowlisted domains per org. */
  maxAllowedDomains: 50,
  maxAddressLength: 320,
  maxDomainLength: 253,
} as const;

/**
 * Which extra addresses an org accepts.
 *
 * - `member-domains` (the default): the address's domain must be one an org
 *   member's own login uses, or one listed in `allowedDomains`.
 * - `any`: no restriction. An admin decision, made in Settings.
 */
export type AlertEmailExternalPolicy = "member-domains" | "any";

export const ALERT_EMAIL_EXTERNAL_POLICIES: readonly AlertEmailExternalPolicy[] = [
  "member-domains",
  "any",
];

export interface AlertEmailSettings {
  externalPolicy: AlertEmailExternalPolicy;
  /** Extra domains accepted under `member-domains`, lowercased, no `@`. */
  allowedDomains: string[];
}

export const DEFAULT_ALERT_EMAIL_SETTINGS: AlertEmailSettings = Object.freeze({
  externalPolicy: "member-domains",
  allowedDomains: [],
}) as AlertEmailSettings;

/** A member as the recipient picker shows them. */
export interface AlertEmailMember {
  userId: string;
  name: string | null;
  email: string;
}

/**
 * `GET /api/org/:orgId/alert-email`: everything a recipient picker needs.
 * Readable by anyone who can read costs, since every cost-object editor needs
 * the member list and the policy to tell the truth about what will send.
 */
export interface AlertEmailOptions {
  /** False when the deployment has no mail provider configured. */
  emailAvailable: boolean;
  members: AlertEmailMember[];
  settings: AlertEmailSettings;
  /** Domains the org's members use, the implicit half of `member-domains`. */
  memberDomains: string[];
}

/** An address that asked not to receive this org's alert email. */
export interface AlertEmailSuppression {
  id: string;
  email: string;
  createdAt: string;
}

/** `GET /api/org/:orgId/alert-email/settings` (admin view). */
export interface AlertEmailSettingsView extends AlertEmailSettings {
  emailAvailable: boolean;
  memberDomains: string[];
  suppressions: AlertEmailSuppression[];
}

// --- Normalization and validation ---

const ADDRESS_RE = /^[^\s@,;<>"]+@[^\s@,;<>".]+(\.[^\s@,;<>".]+)+$/;
const DOMAIN_RE = /^(?!-)[a-z0-9-]+(\.[a-z0-9-]+)+$/;

/** Lowercase and trim an address; null when it is not plausibly one. */
export function normalizeAlertEmailAddress(raw: string): string | null {
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed || trimmed.length > ALERT_EMAIL_LIMITS.maxAddressLength) return null;
  return ADDRESS_RE.test(trimmed) ? trimmed : null;
}

/** Lowercase a domain, tolerating a leading `@`; null when malformed. */
export function normalizeAlertEmailDomain(raw: string): string | null {
  const trimmed = raw.trim().toLowerCase().replace(/^@/, "");
  if (!trimmed || trimmed.length > ALERT_EMAIL_LIMITS.maxDomainLength) return null;
  return DOMAIN_RE.test(trimmed) ? trimmed : null;
}

/** The part after the last `@`, lowercased. */
export function alertEmailDomain(address: string): string {
  return address.slice(address.lastIndexOf("@") + 1).toLowerCase();
}

/** The distinct domains a list of member addresses uses, sorted. */
export function memberEmailDomains(emails: Iterable<string>): string[] {
  const out = new Set<string>();
  for (const e of emails) {
    if (e.includes("@")) out.add(alertEmailDomain(e));
  }
  return [...out].sort();
}

/**
 * Whether an extra address passes the org's policy. Subdomains of an allowed
 * domain do not pass on their own: `example.com` allowing `mail.example.com`
 * would let anyone who controls a subdomain of a shared host qualify.
 */
export function isAlertEmailAddressAllowed(
  address: string,
  settings: AlertEmailSettings,
  memberDomains: readonly string[],
): boolean {
  if (settings.externalPolicy === "any") return true;
  const domain = alertEmailDomain(address);
  return memberDomains.includes(domain) || settings.allowedDomains.includes(domain);
}

/** `GET /alert-email`: the picker options, for clients without a host-specific transport. */
export async function getAlertEmailOptions(
  api: CloudFetch,
  orgId: string,
): Promise<AlertEmailOptions> {
  const res = await api.org<AlertEmailOptions>(orgId, "/alert-email");
  if (!res) throw new Error("Empty response from /alert-email");
  return res;
}

/** Total recipients named, members plus addresses. */
export function alertEmailRecipientCount(r: AlertEmailRecipients | null | undefined): number {
  return r ? r.userIds.length + r.addresses.length : 0;
}

/**
 * Dedupe and lowercase a recipient list without judging it. Unparseable
 * addresses are kept (lowercased) so {@link alertEmailRecipientsError} can
 * name them rather than having them vanish from the form.
 */
export function normalizeAlertEmailRecipients(
  r: Partial<AlertEmailRecipients> | null | undefined,
): AlertEmailRecipients {
  const userIds = [...new Set((r?.userIds ?? []).filter((id) => typeof id === "string" && id))];
  const addresses = [
    ...new Set(
      (r?.addresses ?? [])
        .filter((a) => typeof a === "string")
        .map((a) => a.trim().toLowerCase())
        .filter((a) => a !== ""),
    ),
  ];
  return { userIds, addresses };
}

export interface AlertEmailValidationContext {
  /** Every current member's user id. */
  memberIds: ReadonlySet<string>;
  settings: AlertEmailSettings;
  memberDomains: readonly string[];
}

/**
 * The first thing wrong with a recipient list, or null. Expects a list that
 * went through {@link normalizeAlertEmailRecipients}.
 */
export function alertEmailRecipientsError(
  r: AlertEmailRecipients,
  ctx: AlertEmailValidationContext,
): string | null {
  if (r.userIds.length > ALERT_EMAIL_LIMITS.maxMembers) {
    return `At most ${ALERT_EMAIL_LIMITS.maxMembers} members per recipient list`;
  }
  if (r.addresses.length > ALERT_EMAIL_LIMITS.maxAddresses) {
    return `At most ${ALERT_EMAIL_LIMITS.maxAddresses} extra addresses per recipient list`;
  }
  const unknown = r.userIds.filter((id) => !ctx.memberIds.has(id));
  if (unknown.length > 0) return `Not a member of this organization: ${unknown.join(", ")}`;
  for (const a of r.addresses) {
    const normalized = normalizeAlertEmailAddress(a);
    if (!normalized) return `"${a}" doesn't look like an email address`;
    if (!isAlertEmailAddressAllowed(normalized, ctx.settings, ctx.memberDomains)) {
      return `${normalized} is outside the domains this organization allows for alert email. An admin can allow its domain in Settings → Notifications → Email.`;
    }
  }
  return null;
}

/** The first thing wrong with a settings body, or null. */
export function alertEmailSettingsError(s: AlertEmailSettings): string | null {
  if (!ALERT_EMAIL_EXTERNAL_POLICIES.includes(s.externalPolicy)) {
    return `externalPolicy must be one of ${ALERT_EMAIL_EXTERNAL_POLICIES.join(", ")}`;
  }
  if (!Array.isArray(s.allowedDomains)) return "allowedDomains must be an array";
  if (s.allowedDomains.length > ALERT_EMAIL_LIMITS.maxAllowedDomains) {
    return `At most ${ALERT_EMAIL_LIMITS.maxAllowedDomains} allowed domains`;
  }
  for (const d of s.allowedDomains) {
    if (typeof d !== "string" || !normalizeAlertEmailDomain(d)) {
      return `"${String(d)}" is not a domain name`;
    }
  }
  return null;
}

/** Lowercase, strip `@`, dedupe and sort the allowlist. Drops malformed entries. */
export function normalizeAlertEmailSettings(s: Partial<AlertEmailSettings>): AlertEmailSettings {
  const externalPolicy = ALERT_EMAIL_EXTERNAL_POLICIES.includes(
    s.externalPolicy as AlertEmailExternalPolicy,
  )
    ? (s.externalPolicy as AlertEmailExternalPolicy)
    : DEFAULT_ALERT_EMAIL_SETTINGS.externalPolicy;
  const allowedDomains = [
    ...new Set(
      (Array.isArray(s.allowedDomains) ? s.allowedDomains : [])
        .map((d) => (typeof d === "string" ? normalizeAlertEmailDomain(d) : null))
        .filter((d): d is string => d !== null),
    ),
  ].sort();
  return { externalPolicy, allowedDomains };
}

/**
 * One line for a list row: "Alice, Bob and 2 more", using member names where
 * the caller knows them. Empty string for an empty list.
 */
export function describeAlertEmailRecipients(
  r: AlertEmailRecipients | null | undefined,
  members: readonly AlertEmailMember[] = [],
): string {
  if (!r) return "";
  const byId = new Map(members.map((m) => [m.userId, m]));
  const names = [
    ...r.userIds.map((id) => {
      const m = byId.get(id);
      return m ? m.name || m.email : "a former member";
    }),
    ...r.addresses,
  ];
  if (names.length === 0) return "";
  if (names.length <= 2) return names.join(" and ");
  return `${names.slice(0, 2).join(", ")} and ${names.length - 2} more`;
}

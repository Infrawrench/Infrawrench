/**
 * Email as an alert transport: recipient resolution, the external-address
 * policy, unsubscribe, and the send itself.
 *
 * It reuses the weekly digest's sender (`email.ts`, Mailgun over `fetch`) and
 * HTML helpers (`email-html.ts`) rather than adding a second mail path, so a
 * deployment configures mail once and every feature that sends it agrees on
 * the env vars, the timeout and the one-request-per-address rule.
 *
 * ## What is checked at send time, not just at save time
 *
 * Everything that can change after a recipient list was saved:
 *
 * - **Membership.** Members are stored by user id and resolved to their
 *   *current* address here, so an email change follows them and a leaver
 *   receives nothing the moment their membership row is gone.
 * - **Policy.** An admin can tighten the external-address policy after a
 *   budget named an outside address; the address stops receiving immediately,
 *   without anybody having to find and edit every object that names it.
 * - **Suppressions.** An address that clicked unsubscribe is skipped for every
 *   alert this org sends, whichever object or rule names it.
 *
 * Never throws: like every transport, a mail failure must not break the
 * detector that raised the alert.
 */
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import {
  type AlertEmailMember,
  type AlertEmailOptions,
  type AlertEmailRecipients,
  type AlertEmailSettings,
  type AlertEmailSettingsView,
  type AlertEmailSuppression,
  type AlertSeverity,
  DEFAULT_ALERT_EMAIL_SETTINGS,
  alertEmailRecipientsError,
  alertTriggerDef,
  isAlertEmailAddressAllowed,
  memberEmailDomains,
  normalizeAlertEmailAddress,
  normalizeAlertEmailRecipients,
  normalizeAlertEmailSettings,
} from "@infrawrench/client-core";

import { db } from "../db/client";
import {
  alertEmailSuppressions,
  orgAlertEmailSettings,
  organizationMembers,
  organizations,
  users,
} from "../db/schema";
import { appPath, orgAppUrl } from "../app-url";
import { type EmailMessage, isEmailConfigured, sendEmails } from "../email";
import { renderAlertEmail } from "./email-render";
import { AlertEmailRecipientsError } from "./email-errors";

// --- Settings ---

export async function getAlertEmailSettings(organizationId: string): Promise<AlertEmailSettings> {
  const [row] = await db
    .select({
      externalPolicy: orgAlertEmailSettings.externalPolicy,
      allowedDomains: orgAlertEmailSettings.allowedDomains,
    })
    .from(orgAlertEmailSettings)
    .where(eq(orgAlertEmailSettings.organizationId, organizationId))
    .limit(1);
  // No row is the shipped default; a hand-written row is normalized rather
  // than trusted, and an unknown policy fails closed to `member-domains`.
  return row ? normalizeAlertEmailSettings(row) : { ...DEFAULT_ALERT_EMAIL_SETTINGS };
}

export async function setAlertEmailSettings(
  organizationId: string,
  settings: AlertEmailSettings,
): Promise<AlertEmailSettings> {
  const normalized = normalizeAlertEmailSettings(settings);
  await db
    .insert(orgAlertEmailSettings)
    .values({ organizationId, ...normalized })
    .onConflictDoUpdate({
      target: orgAlertEmailSettings.organizationId,
      set: { ...normalized, updatedAt: new Date() },
    });
  return normalized;
}

// --- Members ---

/** Current members with their login address, alphabetical by name then email. */
export async function listAlertEmailMembers(organizationId: string): Promise<AlertEmailMember[]> {
  const rows = await db
    .select({ userId: users.id, name: users.displayName, email: users.email })
    .from(organizationMembers)
    .innerJoin(users, eq(organizationMembers.userId, users.id))
    .where(eq(organizationMembers.organizationId, organizationId));
  return rows
    .map((r) => ({ userId: r.userId, name: r.name ?? null, email: r.email.toLowerCase() }))
    .sort((a, b) => (a.name ?? a.email).localeCompare(b.name ?? b.email));
}

/** Everything a recipient picker needs (`GET /alert-email`). */
export async function getAlertEmailOptions(organizationId: string): Promise<AlertEmailOptions> {
  const [members, settings] = await Promise.all([
    listAlertEmailMembers(organizationId),
    getAlertEmailSettings(organizationId),
  ]);
  return {
    emailAvailable: isEmailConfigured(),
    members,
    settings,
    memberDomains: memberEmailDomains(members.map((m) => m.email)),
  };
}

export async function getAlertEmailSettingsView(
  organizationId: string,
): Promise<AlertEmailSettingsView> {
  const [options, suppressions] = await Promise.all([
    getAlertEmailOptions(organizationId),
    listAlertEmailSuppressions(organizationId),
  ]);
  return {
    ...options.settings,
    emailAvailable: options.emailAvailable,
    memberDomains: options.memberDomains,
    suppressions,
  };
}

/** Thrown by {@link validateAlertEmailRecipients}; the route answers 400 with its message. */
export { AlertEmailRecipientsError };

/**
 * Normalize a recipient list and check it against the org's members and
 * policy. Throws {@link AlertEmailRecipientsError} with a user-facing message.
 * `undefined` passes straight through: on every write path absent means
 * "leave the stored list alone".
 */
export async function validateAlertEmailRecipients(
  organizationId: string,
  raw: AlertEmailRecipients | undefined,
): Promise<AlertEmailRecipients | undefined> {
  if (raw === undefined) return undefined;
  const recipients = normalizeAlertEmailRecipients(raw);
  if (recipients.userIds.length === 0 && recipients.addresses.length === 0) return recipients;
  const options = await getAlertEmailOptions(organizationId);
  const error = alertEmailRecipientsError(recipients, {
    memberIds: new Set(options.members.map((m) => m.userId)),
    settings: options.settings,
    memberDomains: options.memberDomains,
  });
  if (error) throw new AlertEmailRecipientsError(error);
  return {
    userIds: recipients.userIds,
    addresses: recipients.addresses.map((a) => normalizeAlertEmailAddress(a) ?? a),
  };
}

/** Read a stored jsonb column defensively: a hand-edited row must not throw. */
export function storedAlertEmailRecipients(value: unknown): AlertEmailRecipients {
  if (!value || typeof value !== "object") return { userIds: [], addresses: [] };
  return normalizeAlertEmailRecipients(value as Partial<AlertEmailRecipients>);
}

// --- Suppressions ---

export async function listAlertEmailSuppressions(
  organizationId: string,
): Promise<AlertEmailSuppression[]> {
  const rows = await db
    .select()
    .from(alertEmailSuppressions)
    .where(eq(alertEmailSuppressions.organizationId, organizationId))
    .orderBy(alertEmailSuppressions.email);
  return rows.map((r) => ({ id: r.id, email: r.email, createdAt: r.createdAt.toISOString() }));
}

/** Idempotent: unsubscribing twice is one row. */
export async function suppressAlertEmail(organizationId: string, email: string): Promise<void> {
  await db
    .insert(alertEmailSuppressions)
    .values({ id: randomUUID(), organizationId, email: email.toLowerCase() })
    .onConflictDoNothing();
}

/** Lift a suppression. False when the id is not this org's. */
export async function removeAlertEmailSuppression(
  organizationId: string,
  id: string,
): Promise<boolean> {
  const deleted = await db
    .delete(alertEmailSuppressions)
    .where(
      and(
        eq(alertEmailSuppressions.id, id),
        eq(alertEmailSuppressions.organizationId, organizationId),
      ),
    )
    .returning({ id: alertEmailSuppressions.id });
  return deleted.length > 0;
}

// --- Unsubscribe tokens ---

/**
 * A key for the unsubscribe HMAC, derived from `ENCRYPTION_MASTER_KEY` under
 * its own label so it can never be confused with any other keyed hash.
 * Synchronous (unlike `keyedHash`) because it is computed per recipient inside
 * a render loop; the derivation is one HMAC.
 */
function unsubscribeKey(): Buffer {
  const raw = process.env["ENCRYPTION_MASTER_KEY"];
  if (!raw) throw new Error("ENCRYPTION_MASTER_KEY environment variable is required");
  return createHmac("sha256", Buffer.from(raw, "base64"))
    .update("infrawrench:alert-email-unsubscribe:v1")
    .digest();
}

function tokenSignature(payload: string): string {
  return createHmac("sha256", unsubscribeKey()).update(payload).digest("base64url").slice(0, 32);
}

/**
 * `<base64url(org \n email)>.<signature>`. No expiry, deliberately: an
 * unsubscribe link in a six-month-old email must still work, and the only
 * thing the token can do is stop mail to the address it names.
 */
export function signUnsubscribeToken(organizationId: string, email: string): string {
  const payload = Buffer.from(`${organizationId}\n${email.toLowerCase()}`).toString("base64url");
  return `${payload}.${tokenSignature(payload)}`;
}

export function verifyUnsubscribeToken(
  token: string | undefined | null,
): { organizationId: string; email: string } | null {
  if (!token) return null;
  const dot = token.indexOf(".");
  if (dot <= 0) return null;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  let expected: string;
  try {
    expected = tokenSignature(payload);
  } catch {
    return null;
  }
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  const decoded = Buffer.from(payload, "base64url").toString("utf8");
  const nl = decoded.indexOf("\n");
  if (nl <= 0) return null;
  const organizationId = decoded.slice(0, nl);
  const email = decoded.slice(nl + 1);
  if (!email.includes("@")) return null;
  return { organizationId, email };
}

/** The public unsubscribe link, or null without `APP_URL`. */
export function unsubscribeUrl(organizationId: string, email: string): string | null {
  return appPath(
    `/api/alert-email/unsubscribe?t=${encodeURIComponent(signUnsubscribeToken(organizationId, email))}`,
  );
}

/** Where a member changes who gets alert email: the Notifications settings page. */
export function alertEmailManageUrl(organizationId: string): string | null {
  return orgAppUrl(organizationId, "settings/paging");
}

// --- Sending ---

/** What is being sent, independent of who it goes to. */
export interface AlertEmailEvent {
  organizationId: string;
  trigger: string;
  severity: AlertSeverity;
  title: string;
  body: string;
  context?: string;
  url?: string | null;
}

export interface AlertEmailSendResult {
  /** Addresses a message was attempted to. */
  attempted: number;
  succeeded: number;
}

/**
 * Send one alert to a recipient list. `alreadySent` is shared across one
 * `routeAlert` call so a member named by a rule *and* by the budget itself, or
 * by their user id in one place and their address in another, gets one copy.
 */
export async function sendAlertEmail(
  event: AlertEmailEvent,
  recipients: AlertEmailRecipients,
  reason: string,
  alreadySent: Set<string>,
  manageUrl?: string | null,
): Promise<AlertEmailSendResult> {
  try {
    const normalized = normalizeAlertEmailRecipients(recipients);
    if (normalized.userIds.length === 0 && normalized.addresses.length === 0) {
      return { attempted: 0, succeeded: 0 };
    }

    const [org, members, settings, suppressed] = await Promise.all([
      db
        .select({ name: organizations.displayName })
        .from(organizations)
        .where(eq(organizations.id, event.organizationId))
        .limit(1)
        .then((r) => r[0]),
      listAlertEmailMembers(event.organizationId),
      getAlertEmailSettings(event.organizationId),
      suppressedAddresses(event.organizationId),
    ]);
    const memberById = new Map(members.map((m) => [m.userId, m]));
    const memberDomains = memberEmailDomains(members.map((m) => m.email));

    const targets: string[] = [];
    for (const id of normalized.userIds) {
      // A leaver resolves to nothing: their membership row is the authority.
      const member = memberById.get(id);
      if (member) targets.push(member.email);
    }
    for (const raw of normalized.addresses) {
      const address = normalizeAlertEmailAddress(raw);
      if (!address) continue;
      // Re-checked here because the policy may have tightened since the list
      // was saved; an address that no longer passes simply stops receiving.
      if (!isAlertEmailAddressAllowed(address, settings, memberDomains)) {
        console.log(
          `[alerts] email to ${address} skipped for org ${event.organizationId}: outside the external-address policy`,
        );
        continue;
      }
      targets.push(address);
    }

    const fresh = targets.filter((address) => {
      if (alreadySent.has(address) || suppressed.has(address)) return false;
      alreadySent.add(address);
      return true;
    });
    if (fresh.length === 0) return { attempted: 0, succeeded: 0 };

    const def = alertTriggerDef(event.trigger as Parameters<typeof alertTriggerDef>[0]);
    const manage = manageUrl === undefined ? alertEmailManageUrl(event.organizationId) : manageUrl;
    const messages: EmailMessage[] = fresh.map((address) => {
      const unsub = unsubscribeUrl(event.organizationId, address);
      const rendered = renderAlertEmail(
        {
          orgName: org?.name ?? "Infrawrench",
          severity: event.severity,
          triggerLabel: def.label,
          title: event.title,
          body: event.body,
          ...(event.context ? { context: event.context } : {}),
          url: event.url ?? null,
        },
        { recipient: address, reason, manageUrl: manage, unsubscribeUrl: unsub },
      );
      return {
        to: address,
        subject: rendered.subject,
        text: rendered.text,
        html: rendered.html,
        traceKey: `alert:${event.organizationId}:${event.trigger}:${address}`,
        // RFC 8058 one-click: the mailbox provider POSTs
        // `List-Unsubscribe=One-Click` to the https URL, no cookies, no
        // redirect, which is exactly what the public route accepts.
        ...(unsub
          ? {
              headers: {
                "List-Unsubscribe": `<${unsub}>`,
                "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
              },
            }
          : {}),
      };
    });

    const result = await sendEmails(messages, `${event.trigger} alert`);
    return { attempted: result.attempted || messages.length, succeeded: result.succeeded };
  } catch (err) {
    console.error("[alerts] alert email failed:", err);
    return { attempted: 0, succeeded: 0 };
  }
}

async function suppressedAddresses(organizationId: string): Promise<Set<string>> {
  const rows = await db
    .select({ email: alertEmailSuppressions.email })
    .from(alertEmailSuppressions)
    .where(eq(alertEmailSuppressions.organizationId, organizationId));
  return new Set(rows.map((r) => r.email));
}

/** Members among `userIds`, for routes that need to validate a destination list. */
export async function orgMemberIds(
  organizationId: string,
  userIds: string[],
): Promise<Set<string>> {
  if (userIds.length === 0) return new Set();
  const rows = await db
    .select({ userId: organizationMembers.userId })
    .from(organizationMembers)
    .where(
      and(
        eq(organizationMembers.organizationId, organizationId),
        inArray(organizationMembers.userId, userIds),
      ),
    );
  return new Set(rows.map((r) => r.userId));
}

import type { CloudFetch } from "./fetch";

/**
 * Weekly infrastructure digest — org-level settings. Server contract:
 * org-scoped `/api/org/:orgId/digest/*` routes (see web `api/routes/digest.ts`).
 *
 * The digest is a weekly summary of the last complete Monday-to-Sunday week's
 * spend, sync incidents, and resource churn, delivered to the Slack channels
 * and Teams webhooks that opted into the `weeklyDigest` trigger and to the
 * org's digest email recipients. This module carries the org-level settings,
 * the last-attempt bookkeeping, and the email recipient list; Slack and Teams
 * routing lives with their own settings.
 */

/** ISO day of week the digest fires on: 1 = Monday … 7 = Sunday. */
export type DigestSendDay = 1 | 2 | 3 | 4 | 5 | 6 | 7;

/**
 * What the most recent delivery attempt did.
 *
 * - `succeeded` — every destination took it.
 * - `partial` — some destinations took it and some failed. Deliberately *not*
 *   retried: a retry would post the digest twice where it already landed.
 * - `failed` — nothing landed. Retried a bounded number of times with backoff,
 *   then parked until next week.
 * - `no_targets` — the digest is on but nothing is routed to receive it.
 * - `pending` — an attempt is in flight.
 */
export type DigestStatus = "pending" | "succeeded" | "partial" | "failed" | "no_targets";

export interface DigestSettings {
  enabled: boolean;
  /** Monday (ISO `YYYY-MM-DD`, in `timezone`) of the last week a digest covered. */
  lastSentWeekStart: string | null;
  /** When the last digest actually reached someone. */
  lastSentAt: string | null;
  /** IANA zone the schedule and the week boundary are expressed in. */
  timezone: string;
  sendDay: DigestSendDay;
  /** Local hour, 0–23. */
  sendHour: number;
  /** Whether an AI-written summary paragraph tops the digest. Opt-in, default off. */
  narrativeEnabled: boolean;
  /** Whether this deployment has an LLM key configured at all. */
  narrativeAvailable: boolean;
  /** Whether this deployment has a mail provider configured at all. */
  emailAvailable: boolean;
  /** Attempts made for `lastSentWeekStart`'s window, including the first. */
  attemptCount: number;
  lastAttemptAt: string | null;
  lastStatus: DigestStatus | null;
  /** Why the last attempt was not a clean success. */
  lastError: string | null;
  /** When the next automatic retry is due, or null when none is scheduled. */
  nextAttemptAt: string | null;
}

export interface DigestTransportResult {
  attempted: number;
  succeeded: number;
}

export interface DigestSendResult {
  ok: boolean;
  /** Deliveries attempted across every transport. */
  attempted: number;
  succeeded: number;
  slack: DigestTransportResult;
  teams: DigestTransportResult;
  email: DigestTransportResult;
}

export interface DigestEmailRecipient {
  id: string;
  email: string;
}

export interface DigestSettingsPatch {
  enabled?: boolean;
  timezone?: string;
  sendDay?: DigestSendDay;
  sendHour?: number;
  narrativeEnabled?: boolean;
}

const EMPTY_SETTINGS: DigestSettings = {
  enabled: false,
  lastSentWeekStart: null,
  lastSentAt: null,
  timezone: "UTC",
  sendDay: 1,
  sendHour: 7,
  narrativeEnabled: false,
  narrativeAvailable: false,
  emailAvailable: false,
  attemptCount: 0,
  lastAttemptAt: null,
  lastStatus: null,
  lastError: null,
  nextAttemptAt: null,
};

export async function getDigestSettings(api: CloudFetch, orgId: string): Promise<DigestSettings> {
  return (await api.org<DigestSettings>(orgId, "/digest")) ?? EMPTY_SETTINGS;
}

export async function updateDigestSettings(
  api: CloudFetch,
  orgId: string,
  patch: DigestSettingsPatch,
): Promise<DigestSettings | null> {
  return api.org<DigestSettings>(orgId, "/digest", {
    method: "PUT",
    body: JSON.stringify(patch),
  });
}

/** Compose last week's digest and send it now, regardless of schedule. */
export async function sendDigestNow(
  api: CloudFetch,
  orgId: string,
): Promise<DigestSendResult | null> {
  return api.org<DigestSendResult>(orgId, "/digest/send", { method: "POST" });
}

export async function listDigestRecipients(
  api: CloudFetch,
  orgId: string,
): Promise<DigestEmailRecipient[]> {
  const res = await api.org<{ recipients: DigestEmailRecipient[] }>(orgId, "/digest/recipients");
  return res?.recipients ?? [];
}

export async function addDigestRecipient(
  api: CloudFetch,
  orgId: string,
  email: string,
): Promise<DigestEmailRecipient | null> {
  return api.org<DigestEmailRecipient>(orgId, "/digest/recipients", {
    method: "POST",
    body: JSON.stringify({ email }),
  });
}

export async function removeDigestRecipient(
  api: CloudFetch,
  orgId: string,
  id: string,
): Promise<void> {
  await api.org(orgId, `/digest/recipients/${encodeURIComponent(id)}`, { method: "DELETE" });
}

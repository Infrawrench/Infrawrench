import type { CloudFetch } from "./fetch";

/**
 * Weekly infrastructure digest — org-level settings. Server contract:
 * org-scoped `/api/org/:orgId/digest/*` routes (see web `api/routes/digest.ts`).
 *
 * The digest is a Monday-morning summary of last week's spend, sync incidents,
 * and resource churn, delivered to the Slack channels and Teams webhooks that
 * opted into the `weeklyDigest` trigger. This module carries only the org-level
 * on/off switch and bookkeeping; per-channel routing lives with the Slack and
 * Teams settings.
 */

export interface DigestSettings {
  enabled: boolean;
  /** Monday (ISO `YYYY-MM-DD`, UTC) of the last week a digest covered. */
  lastSentWeekStart: string | null;
  /** When the last digest actually went out. */
  lastSentAt: string | null;
}

export interface DigestSendResult {
  ok: boolean;
  /** Deliveries attempted across Slack channels and Teams webhooks. */
  attempted: number;
  succeeded: number;
}

const EMPTY_SETTINGS: DigestSettings = {
  enabled: false,
  lastSentWeekStart: null,
  lastSentAt: null,
};

export async function getDigestSettings(api: CloudFetch, orgId: string): Promise<DigestSettings> {
  return (await api.org<DigestSettings>(orgId, "/digest")) ?? EMPTY_SETTINGS;
}

export async function updateDigestSettings(
  api: CloudFetch,
  orgId: string,
  patch: { enabled: boolean },
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

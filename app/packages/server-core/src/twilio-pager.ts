import { and, eq, gte, isNull, lt, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { db } from "./db/client";
import {
  accountSyncFailures,
  pagingIncidents,
  twilioRecipients,
  twilioSettings,
} from "./db/schema";
import { buildAad, decrypt, encrypt } from "./encryption";
import { sendPushToOrg } from "./push/dispatch";

/**
 * Paging pipeline. Records sync-failure history per (account, type), opens an
 * incident when the org-configured threshold is crossed, and delivers via
 * Twilio SMS + voice (when creds are configured) and mobile push (see
 * push/dispatch.ts). Subsequent failures while the incident is open re-page
 * every `cooldownMinutes` until a successful sync closes it.
 *
 * Wired from the background poller only — manual sync calls from the UI go
 * through `syncAccountResources` directly and do not page, by design.
 */

export interface TwilioCreds {
  accountSid: string;
  authToken: string;
  fromNumber: string;
}

export interface Recipient {
  id: string;
  displayName: string;
  phoneNumber: string;
  sms: boolean;
  voice: boolean;
}

interface ResolvedSettings {
  organizationId: string;
  enabled: boolean;
  creds: TwilioCreds | null;
  failureThreshold: number;
  windowMs: number;
  cooldownMs: number;
}

async function loadSettings(organizationId: string): Promise<ResolvedSettings | null> {
  const [row] = await db
    .select()
    .from(twilioSettings)
    .where(eq(twilioSettings.organizationId, organizationId));
  if (!row) return null;

  let creds: TwilioCreds | null = null;
  if (
    row.encryptedAccountSid &&
    row.accountSidIv &&
    row.encryptedAuthToken &&
    row.authTokenIv &&
    row.fromNumber
  ) {
    try {
      const accountSid = await decrypt(
        row.encryptedAccountSid,
        row.accountSidIv,
        buildAad("twilio", organizationId, "accountSid"),
      );
      const authToken = await decrypt(
        row.encryptedAuthToken,
        row.authTokenIv,
        buildAad("twilio", organizationId, "authToken"),
      );
      creds = { accountSid, authToken, fromNumber: row.fromNumber };
    } catch (err) {
      console.error("[twilio-pager] failed to decrypt creds for org", organizationId, err);
    }
  }

  return {
    organizationId,
    enabled: row.enabled,
    creds,
    failureThreshold: row.failureThreshold,
    windowMs: row.windowMinutes * 60_000,
    cooldownMs: row.cooldownMinutes * 60_000,
  };
}

async function loadRecipients(organizationId: string): Promise<Recipient[]> {
  return db
    .select({
      id: twilioRecipients.id,
      displayName: twilioRecipients.displayName,
      phoneNumber: twilioRecipients.phoneNumber,
      sms: twilioRecipients.sms,
      voice: twilioRecipients.voice,
    })
    .from(twilioRecipients)
    .where(eq(twilioRecipients.organizationId, organizationId));
}

function truncate(s: string, max = 500): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

/** Mask all but the last 4 digits of a phone number for logging. */
function maskPhone(phone: string): string {
  if (phone.length <= 4) return "****";
  return `${"*".repeat(phone.length - 4)}${phone.slice(-4)}`;
}

/** Abort Twilio requests after 10s so a hung connection can't stall paging. */
const TWILIO_REQUEST_TIMEOUT_MS = 10_000;

/** Build the human-readable page text. Twilio SMS allows 1600 chars; we keep it short. */
function formatPageBody(args: {
  accountLabel: string;
  resourceTypeId: string;
  error: string | null;
  count: number;
  windowMinutes: number;
}): string {
  const errorPart = args.error ? ` — ${truncate(args.error, 200)}` : "";
  return `infrawrench: ${args.accountLabel} (${args.resourceTypeId}) failed ${args.count}× in ${args.windowMinutes} min${errorPart}`;
}

function basicAuth(sid: string, token: string): string {
  return `Basic ${Buffer.from(`${sid}:${token}`).toString("base64")}`;
}

interface SendSmsArgs {
  creds: TwilioCreds;
  to: string;
  body: string;
}

async function sendSms({ creds, to, body }: SendSmsArgs): Promise<void> {
  const params = new URLSearchParams();
  params.set("To", to);
  params.set("From", creds.fromNumber);
  params.set("Body", body);

  const res = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(creds.accountSid)}/Messages.json`,
    {
      method: "POST",
      signal: AbortSignal.timeout(TWILIO_REQUEST_TIMEOUT_MS),
      headers: {
        Authorization: basicAuth(creds.accountSid, creds.authToken),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
    },
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Twilio SMS ${res.status}: ${truncate(text, 200)}`);
  }
}

interface SendCallArgs {
  creds: TwilioCreds;
  to: string;
  say: string;
}

async function sendCall({ creds, to, say }: SendCallArgs): Promise<void> {
  // Inline TwiML — Twilio fetches no callback URL when `Twiml` is provided.
  const escaped = say
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
  const twiml = `<Response><Say voice="alice">${escaped}</Say><Pause length="1"/><Say voice="alice">${escaped}</Say></Response>`;

  const params = new URLSearchParams();
  params.set("To", to);
  params.set("From", creds.fromNumber);
  params.set("Twiml", twiml);

  const res = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(creds.accountSid)}/Calls.json`,
    {
      method: "POST",
      signal: AbortSignal.timeout(TWILIO_REQUEST_TIMEOUT_MS),
      headers: {
        Authorization: basicAuth(creds.accountSid, creds.authToken),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
    },
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Twilio Call ${res.status}: ${truncate(text, 200)}`);
  }
}

export interface FanOutResult {
  attempted: number;
  succeeded: number;
  failed: number;
}

/**
 * Send SMS and voice to every recipient that opted into each. Errors per
 * recipient are logged (with the phone number masked) but do not abort the
 * rest; the caller uses `succeeded` to decide whether the page actually
 * landed (e.g. whether to set `pagedAt` on an incident).
 */
async function fanOutPage(
  creds: TwilioCreds,
  recipients: Recipient[],
  body: string,
): Promise<FanOutResult> {
  const jobs: Array<Promise<void>> = [];
  for (const r of recipients) {
    if (r.sms) {
      jobs.push(
        sendSms({ creds, to: r.phoneNumber, body }).catch((err: unknown) => {
          console.error(`[twilio-pager] SMS to ${maskPhone(r.phoneNumber)} failed:`, err);
          throw err;
        }),
      );
    }
    if (r.voice) {
      jobs.push(
        sendCall({ creds, to: r.phoneNumber, say: body }).catch((err: unknown) => {
          console.error(`[twilio-pager] Voice call to ${maskPhone(r.phoneNumber)} failed:`, err);
          throw err;
        }),
      );
    }
  }
  const settled = await Promise.allSettled(jobs);
  const succeeded = settled.filter((s) => s.status === "fulfilled").length;
  return { attempted: jobs.length, succeeded, failed: jobs.length - succeeded };
}

/**
 * One-shot page that skips the poll-failure incident machinery entirely — for
 * callers that already deduped upstream (budget alerts via the
 * budget_alert_events unique index; workflow pages via the workflow_pages
 * cooldown row). It still respects the org's Twilio enabled flag and each
 * recipient's SMS/voice opt-ins.
 *
 * Voice is opt-in per call: a budget crossing is not worth a phone call, but a
 * workflow that asked for `voice: true` is. Never throws — a transport failure
 * must not fail the run that raised the alert.
 */
export async function sendOneShotPage(
  organizationId: string,
  body: string,
  opts: { voice?: boolean } = {},
): Promise<FanOutResult> {
  const none: FanOutResult = { attempted: 0, succeeded: 0, failed: 0 };
  try {
    const settings = await loadSettings(organizationId);
    if (!settings || !settings.enabled || !settings.creds) return none;
    const recipients = (await loadRecipients(organizationId))
      .map((r) => ({ ...r, voice: r.voice && opts.voice === true }))
      .filter((r) => r.sms || r.voice);
    if (recipients.length === 0) return none;
    return await fanOutPage(settings.creds, recipients, truncate(body, 320));
  } catch (err) {
    console.error("[twilio-pager] one-shot page failed:", err);
    return none;
  }
}

/**
 * SMS-only one-shot page for budget alerts. Voice is intentionally not used for
 * budgets. Returns true when at least one SMS was delivered to Twilio.
 */
export async function sendBudgetAlertPage(organizationId: string, body: string): Promise<boolean> {
  const result = await sendOneShotPage(organizationId, body);
  return result.succeeded > 0;
}

export interface NotePollOutcomeArgs {
  organizationId: string;
  accountId: string;
  /** Human-readable label for the account, included in the page text. */
  accountLabel: string;
  resourceTypeId: string;
  outcome: "ok" | "error" | "skipped";
  error?: Error;
}

/**
 * Called once per (account, type) from the background poller. Maintains the
 * failure-window state and triggers Twilio when the threshold is crossed.
 *
 * - `outcome === "ok"` closes any open incident for this (account, type) and
 *   prunes its failure rows.
 * - `outcome === "skipped"` is a no-op (rate-limit gate skipped the call).
 * - `outcome === "error"` inserts a failure row, prunes expired rows, and
 *   pages if either (a) no open incident and the threshold is crossed, or
 *   (b) an open incident's `pagedAt` is older than `cooldownMinutes`.
 *
 * Errors loading settings / talking to Twilio are caught and logged — paging
 * must never break the poller.
 */
export async function notePollOutcome(args: NotePollOutcomeArgs): Promise<void> {
  if (args.outcome === "skipped") return;

  try {
    const settings = await loadSettings(args.organizationId);
    // Twilio creds are optional: an org can run push-only incident delivery.
    if (!settings || !settings.enabled) {
      // Even when disabled, we still close incidents on success so toggling
      // back on later doesn't immediately re-page on stale state.
      if (args.outcome === "ok") {
        await closeOpenIncident(args.organizationId, args.accountId, args.resourceTypeId);
      }
      return;
    }

    if (args.outcome === "ok") {
      await closeOpenIncident(args.organizationId, args.accountId, args.resourceTypeId);
      await db
        .delete(accountSyncFailures)
        .where(
          and(
            eq(accountSyncFailures.organizationId, args.organizationId),
            eq(accountSyncFailures.accountId, args.accountId),
            eq(accountSyncFailures.resourceTypeId, args.resourceTypeId),
          ),
        );
      return;
    }

    // outcome === "error"
    const errorText = args.error ? truncate(args.error.message ?? String(args.error), 500) : null;
    await db.insert(accountSyncFailures).values({
      id: randomUUID(),
      organizationId: args.organizationId,
      accountId: args.accountId,
      resourceTypeId: args.resourceTypeId,
      error: errorText,
    });

    const cutoff = new Date(Date.now() - settings.windowMs);
    await db
      .delete(accountSyncFailures)
      .where(
        and(
          eq(accountSyncFailures.organizationId, args.organizationId),
          eq(accountSyncFailures.accountId, args.accountId),
          eq(accountSyncFailures.resourceTypeId, args.resourceTypeId),
          lt(accountSyncFailures.failedAt, cutoff),
        ),
      );

    const [{ count } = { count: 0 }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(accountSyncFailures)
      .where(
        and(
          eq(accountSyncFailures.organizationId, args.organizationId),
          eq(accountSyncFailures.accountId, args.accountId),
          eq(accountSyncFailures.resourceTypeId, args.resourceTypeId),
          gte(accountSyncFailures.failedAt, cutoff),
        ),
      );

    if (count < settings.failureThreshold) return;

    const [existing] = await db
      .select()
      .from(pagingIncidents)
      .where(
        and(
          eq(pagingIncidents.accountId, args.accountId),
          eq(pagingIncidents.resourceTypeId, args.resourceTypeId),
          isNull(pagingIncidents.closedAt),
        ),
      );

    const now = new Date();
    let incidentId: string;
    let shouldPage: boolean;

    if (!existing) {
      incidentId = randomUUID();
      await db.insert(pagingIncidents).values({
        id: incidentId,
        organizationId: args.organizationId,
        accountId: args.accountId,
        resourceTypeId: args.resourceTypeId,
        openedAt: now,
        error: errorText,
      });
      shouldPage = true;
    } else {
      incidentId = existing.id;
      shouldPage =
        !existing.pagedAt || now.getTime() - existing.pagedAt.getTime() >= settings.cooldownMs;
    }

    if (!shouldPage) return;

    const body = formatPageBody({
      accountLabel: args.accountLabel,
      resourceTypeId: args.resourceTypeId,
      error: errorText,
      count,
      windowMinutes: Math.round(settings.windowMs / 60_000),
    });

    let twilioResult: FanOutResult = { attempted: 0, succeeded: 0, failed: 0 };
    if (settings.creds) {
      const recipients = await loadRecipients(args.organizationId);
      if (recipients.length > 0) {
        twilioResult = await fanOutPage(settings.creds, recipients, body);
      }
    }

    const pushResult = await sendPushToOrg(args.organizationId, "syncIncidents", {
      title: `Sync failure: ${args.accountLabel}`,
      body,
      data: {
        type: "sync_incident",
        orgId: args.organizationId,
        accountId: args.accountId,
        resourceTypeId: args.resourceTypeId,
        incidentId,
      },
    });

    // Only mark the incident as paged if at least one transport succeeded —
    // otherwise the cooldown gate would suppress retries even though the
    // recipients never actually heard from us. A push success gates Twilio
    // re-sends too (one cooldown cadence per incident), and vice versa.
    if (twilioResult.succeeded + pushResult.succeeded > 0) {
      await db
        .update(pagingIncidents)
        .set({ pagedAt: now })
        .where(eq(pagingIncidents.id, incidentId));
    } else {
      console.error(
        `[twilio-pager] all ${twilioResult.attempted + pushResult.attempted} deliveries failed for incident ${incidentId}; will retry on next poll`,
      );
    }
  } catch (err) {
    console.error("[twilio-pager] notePollOutcome failed:", err);
  }
}

async function closeOpenIncident(
  organizationId: string,
  accountId: string,
  resourceTypeId: string,
): Promise<void> {
  await db
    .update(pagingIncidents)
    .set({ closedAt: new Date() })
    .where(
      and(
        eq(pagingIncidents.organizationId, organizationId),
        eq(pagingIncidents.accountId, accountId),
        eq(pagingIncidents.resourceTypeId, resourceTypeId),
        isNull(pagingIncidents.closedAt),
      ),
    );
}

/**
 * Send a one-off test page to all configured recipients. Used by the
 * "Send test page" button in settings to verify Twilio creds + numbers.
 */
export async function sendTestPage(organizationId: string): Promise<{
  recipientCount: number;
  attempted: number;
  succeeded: number;
}> {
  const settings = await loadSettings(organizationId);
  if (!settings) throw new Error("Twilio paging is not configured");
  if (!settings.creds) throw new Error("Twilio credentials are missing or unreadable");

  const recipients = await loadRecipients(organizationId);
  if (recipients.length === 0) throw new Error("No recipients configured");

  const body = "infrawrench: test page. Your Twilio paging configuration is working.";
  const result = await fanOutPage(settings.creds, recipients, body);
  if (result.succeeded === 0) {
    throw new Error(`Test page failed: 0/${result.attempted} deliveries succeeded`);
  }
  return {
    recipientCount: recipients.length,
    attempted: result.attempted,
    succeeded: result.succeeded,
  };
}

/**
 * Encrypt a Twilio credential value bound to its org. Used by the settings
 * API route when writing Account SID or Auth Token.
 */
export async function encryptTwilioCredential(
  organizationId: string,
  field: "accountSid" | "authToken",
  plaintext: string,
): Promise<{ ciphertext: string; iv: string }> {
  return encrypt(plaintext, buildAad("twilio", organizationId, field));
}

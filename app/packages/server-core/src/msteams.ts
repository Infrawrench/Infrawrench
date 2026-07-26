/**
 * Microsoft Teams as an alert transport.
 *
 * An org adds one or more Teams *webhook URLs*; we POST an Adaptive Card to
 * each one whose trigger opt-ins match. The three triggers a webhook can opt
 * into are the same three mobile push and Slack have — sync incidents, budget
 * alerts, and workflow pages — so a channel can take budget crossings without
 * also taking every sync failure.
 *
 * Why webhooks and not an "Add to Teams" OAuth flow like Slack
 * -----------------------------------------------------------
 * Microsoft does not offer Slack's shape. Posting a channel message through
 * Graph (`POST /teams/{id}/channels/{id}/messages`) needs the *delegated*
 * `ChannelMessage.Send` scope — a signed-in user at send time. The only
 * application permission Graph accepts for that route is `Teamwork.Migrate.All`,
 * which Microsoft restricts to data migration. Every sender here is a daemon
 * (the poller, the budget evaluator, a workflow calling `infra.page`) with no
 * user in the loop, so the delegated flow is unavailable to us and the
 * app-only flow is not permitted for this purpose.
 *
 * The supported app-only path is a webhook: the user adds a "Post to a channel
 * when a webhook request is received" workflow to the channel and pastes the
 * generated URL here. This also replaces the old Office 365 connector
 * ("Incoming Webhook") URLs, which Microsoft disables in May 2026 — those
 * `*.webhook.office.com` URLs still work today and are accepted, but the
 * settings UI steers new setups to Workflows.
 *
 * Config (env): none. Unlike Slack, which no-ops without `SLACK_CLIENT_ID`,
 * there is no app to register and nothing for an operator to set up — Teams
 * alerts work on every deployment, self-hosted included, the moment an org
 * pastes a URL.
 *
 * The URL is the credential
 * -------------------------
 * A Teams webhook URL carries its own authorization in the query string (`sig=`
 * on the Logic Apps hosts, a signed path on the Power Platform ones). Anyone
 * holding it can post to the channel, so it is treated as a secret: encrypted
 * at rest with AAD `msteams:<orgId>:webhookUrl`, never returned by the API, and
 * shown in the UI only as a host + last-four hint. Because the server makes an
 * outbound request to a user-supplied URL, the host is checked against
 * {@link ALLOWED_HOST_SUFFIXES} — without that this endpoint would be an
 * org-member-triggerable SSRF into the cluster's network.
 */
import { and, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

import { db } from "./db/client";
import { msteamsWebhooks } from "./db/schema";
import { buildAad, decrypt, encrypt, keyedHash } from "./encryption";
import type { PushTrigger } from "./push/dispatch";

/** Abort Teams requests after 10s so a hung connection can't stall paging. */
const MSTEAMS_REQUEST_TIMEOUT_MS = 10_000;

/** Domain separator for the dedupe digest. See {@link webhookDigest}. */
const DIGEST_DOMAIN = "msteams-webhook";

/**
 * Hosts a Teams webhook URL is allowed to point at. All are Microsoft-operated:
 *
 *   *.logic.azure.com        — Power Automate flows created before the 2025
 *                              move; still issued in some tenants.
 *   *.api.powerautomate.com  — current Workflows trigger URLs.
 *   *.api.powerplatform.com  — current Workflows trigger URLs (environment-
 *                              scoped form).
 *   *.flow.microsoft.com     — Power Automate.
 *   *.webhook.office.com     — legacy Office 365 connector "Incoming Webhook".
 *                              Microsoft disables these in May 2026; accepted
 *                              until then so existing setups keep working.
 *
 * This list is a security control, not a convenience: it is the only thing
 * standing between "paste a URL" and an outbound request to an arbitrary
 * address from inside the cluster.
 */
const ALLOWED_HOST_SUFFIXES = [
  ".logic.azure.com",
  ".api.powerautomate.com",
  ".api.powerplatform.com",
  ".flow.microsoft.com",
  ".webhook.office.com",
] as const;

export interface ParsedWebhookUrl {
  /** The normalized URL, as it will be stored (encrypted). */
  url: string;
  /** Hostname, kept in the clear for display and diagnostics. */
  host: string;
  /** Non-secret display hint, e.g. `contoso.webhook.office.com · …a7f2`. */
  hint: string;
}

/**
 * Validate a pasted webhook URL and derive its display hint. Throws with a
 * message meant for the user — this runs on the settings form, so the wording
 * is what they'll see.
 */
export function parseWebhookUrl(raw: string): ParsedWebhookUrl {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error("Webhook URL is required");

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("That doesn't look like a URL");
  }

  if (parsed.protocol !== "https:") {
    throw new Error("Webhook URL must use https");
  }

  const host = parsed.hostname.toLowerCase();
  const allowed = ALLOWED_HOST_SUFFIXES.some(
    (suffix) => host === suffix.slice(1) || host.endsWith(suffix),
  );
  if (!allowed) {
    throw new Error(
      `${host} is not a Microsoft Teams webhook host. Copy the URL from a Teams channel's Workflows automation — it ends in ${ALLOWED_HOST_SUFFIXES.slice(0, 3).join(", ")} or similar.`,
    );
  }

  const tail = trimmed.slice(-4);
  return { url: trimmed, host, hint: `${host} · …${tail}` };
}

/**
 * Keyed digest of the URL, so re-pasting the same webhook updates the existing
 * row rather than doubling up delivery. Keyed (not a plain hash) so a DB-only
 * leak doesn't let an attacker confirm a guessed URL offline.
 */
async function webhookDigest(url: string): Promise<string> {
  return keyedHash(url, DIGEST_DOMAIN);
}

// --- Storage ---

export interface MsTeamsWebhookRecord {
  id: string;
  label: string;
  urlHint: string;
  syncIncidents: boolean;
  budgetAlerts: boolean;
  workflowPages: boolean;
}

export interface AddMsTeamsWebhookArgs {
  label: string;
  url: string;
  syncIncidents?: boolean;
  budgetAlerts?: boolean;
  workflowPages?: boolean;
}

/**
 * Add a webhook, or update the one already holding this URL. Returns the row
 * without the URL — callers hand this straight to the client.
 */
export async function addMsTeamsWebhook(
  organizationId: string,
  userId: string | null,
  args: AddMsTeamsWebhookArgs,
): Promise<MsTeamsWebhookRecord> {
  const label = args.label.trim();
  if (!label) throw new Error("Label is required");

  const { url, host, hint } = parseWebhookUrl(args.url);
  const enc = await encrypt(url, buildAad("msteams", organizationId, "webhookUrl"));
  const digest = await webhookDigest(url);

  const syncIncidents = args.syncIncidents ?? true;
  const budgetAlerts = args.budgetAlerts ?? true;
  const workflowPages = args.workflowPages ?? true;
  const now = new Date();

  const [row] = await db
    .insert(msteamsWebhooks)
    .values({
      id: randomUUID(),
      organizationId,
      label,
      encryptedUrl: enc.ciphertext,
      urlIv: enc.iv,
      urlDigest: digest,
      urlHost: host,
      urlHint: hint,
      syncIncidents,
      budgetAlerts,
      workflowPages,
      createdByUserId: userId,
    })
    .onConflictDoUpdate({
      target: [msteamsWebhooks.organizationId, msteamsWebhooks.urlDigest],
      set: {
        label,
        // Re-encrypt: the URL is unchanged, but a fresh IV costs nothing and
        // keeps the row's ciphertext from being a stable fingerprint.
        encryptedUrl: enc.ciphertext,
        urlIv: enc.iv,
        urlHost: host,
        urlHint: hint,
        syncIncidents,
        budgetAlerts,
        workflowPages,
        updatedAt: now,
      },
    })
    .returning();

  if (!row) throw new Error("Failed to save Teams webhook");
  return toRecord(row);
}

function toRecord(row: typeof msteamsWebhooks.$inferSelect): MsTeamsWebhookRecord {
  return {
    id: row.id,
    label: row.label,
    urlHint: row.urlHint,
    syncIncidents: row.syncIncidents,
    budgetAlerts: row.budgetAlerts,
    workflowPages: row.workflowPages,
  };
}

/** Every webhook the org has added, for the settings list. URLs stay encrypted. */
export async function listMsTeamsWebhooks(organizationId: string): Promise<MsTeamsWebhookRecord[]> {
  const rows = await db
    .select()
    .from(msteamsWebhooks)
    .where(eq(msteamsWebhooks.organizationId, organizationId))
    .orderBy(msteamsWebhooks.label);
  return rows.map(toRecord);
}

interface LiveWebhook {
  id: string;
  label: string;
  url: string;
}

/** Decrypt a set of rows, skipping (and logging) any that fail to open. */
async function decryptRows(
  organizationId: string,
  rows: Array<typeof msteamsWebhooks.$inferSelect>,
): Promise<LiveWebhook[]> {
  const aad = buildAad("msteams", organizationId, "webhookUrl");
  const live: LiveWebhook[] = [];
  for (const row of rows) {
    try {
      const url = await decrypt(row.encryptedUrl, row.urlIv, aad);
      live.push({ id: row.id, label: row.label, url });
    } catch (err) {
      console.error("[msteams] failed to decrypt webhook URL for org", organizationId, err);
    }
  }
  return live;
}

// --- Delivery ---

export interface MsTeamsFanOutResult {
  attempted: number;
  succeeded: number;
  failed: number;
}

const NO_DELIVERY: MsTeamsFanOutResult = { attempted: 0, succeeded: 0, failed: 0 };

export interface MsTeamsAlert {
  /** Headline, rendered as the card's bold first line. */
  title: string;
  /** The alert text. */
  body: string;
  /** Optional deep link back into the app ("View in Infrawrench"). */
  url?: string;
  /** Small trailing context line, e.g. the workflow or account name. */
  context?: string;
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

/**
 * Escape the characters an Adaptive Card `TextBlock` treats as markdown. Alert
 * bodies carry provider error text, so a stray `[` must not silently swallow
 * the rest of the line as a malformed link. HTML needs no handling — Teams
 * ignores it in cards and renders it as literal text.
 */
function escapeMarkdown(s: string): string {
  return s.replace(/([\\*_[\]])/g, "\\$1");
}

/**
 * Adaptive Card payload for one alert, wrapped in the `type: message` envelope
 * the Workflows webhook trigger expects. Card schema 1.4 — Teams supports up to
 * 1.5, and 1.4 is what the Workflows templates emit.
 */
function alertCard(alert: MsTeamsAlert): Record<string, unknown> {
  const body: unknown[] = [
    {
      type: "TextBlock",
      text: escapeMarkdown(truncate(alert.title, 150)),
      weight: "Bolder",
      size: "Medium",
      wrap: true,
    },
    { type: "TextBlock", text: escapeMarkdown(truncate(alert.body, 2800)), wrap: true },
  ];
  if (alert.context) {
    body.push({
      type: "TextBlock",
      text: escapeMarkdown(truncate(alert.context, 150)),
      wrap: true,
      isSubtle: true,
      spacing: "Small",
    });
  }

  const card: Record<string, unknown> = {
    $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
    type: "AdaptiveCard",
    version: "1.4",
    body,
  };
  if (alert.url) {
    card["actions"] = [{ type: "Action.OpenUrl", title: "View in Infrawrench", url: alert.url }];
  }

  return {
    type: "message",
    attachments: [
      {
        contentType: "application/vnd.microsoft.card.adaptive",
        contentUrl: null,
        content: card,
      },
    ],
  };
}

/** `Retry-After` in ms, clamped so a hostile value can't park the poller. */
function retryAfterMs(header: string | null): number {
  const seconds = Number.parseInt(header ?? "", 10);
  if (!Number.isFinite(seconds) || seconds <= 0) return 1_000;
  return Math.min(seconds * 1_000, 5_000);
}

/**
 * POST a card to one webhook. Microsoft throttles a webhook above 4 requests
 * per second, so a 429 gets one honoured retry before it counts as a failure.
 * Errors are prefixed with the webhook's label — a multi-channel failure has to
 * be diagnosable from the log line alone.
 */
async function postToWebhook(url: string, payload: unknown, label: string): Promise<void> {
  const encoded = JSON.stringify(payload);
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch(url, {
      method: "POST",
      signal: AbortSignal.timeout(MSTEAMS_REQUEST_TIMEOUT_MS),
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: encoded,
    });
    if (res.status === 429 && attempt === 0) {
      await new Promise((resolve) =>
        setTimeout(resolve, retryAfterMs(res.headers.get("retry-after"))),
      );
      continue;
    }
    if (!res.ok) {
      // Power Automate returns a JSON error body; the first 200 chars of it are
      // far more useful to the user than a bare status code.
      const detail = (await res.text().catch(() => "")).slice(0, 200).trim();
      throw new Error(`${label}: HTTP ${res.status}${detail ? ` — ${detail}` : ""}`);
    }
    return;
  }
  throw new Error(`${label}: rate limited by Microsoft (HTTP 429)`);
}

const TRIGGER_COLUMN = {
  syncIncidents: msteamsWebhooks.syncIncidents,
  budgetAlerts: msteamsWebhooks.budgetAlerts,
  workflowPages: msteamsWebhooks.workflowPages,
} as const;

/**
 * Post one alert to every webhook opted into `trigger`. Never throws — a Teams
 * or Power Automate outage must not fail the poller, the budget evaluator, or
 * the workflow that raised the alert. Per-webhook errors are logged and counted
 * as failures so the caller can still tell whether anything landed.
 */
export async function sendMsTeamsToOrg(
  organizationId: string,
  trigger: PushTrigger,
  alert: MsTeamsAlert,
): Promise<MsTeamsFanOutResult> {
  try {
    const rows = await db
      .select()
      .from(msteamsWebhooks)
      .where(
        and(eq(msteamsWebhooks.organizationId, organizationId), eq(TRIGGER_COLUMN[trigger], true)),
      );
    if (rows.length === 0) return NO_DELIVERY;

    const targets = await decryptRows(organizationId, rows);
    if (targets.length === 0) return NO_DELIVERY;

    const payload = alertCard(alert);
    const settled = await Promise.allSettled(
      targets.map((t) => postToWebhook(t.url, payload, t.label)),
    );

    const succeeded = settled.filter((s) => s.status === "fulfilled").length;
    for (const s of settled) {
      if (s.status === "rejected") console.error("[msteams] post failed:", s.reason);
    }
    return { attempted: targets.length, succeeded, failed: targets.length - succeeded };
  } catch (err) {
    console.error("[msteams] fan-out failed:", err);
    return NO_DELIVERY;
  }
}

/**
 * Send a one-off test card to every webhook the org has added, regardless of
 * trigger opt-ins. Throws (unlike {@link sendMsTeamsToOrg}) so the settings UI
 * can show the actual failure — a deleted or turned-off Workflow answers 404,
 * and the user needs to see that rather than a silent success.
 */
export async function sendMsTeamsTest(organizationId: string): Promise<{
  webhookCount: number;
  attempted: number;
  succeeded: number;
}> {
  const rows = await db
    .select()
    .from(msteamsWebhooks)
    .where(eq(msteamsWebhooks.organizationId, organizationId));
  if (rows.length === 0) throw new Error("No Teams channels configured");

  const targets = await decryptRows(organizationId, rows);
  if (targets.length === 0) throw new Error("Stored webhook URLs could not be read");

  const payload = alertCard({
    title: "Test alert",
    body: "Your Infrawrench Teams connection is working. Real alerts will arrive here.",
  });

  const settled = await Promise.allSettled(
    targets.map((t) => postToWebhook(t.url, payload, t.label)),
  );
  const succeeded = settled.filter((s) => s.status === "fulfilled").length;
  if (succeeded === 0) {
    const first = settled.find((s) => s.status === "rejected");
    const reason =
      first && first.status === "rejected"
        ? first.reason instanceof Error
          ? first.reason.message
          : String(first.reason)
        : "unknown error";
    throw new Error(`Test message failed: ${reason}`);
  }
  return { webhookCount: targets.length, attempted: targets.length, succeeded };
}

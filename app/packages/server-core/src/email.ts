/**
 * Transactional email as an outbound transport.
 *
 * There was no mail stack in this codebase before this module. The only email
 * the product sent was WorkOS's — verification and invitation mail that WorkOS
 * composes and delivers itself as part of user management; it exposes no
 * general "send this message" API to piggyback on. So rather than bend an auth
 * provider into a mail provider, this is a new transport shaped exactly like
 * the Slack one: a couple of env vars, a plain `fetch` to a documented HTTP
 * endpoint, and a no-op with a clear log line when it isn't configured.
 *
 * Provider: Resend (`POST https://api.resend.com/emails`). Chosen for the same
 * reason the CLI hand-rolls its ANSI output — it needs no dependency at all.
 * The whole API is one JSON POST with a bearer token, so the SDK would be a
 * package to audit and upgrade in exchange for nothing.
 *
 * Config (env):
 *   RESEND_API_KEY — the API key (`re_…`) from resend.com → API Keys
 *   EMAIL_FROM     — the verified sender, e.g. `Infrawrench <digest@yourdomain>`
 *
 * Without *both*, `isEmailConfigured()` is false and every send here is a
 * logged no-op. That is the same shape as Slack: a self-hosted deployment that
 * never sets up a mail provider simply doesn't get email delivery, rather than
 * erroring or — worse — failing silently.
 */

const RESEND_API = "https://api.resend.com/emails";

/** Abort mail requests after 10s so a hung connection can't stall the poller. */
const EMAIL_REQUEST_TIMEOUT_MS = 10_000;

/** Whether this deployment can send mail (key + from address both present). */
export function isEmailConfigured(): boolean {
  return Boolean(process.env["RESEND_API_KEY"] && process.env["EMAIL_FROM"]);
}

export interface EmailMessage {
  to: string;
  subject: string;
  /** Plain-text part. Always sent — some readers never render the HTML. */
  text: string;
  /** HTML part. Optional; omitted messages are text-only. */
  html?: string;
  /**
   * Optional idempotency key (max 256 chars). Resend drops a duplicate send
   * carrying a key it has seen in the last 24 hours, which is what makes the
   * digest's bounded retries safe: a retry after a partial provider failure
   * cannot double-deliver to an address that already received the message.
   */
  idempotencyKey?: string;
}

export interface EmailFanOutResult {
  attempted: number;
  succeeded: number;
  failed: number;
}

const NO_DELIVERY: EmailFanOutResult = { attempted: 0, succeeded: 0, failed: 0 };

/** Send one message. Throws on failure — callers decide whether that matters. */
async function sendOne(message: EmailMessage): Promise<void> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${process.env["RESEND_API_KEY"] ?? ""}`,
    "Content-Type": "application/json",
  };
  if (message.idempotencyKey) {
    headers["Idempotency-Key"] = message.idempotencyKey.slice(0, 256);
  }

  const res = await fetch(RESEND_API, {
    method: "POST",
    signal: AbortSignal.timeout(EMAIL_REQUEST_TIMEOUT_MS),
    headers,
    body: JSON.stringify({
      from: process.env["EMAIL_FROM"],
      to: [message.to],
      subject: message.subject,
      text: message.text,
      ...(message.html ? { html: message.html } : {}),
    }),
  });
  if (!res.ok) {
    // Resend returns a JSON error body; the first 200 chars of it say far more
    // than the status code (`validation_error` naming the offending field is
    // the common one).
    const detail = (await res.text().catch(() => "")).slice(0, 200).trim();
    throw new Error(`email to ${message.to}: HTTP ${res.status}${detail ? ` — ${detail}` : ""}`);
  }
}

/**
 * Send the same message to every address. Never throws — a mail outage must
 * not fail the poller. Per-address errors are logged and counted so the caller
 * can still tell whether anything landed.
 *
 * Each address gets its own request rather than one message with many
 * recipients: a shared `to:` would leak every recipient's address to all the
 * others, and one hard bounce would take the whole send with it.
 */
export async function sendEmails(
  messages: EmailMessage[],
  context: string,
): Promise<EmailFanOutResult> {
  if (messages.length === 0) return NO_DELIVERY;
  if (!isEmailConfigured()) {
    console.warn(
      `[email] ${context}: skipping ${messages.length} message(s) — RESEND_API_KEY and EMAIL_FROM are not both set on this deployment.`,
    );
    return NO_DELIVERY;
  }

  const settled = await Promise.allSettled(messages.map((m) => sendOne(m)));
  const succeeded = settled.filter((s) => s.status === "fulfilled").length;
  for (const s of settled) {
    if (s.status === "rejected") console.error(`[email] ${context} send failed:`, s.reason);
  }
  return { attempted: messages.length, succeeded, failed: messages.length - succeeded };
}

/**
 * Normalize and validate an address typed into a settings form. Throws with a
 * message meant for the user. Deliberately permissive — the only reliable
 * validator is delivery, and a regex that rejects a valid address is worse
 * than one that accepts a typo.
 */
export function normalizeEmailAddress(raw: string): string {
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) throw new Error("Email address is required");
  if (trimmed.length > 320) throw new Error("That email address is too long");
  if (!/^[^\s@,;]+@[^\s@,;.]+(\.[^\s@,;.]+)+$/.test(trimmed)) {
    throw new Error("That doesn't look like an email address");
  }
  return trimmed;
}

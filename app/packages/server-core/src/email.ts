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
 * Provider: Mailgun (`POST {base}/v3/{domain}/messages`). Google Cloud has no
 * first-party transactional mail service — its own "sending email from an
 * instance" guide points at SendGrid, Mailgun or Mailjet, and blocks outbound
 * port 25 — so on GKE the choice is which of those to carry, not whether to
 * carry one. Mailgun is one of the three Google documents.
 *
 * No SDK, for the same reason the CLI hand-rolls its ANSI output: the whole
 * API is one form POST with basic auth, so a package would be something to
 * audit and upgrade in exchange for nothing. The body is `multipart/form-data`
 * via the runtime's own `FormData`, which is what Mailgun documents.
 *
 * Config (env):
 *   MAILGUN_API_KEY  — a domain sending key (preferred) or the account key
 *   MAILGUN_DOMAIN   — the verified sending domain, e.g. `mg.yourdomain.com`
 *   EMAIL_FROM       — the sender, e.g. `Infrawrench <digest@mg.yourdomain.com>`
 *   MAILGUN_API_BASE — optional; `https://api.eu.mailgun.net` for an EU account
 *
 * Without the first three, `isEmailConfigured()` is false and every send here
 * is a logged no-op. That is the same shape as Slack: a self-hosted deployment
 * that never sets up a mail provider simply doesn't get email delivery, rather
 * than erroring or — worse — failing silently.
 *
 * **Mailgun has no idempotency keys** (an open feature request for years), so
 * unlike some providers it cannot collapse a duplicate send for us. That costs
 * nothing here because the digest never retries a send that partly landed:
 * `classifyDelivery` only marks an attempt retryable when *zero* destinations
 * succeeded, address-level fan-out included. Dedup was belt-and-braces on top
 * of that rule, not the thing making it safe. `traceKey` below is therefore
 * exactly what its name says — a breadcrumb, not a guarantee.
 */

/** US region by default; EU accounts live on a different host entirely. */
const DEFAULT_API_BASE = "https://api.mailgun.net";

/** Abort mail requests after 10s so a hung connection can't stall the poller. */
const EMAIL_REQUEST_TIMEOUT_MS = 10_000;

/** Whether this deployment can send mail (key, domain and sender all present). */
export function isEmailConfigured(): boolean {
  return Boolean(
    process.env["MAILGUN_API_KEY"] && process.env["MAILGUN_DOMAIN"] && process.env["EMAIL_FROM"],
  );
}

/** The messages endpoint for the configured domain and region. */
function messagesUrl(): string {
  const base = (process.env["MAILGUN_API_BASE"] || DEFAULT_API_BASE).replace(/\/$/, "");
  return `${base}/v3/${encodeURIComponent(process.env["MAILGUN_DOMAIN"] ?? "")}/messages`;
}

/**
 * A file to hang off a message.
 *
 * Mailgun takes attachments as extra `attachment` parts of the same multipart
 * form the message already is, so this costs no second request, no object
 * store and no expiring link — which is why the invoice CSV is attached rather
 * than linked. A link would need a public URL for a document that names a
 * customer's spend, and a bill nobody can open six months later is not a bill.
 */
export interface EmailAttachment {
  filename: string;
  /** The bytes, as text or binary. Text is encoded UTF-8. */
  content: string | Uint8Array;
  /** MIME type, e.g. `text/csv`. */
  contentType: string;
}

export interface EmailMessage {
  to: string;
  subject: string;
  /** Plain-text part. Always sent — some readers never render the HTML. */
  text: string;
  /** HTML part. Optional; omitted messages are text-only. */
  html?: string;
  /** Files to attach. Sent inline in the same multipart request. */
  attachments?: EmailAttachment[];
  /**
   * Optional correlation breadcrumb, sent as the Mailgun custom variable
   * `v:infrawrench-key` so it comes back on the message's log entries and
   * webhooks — enough to answer "did this org's digest for that week actually
   * leave the building?" from Mailgun's side.
   *
   * Deliberately *not* called an idempotency key: Mailgun has no such feature,
   * and this value buys no dedup. See the module header for why the digest is
   * safe without one.
   */
  traceKey?: string;
}

export interface EmailFanOutResult {
  attempted: number;
  succeeded: number;
  failed: number;
}

const NO_DELIVERY: EmailFanOutResult = { attempted: 0, succeeded: 0, failed: 0 };

/** Send one message. Throws on failure — callers decide whether that matters. */
async function sendOne(message: EmailMessage): Promise<void> {
  const form = new FormData();
  form.set("from", process.env["EMAIL_FROM"] ?? "");
  form.set("to", message.to);
  form.set("subject", message.subject);
  form.set("text", message.text);
  if (message.html) form.set("html", message.html);
  // `append`, not `set`: several files share the one `attachment` field name,
  // which is how Mailgun's multipart API takes more than one.
  for (const file of message.attachments ?? []) {
    // Copied into a plain `Uint8Array` rather than passed through: a view over
    // a `SharedArrayBuffer` is not a `BlobPart`, and the copy costs nothing at
    // the size of a document anyone emails.
    const part = typeof file.content === "string" ? file.content : new Uint8Array(file.content);
    form.append(
      "attachment",
      new Blob([part], { type: file.contentType }),
      // The third argument is the part's filename, which is the name the
      // recipient's mail client shows — without it Mailgun invents `blob`.
      file.filename,
    );
  }
  // `v:` prefixed fields are Mailgun custom variables: echoed back on log
  // entries and webhooks, invisible in the delivered message.
  if (message.traceKey) form.set("v:infrawrench-key", message.traceKey.slice(0, 256));

  const res = await fetch(messagesUrl(), {
    method: "POST",
    signal: AbortSignal.timeout(EMAIL_REQUEST_TIMEOUT_MS),
    // Basic auth with the literal username `api`. No Content-Type header —
    // `fetch` derives it from the FormData, including the multipart boundary,
    // and setting it by hand would strip that and break the parse.
    headers: {
      Authorization: `Basic ${Buffer.from(`api:${process.env["MAILGUN_API_KEY"] ?? ""}`).toString("base64")}`,
    },
    body: form,
  });
  if (!res.ok) {
    // Mailgun returns a JSON body whose `message` field is far more useful than
    // the status — an unverified sender domain and a malformed address both
    // surface as 400, and only the body distinguishes them.
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
      `[email] ${context}: skipping ${messages.length} message(s) — MAILGUN_API_KEY, MAILGUN_DOMAIN and EMAIL_FROM are not all set on this deployment.`,
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

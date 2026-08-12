/**
 * Slack mrkdwn escaping, in a **database-free leaf module**.
 *
 * Split out of `slack.ts` for the reason `probes/metric-ids.ts` was split out
 * of `probes/pass.ts`: `slack.ts` imports `db/client`, so importing an escaper
 * from it drags the whole transport stack — and a `DATABASE_URL` requirement —
 * into every module that merely renders a message. The alert `summary.ts`
 * modules are deliberately I/O-free so their bodies can be unit-tested without
 * a database, and that property is the one this file exists to preserve.
 *
 * `slack.ts` re-exports {@link escapeMrkdwn} so its existing importers are
 * unaffected and there stays exactly one definition of each escaper.
 */

/**
 * Escape the three characters Slack treats as markup delimiters. Alert bodies
 * carry provider error text, so a stray `<` must not silently eat the rest of
 * the message as a malformed link. Applied to the whole composed body by the
 * transport.
 *
 * It deliberately does **not** touch `*`, `_`, `~` or backticks: the alert
 * bodies are built out of `*bold*` themselves, and escaping those globally
 * would flatten the formatting every message depends on. Untrusted *fragments*
 * are handled by {@link escapeMrkdwnFragment} instead.
 */
export function escapeMrkdwn(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Neutralise one fragment of *untrusted* text — a resource, principal or
 * account name synced out of a customer's cloud — before it is composed into a
 * Slack mrkdwn body.
 *
 * Because {@link escapeMrkdwn} has to leave `*` alone, a synced name
 * containing `*`, `_`, `~` or a backtick can change how a security alert
 * reads: a resource called `~assets~` renders struck through, which is what
 * "already dealt with" looks like.
 *
 * Slack has no backslash escape, so the only construct that shows these
 * characters without interpreting them is a code span, which suppresses every
 * inline format inside it. Applied unconditionally rather than only to names
 * that contain a delimiter: a name that is sometimes monospaced and sometimes
 * not is a second thing for a reader to reason about, and an identifier in an
 * alert reads well in code style anyway.
 *
 * A backtick inside the fragment would close the span early, so it becomes a
 * prime (`′`). That is the one character this cannot reproduce exactly, it
 * appears in no provider's identifier syntax, and both the screen and the CSV
 * export carry the name byte-for-byte.
 */
export function escapeMrkdwnFragment(s: string): string {
  return `\`${s.replace(/`/g, "′")}\``;
}

/**
 * Rendering an `AlertEvent` as an email: pure, so the subject, the plain-text
 * part and the HTML part are unit-tested without a database or a mail
 * provider (`__tests__/alert-email-render.test.ts`), the same split
 * `digest/compose.ts` has from `digest/weekly.ts`.
 *
 * Alert bodies are written for Slack: `*bold*` spans, `` `code` `` spans for
 * untrusted identifiers, and the occasional `<url|label>` link. Passing that
 * through verbatim would print literal asterisks in a mail client, so this
 * module translates the three constructs and nothing else. Underscores are
 * deliberately left alone: they appear in resource names far more often than
 * as italics, and a service called `my_cost_centre_` must not turn half
 * italic.
 */
import type { AlertSeverity } from "@infrawrench/client-core";
import { emailButton, emailDocument, escapeHtml } from "../email-html";

export interface AlertEmailContent {
  orgName: string;
  severity: AlertSeverity;
  /** The trigger's label, e.g. "Budgets". */
  triggerLabel: string;
  title: string;
  body: string;
  context?: string;
  /** Deep link into the app for the thing the alert is about. */
  url?: string | null;
}

export interface AlertEmailFooter {
  /** The address this copy goes to, named so a forwarded copy explains itself. */
  recipient: string;
  /** Why this address is on the list: "you are a recipient of budget "Prod"". */
  reason: string;
  /** Where a member changes who gets these. Null without `APP_URL`. */
  manageUrl: string | null;
  /** Signed one-click unsubscribe link. Null without `APP_URL`. */
  unsubscribeUrl: string | null;
}

export interface RenderedAlertEmail {
  subject: string;
  text: string;
  html: string;
}

const SEVERITY_WORD: Record<AlertSeverity, string> = {
  info: "Info",
  warning: "Warning",
  critical: "Critical",
};

/** Accent colour per severity: readable on white and on a dark client's grey. */
const SEVERITY_COLOR: Record<AlertSeverity, string> = {
  info: "#2563eb",
  warning: "#d97706",
  critical: "#dc2626",
};

/** Slack's three escaped characters, decoded for a plain-text reader. */
function decodeSlackEntities(s: string): string {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

const LINK_RE = /<(https?:\/\/[^|>\s]+)(?:\|([^>]+))?>/g;
const BOLD_RE = /(^|[\s(])\*([^*\n]+)\*(?=$|[\s.,;:!?)])/g;
const CODE_RE = /`([^`\n]+)`/g;

/** Slack mrkdwn → plain text: links become `label (url)`, markers vanish. */
export function mrkdwnToText(body: string): string {
  return decodeSlackEntities(
    body
      .replace(LINK_RE, (_m, url: string, label?: string) =>
        label && label !== url ? `${label} (${url})` : url,
      )
      .replace(BOLD_RE, (_m, lead: string, inner: string) => `${lead}${inner}`)
      .replace(CODE_RE, (_m, inner: string) => inner),
  );
}

/**
 * Slack mrkdwn → HTML. Everything is escaped first and the three constructs
 * are rebuilt from the escaped text, so nothing a synced resource name carries
 * can become markup.
 */
export function mrkdwnToHtml(body: string): string {
  // Decode Slack entities first so `&lt;` in the source is escaped once, not
  // twice, then escape everything.
  const raw = decodeSlackEntities(body);
  const links: string[] = [];
  // Pull links out before escaping (their `<…>` would otherwise be escaped
  // away), leaving an inert placeholder that cannot occur in alert text.
  const withPlaceholders = raw.replace(LINK_RE, (_m, url: string, label?: string) => {
    links.push(
      `<a href="${escapeHtml(url)}" style="color:#2563eb;">${escapeHtml(label ?? url)}</a>`,
    );
    return `\u0000${links.length - 1}\u0000`;
  });
  const html = escapeHtml(withPlaceholders)
    .replace(BOLD_RE, (_m, lead: string, inner: string) => `${lead}<strong>${inner}</strong>`)
    .replace(
      CODE_RE,
      (_m, inner: string) =>
        `<code style="font-family:SFMono-Regular,Menlo,Consolas,monospace;font-size:13px;background:#f3f4f6;padding:1px 4px;border-radius:4px;">${inner}</code>`,
    )
    .replace(/\u0000(\d+)\u0000/g, (_m, i: string) => links[Number(i)] ?? "");
  return html.replace(/\n/g, "<br>\n");
}

/** `[Acme] Warning: Budget "Prod" at 80%`. Single line, bounded. */
export function alertEmailSubject(content: AlertEmailContent): string {
  const title = mrkdwnToText(content.title).replace(/\s+/g, " ").trim();
  const subject = `[${content.orgName}] ${SEVERITY_WORD[content.severity]}: ${title}`;
  return subject.length > 200 ? `${subject.slice(0, 197)}...` : subject;
}

export function renderAlertEmail(
  content: AlertEmailContent,
  footer: AlertEmailFooter,
): RenderedAlertEmail {
  const subject = alertEmailSubject(content);
  const severity = SEVERITY_WORD[content.severity];
  const title = mrkdwnToText(content.title);

  const text = [
    `${severity} · ${content.triggerLabel} · ${content.orgName}`,
    "",
    title,
    "",
    mrkdwnToText(content.body),
    ...(content.context ? ["", mrkdwnToText(content.context)] : []),
    ...(content.url ? ["", `View in Infrawrench: ${content.url}`] : []),
    "",
    "--",
    `Sent to ${footer.recipient} because ${footer.reason}.`,
    ...(footer.manageUrl ? [`Manage alert email: ${footer.manageUrl}`] : []),
    ...(footer.unsubscribeUrl ? [`Unsubscribe: ${footer.unsubscribeUrl}`] : []),
  ].join("\n");

  const color = SEVERITY_COLOR[content.severity];
  const footerLinks = [
    footer.manageUrl
      ? `<a href="${escapeHtml(footer.manageUrl)}" style="color:#6b7280;">Manage alert email</a>`
      : "",
    footer.unsubscribeUrl
      ? `<a href="${escapeHtml(footer.unsubscribeUrl)}" style="color:#6b7280;">Unsubscribe</a>`
      : "",
  ].filter((s) => s !== "");

  const html = emailDocument([
    `<p style="margin:0 0 8px;font-size:12px;letter-spacing:0.02em;color:#6b7280;"><span style="display:inline-block;padding:2px 8px;border-radius:999px;background:${color};color:#ffffff;font-weight:600;">${escapeHtml(severity)}</span>&nbsp; ${escapeHtml(content.triggerLabel)} · ${escapeHtml(content.orgName)}</p>`,
    `<h1 style="margin:0 0 12px;font-size:18px;line-height:1.35;color:#111827;border-left:4px solid ${color};padding-left:10px;">${escapeHtml(title)}</h1>`,
    `<p style="margin:0;">${mrkdwnToHtml(content.body)}</p>`,
    content.context
      ? `<p style="margin:12px 0 0;font-size:12px;color:#6b7280;">${mrkdwnToHtml(content.context)}</p>`
      : "",
    emailButton(content.url, "View in Infrawrench"),
    `<hr style="margin:28px 0 12px;border:none;border-top:1px solid #e5e7eb;">`,
    `<p style="margin:0;font-size:12px;color:#6b7280;">Sent to ${escapeHtml(footer.recipient)} because ${escapeHtml(footer.reason)}.${
      footerLinks.length > 0 ? `<br>${footerLinks.join(" &nbsp;·&nbsp; ")}` : ""
    }</p>`,
  ]);

  return { subject, text, html };
}

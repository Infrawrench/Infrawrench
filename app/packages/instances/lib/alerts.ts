import { env } from "cloudflare:workers";
import { msg } from "gt-react";
import {
  normalizeEmailAddress,
  sendEmails,
  type EmailMessage,
} from "@infrawrench/server-core/email";
import { emailButton, emailDocument, escapeHtml } from "@infrawrench/server-core/email-html";
import { bumpWarehouseVersion, loadView, randomId, runView, storeResult } from "./chat/views";
import type { Cell, QueryResult, StoredView } from "./chat/types";
import { getTranslator } from "./i18n/server";
import { DEFAULT_LOCALE, isLocale, localePath } from "./i18n/locales";
import { ORIGIN } from "./sitemap";

/**
 * Email alerts on saved views: "tell me when this table changes".
 *
 * Kept in the `INSTANCES_CHAT` namespace:
 *  - `alert:<id>`: one subscription (an {@link Alert}); the id is the secret
 *    in its confirm and unsubscribe links. Metadata carries the view id and
 *    whether it is confirmed, so a check lists them without reading each.
 *    Unconfirmed ones expire after {@link PENDING_TTL}.
 *  - `snapshot:<viewId>`: the view's result at the last check, which a
 *    change is described against.
 *
 * Double opt-in: nothing is sent to an address until someone with access to
 * it opens the confirmation link and presses Confirm (a page, not a GET that
 * acts, because mail scanners follow links). `POST /api/internal/notify`,
 * called by the bulk pricing sync after it loads new data, re-runs every
 * watched view and mails the confirmed subscribers of those that changed.
 */

export interface Alert {
  id: string;
  viewId: string;
  email: string;
  locale: string;
  confirmed: boolean;
  createdAt: number;
  /** The result hash the subscriber last heard about (or subscribed at). */
  hash: string;
  lastSentAt?: number;
}

interface AlertMeta {
  viewId: string;
  confirmed: boolean;
}

interface Snapshot {
  hash: string;
  columns: string[];
  rows: Cell[][];
  at: number;
}

/** An unconfirmed subscription lasts this long. */
const PENDING_TTL = 3 * 24 * 3600;
/** Rows kept in a snapshot, and so the most a change can be described over. */
const SNAPSHOT_ROWS = 2000;
/** Added and removed rows an email lists, each. */
const LISTED_ROWS = 10;

async function hashOf(result: QueryResult): Promise<string> {
  const json = JSON.stringify([result.columns.map((c) => c.name), result.rows]);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(json));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function snapshotOf(result: QueryResult, hash: string): Snapshot {
  return {
    hash,
    columns: result.columns.map((c) => c.name),
    rows: result.rows.slice(0, SNAPSHOT_ROWS),
    at: Date.now(),
  };
}

const alertKey = (id: string) => `alert:${id}`;
const snapshotKey = (viewId: string) => `snapshot:${viewId}`;

async function putAlert(alert: Alert): Promise<void> {
  const metadata: AlertMeta = { viewId: alert.viewId, confirmed: alert.confirmed };
  await env.INSTANCES_CHAT.put(alertKey(alert.id), JSON.stringify(alert), {
    metadata,
    ...(alert.confirmed ? {} : { expirationTtl: PENDING_TTL }),
  });
}

export async function getAlert(id: string): Promise<Alert | null> {
  if (!/^[0-9A-Za-z]{24}$/.test(id)) return null;
  return env.INSTANCES_CHAT.get<Alert>(alertKey(id), { type: "json" });
}

const alertUrl = (alert: Alert) => `${ORIGIN}${localePath(alert.locale, `/alerts/${alert.id}`)}`;
const viewUrl = (alert: Alert) => `${ORIGIN}${localePath(alert.locale, `/v/${alert.viewId}`)}`;

export class AlertError extends Error {
  constructor(
    message: string,
    /** The HTTP status the route answers with. */
    readonly status = 400,
  ) {
    super(message);
  }
}

/** Start a subscription and send the confirmation email. */
export async function subscribe(
  viewId: string,
  rawEmail: string,
  rawLocale: string,
): Promise<void> {
  let email: string;
  try {
    email = normalizeEmailAddress(rawEmail);
  } catch (error) {
    throw new AlertError(error instanceof Error ? error.message : "Invalid email address");
  }
  const view = await loadView(viewId);
  if (!view) throw new AlertError("No such view", 404);
  const locale = isLocale(rawLocale) ? rawLocale : DEFAULT_LOCALE;
  const data = await runView(view);
  const hash = await hashOf(data.result);
  // The baseline a later change is described against, if the view has none yet.
  const snapshot = await env.INSTANCES_CHAT.get(snapshotKey(view.id));
  if (!snapshot) {
    await env.INSTANCES_CHAT.put(
      snapshotKey(view.id),
      JSON.stringify(snapshotOf(data.result, hash)),
    );
  }
  const alert: Alert = {
    id: randomId(24),
    viewId: view.id,
    email,
    locale,
    confirmed: false,
    createdAt: Date.now(),
    hash,
  };
  await putAlert(alert);

  const tr = await getTranslator(locale);
  const title = escapeHtml(view.title);
  const sent = await sendEmails(
    [
      {
        to: email,
        subject: tr(msg("Confirm your alert for {title}"), { title: view.title }),
        text: [
          tr(msg("Someone, hopefully you, asked to be emailed when this changes: {title}"), {
            title: view.title,
          }),
          "",
          tr(msg("Confirm here: {url}"), { url: alertUrl(alert) }),
          "",
          tr(msg("If it was not you, ignore this email; nothing will be sent.")),
        ].join("\n"),
        html: emailDocument([
          `<p>${escapeHtml(tr(msg("Someone, hopefully you, asked to be emailed when this changes:")))}</p>`,
          `<p style="font-weight:600;">${title}</p>`,
          emailButton(alertUrl(alert), escapeHtml(tr(msg("Confirm alert")))),
          `<p style="margin-top:24px;color:#6b7280;">${escapeHtml(tr(msg("If it was not you, ignore this email; nothing will be sent.")))}</p>`,
        ]),
        traceKey: `instances-alert-confirm:${alert.id.slice(0, 8)}`,
      },
    ],
    "instances alert confirmation",
  );
  if (sent.succeeded === 0) {
    // Nobody can confirm an alert whose email never left.
    await env.INSTANCES_CHAT.delete(alertKey(alert.id));
    throw new AlertError("Could not send the confirmation email", 503);
  }
}

/** What the alert page shows; never the full address. */
export interface AlertSummary {
  id: string;
  viewId: string;
  title: string;
  email: string;
  confirmed: boolean;
}

function maskEmail(email: string): string {
  const [user = "", domain = ""] = email.split("@");
  return `${user.slice(0, 2)}${"•".repeat(Math.max(1, user.length - 2))}@${domain}`;
}

export async function summarize(alert: Alert): Promise<AlertSummary> {
  const view = await loadView(alert.viewId);
  return {
    id: alert.id,
    viewId: alert.viewId,
    title: view?.title ?? "",
    email: maskEmail(alert.email),
    confirmed: alert.confirmed,
  };
}

export async function confirm(alert: Alert): Promise<void> {
  if (alert.confirmed) return;
  await putAlert({ ...alert, confirmed: true });
}

export async function unsubscribe(id: string): Promise<void> {
  await env.INSTANCES_CHAT.delete(alertKey(id));
}

async function listAlerts(): Promise<{ id: string; meta: AlertMeta }[]> {
  const out: { id: string; meta: AlertMeta }[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.INSTANCES_CHAT.list<AlertMeta>({
      prefix: "alert:",
      cursor: cursor ?? null,
    });
    for (const key of page.keys) {
      if (key.metadata) out.push({ id: key.name.slice("alert:".length), meta: key.metadata });
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return out;
}

function rowText(columns: string[], row: Cell[]): string {
  return row
    .slice(0, 6)
    .map((v, i) => `${columns[i]}: ${v === null ? "-" : String(v)}`)
    .join(", ");
}

/** Rows in `next` not in `prev`, and the other way round, by their whole value. */
function diff(prev: Snapshot, next: Snapshot): { added: Cell[][]; removed: Cell[][] } {
  const key = (r: Cell[]) => JSON.stringify(r);
  const before = new Set(prev.rows.map(key));
  const after = new Set(next.rows.map(key));
  return {
    added: next.rows.filter((r) => !before.has(key(r))),
    removed: prev.rows.filter((r) => !after.has(key(r))),
  };
}

async function changeEmail(
  alert: Alert,
  view: StoredView,
  prev: Snapshot | null,
  next: Snapshot,
): Promise<EmailMessage> {
  const tr = await getTranslator(alert.locale);
  const { added, removed } = prev ? diff(prev, next) : { added: [], removed: [] };
  const section = (heading: string, rows: Cell[][]) =>
    rows.length === 0
      ? { text: "", html: "" }
      : {
          text: [
            heading,
            ...rows.slice(0, LISTED_ROWS).map((r) => `- ${rowText(next.columns, r)}`),
            rows.length > LISTED_ROWS
              ? `  ${tr(msg("and {count} more"), { count: rows.length - LISTED_ROWS })}`
              : "",
          ]
            .filter(Boolean)
            .join("\n"),
          html: `<p style="margin:16px 0 4px;font-weight:600;">${escapeHtml(heading)}</p><ul style="margin:0;padding-left:20px;">${rows
            .slice(0, LISTED_ROWS)
            .map((r) => `<li>${escapeHtml(rowText(next.columns, r))}</li>`)
            .join(
              "",
            )}${rows.length > LISTED_ROWS ? `<li>${escapeHtml(tr(msg("and {count} more"), { count: rows.length - LISTED_ROWS }))}</li>` : ""}</ul>`,
        };
  const a = section(tr(msg("New rows")), added);
  const r = section(tr(msg("Rows no longer there")), removed);
  const lead = tr(msg("The results of {title} changed after AWS's latest price list update."), {
    title: view.title,
  });
  const unsubscribeUrl = `${ORIGIN}/api/alerts/${alert.id}/unsubscribe`;
  return {
    to: alert.email,
    subject: tr(msg("Changed: {title}"), { title: view.title }),
    text: [
      lead,
      a.text,
      r.text,
      "",
      tr(msg("See it: {url}"), { url: viewUrl(alert) }),
      tr(msg("Stop these emails: {url}"), { url: alertUrl(alert) }),
    ]
      .filter((s) => s !== "")
      .join("\n\n"),
    html: emailDocument([
      `<p>${escapeHtml(lead)}</p>`,
      a.html,
      r.html,
      emailButton(viewUrl(alert), escapeHtml(tr(msg("Open the table")))),
      `<p style="margin-top:24px;color:#6b7280;font-size:12px;"><a href="${escapeHtml(alertUrl(alert))}" style="color:#6b7280;">${escapeHtml(tr(msg("Stop these emails")))}</a></p>`,
    ]),
    // RFC 8058 one-click unsubscribe: mail clients POST to it.
    headers: {
      "List-Unsubscribe": `<${unsubscribeUrl}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    },
    traceKey: `instances-alert:${alert.id.slice(0, 8)}`,
  };
}

export interface NotifyResult {
  views: number;
  changed: number;
  sent: number;
  failed: number;
}

/** Re-run every view with a confirmed subscriber; email those whose result changed. */
export async function notifyChanges(
  log: (line: string) => void = console.log,
): Promise<NotifyResult> {
  const byView = new Map<string, string[]>();
  for (const { id, meta } of await listAlerts()) {
    if (!meta.confirmed) continue;
    byView.set(meta.viewId, [...(byView.get(meta.viewId) ?? []), id]);
  }
  // Every cached view result is now out of date; each refreshes on its next visit.
  const version = await bumpWarehouseVersion();
  const result: NotifyResult = { views: byView.size, changed: 0, sent: 0, failed: 0 };
  for (const [viewId, alertIds] of byView) {
    try {
      const view = await loadView(viewId);
      if (!view) continue;
      const data = await runView(view);
      await storeResult(data, version);
      const hash = await hashOf(data.result);
      const prev = await env.INSTANCES_CHAT.get<Snapshot>(snapshotKey(viewId), { type: "json" });
      const next = snapshotOf(data.result, hash);
      if (prev?.hash !== hash) {
        await env.INSTANCES_CHAT.put(snapshotKey(viewId), JSON.stringify(next));
      }
      const alerts = (await Promise.all(alertIds.map(getAlert))).filter(
        (a): a is Alert => a !== null && a.confirmed && a.hash !== hash,
      );
      if (alerts.length === 0) continue;
      result.changed++;
      // Described against the last snapshot, which is what the subscriber
      // last heard about unless they joined since; good enough for a summary.
      const messages = await Promise.all(alerts.map((a) => changeEmail(a, view, prev, next)));
      const sent = await sendEmails(messages, "instances alert");
      result.sent += sent.succeeded;
      result.failed += sent.failed;
      if (sent.succeeded > 0) {
        await Promise.all(alerts.map((a) => putAlert({ ...a, hash, lastSentAt: Date.now() })));
      }
    } catch (error) {
      log(
        `alerts: view ${viewId} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return result;
}

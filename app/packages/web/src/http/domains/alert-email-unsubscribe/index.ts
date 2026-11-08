/**
 * The public alert-email unsubscribe pages, the handlers. The token is the
 * whole authorization: it names one organization and one address, and the
 * only write it can cause is suppressing mail to that address there.
 */
import { Effect } from "effect";
import { HttpServerResponse } from "effect/http";
import { HttpApiBuilder } from "effect/http-api";
import { eq } from "drizzle-orm";
import { suppressAlertEmail, verifyUnsubscribeToken } from "@infrawrench/server-core/alerts/email";
import { escapeHtml } from "@infrawrench/server-core/email-html";
import { AlertEmailUnsubscribeApi } from "@infrawrench/api-contract";
import { db } from "../../../db/client";
import { organizations } from "../../../db/schema";
import { logAudit } from "../../../services/audit";
import { makeDomain } from "../../domain";
import { legacy } from "../../legacy";

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title>
<style>
  body { font-family: -apple-system, Segoe UI, Helvetica, Arial, sans-serif; background: #0f1115; color: #e6e8ee; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
  main { max-width: 32rem; padding: 2rem; background: #171a21; border-radius: 12px; border: 1px solid #262a33; }
  h1 { font-size: 1.25rem; margin: 0 0 1rem; }
  p { line-height: 1.5; }
  p.hint { color: #9aa1b2; font-size: 0.85rem; }
  button { background: #4f6df5; color: #fff; border: 0; border-radius: 8px; padding: 0.6rem 1.2rem; font-size: 1rem; cursor: pointer; }
</style>
</head>
<body>
<main>
${body}
</main>
</body>
</html>`;
}

/** Hono's `c.html(body, status)`, byte for byte. */
const html = (body: string, status = 200) =>
  HttpServerResponse.text(body, { status, contentType: "text/html; charset=UTF-8" });

const orgName = (organizationId: string) =>
  legacy(async () => {
    const [row] = await db
      .select({ name: organizations.displayName })
      .from(organizations)
      .where(eq(organizations.id, organizationId))
      .limit(1);
    return row?.name ?? null;
  });

/** The first `t` in the request's query, as Hono's `c.req.query("t")` read it. */
const tokenOf = (url: string) =>
  new URL(url, "http://localhost").searchParams.get("t") ?? undefined;

const INVALID = page(
  "Link not valid",
  `<h1>This unsubscribe link is not valid</h1>
  <p>It may have been copied incompletely. Use the Unsubscribe link at the bottom of the most recent alert email instead.</p>`,
);

const AlertEmailUnsubscribeHandlers = HttpApiBuilder.group(
  AlertEmailUnsubscribeApi,
  "alertEmailUnsubscribe",
  (h) =>
    h
      // Confirmation page only, never a state change.
      .handle("confirm", ({ request }) =>
        Effect.gen(function* () {
          const token = tokenOf(request.url) ?? "";
          const verified = verifyUnsubscribeToken(token);
          if (!verified) return html(INVALID, 400);
          const name = yield* orgName(verified.organizationId);
          if (name === null) return html(INVALID, 404);
          return html(
            page(
              "Unsubscribe from alert email",
              `<h1>Unsubscribe from alert email?</h1>
  <p><strong>${escapeHtml(verified.email)}</strong> will stop receiving alert email from
  <strong>${escapeHtml(name)}</strong> on Infrawrench, whichever budget, alert or routing rule names it.</p>
  <p class="hint">Other organizations, and the weekly digest, are not affected. An admin of ${escapeHtml(name)} can resume delivery from Settings.</p>
  <form method="post" action="/api/alert-email/unsubscribe?t=${encodeURIComponent(token)}">
    <button type="submit">Unsubscribe</button>
  </form>`,
            ),
          );
        }),
      )
      // The confirmation form's target and the RFC 8058 one-click endpoint. No
      // cookies, no redirect (the RFC forbids one, since redirected POSTs are
      // unreliable), idempotent.
      .handle("unsubscribe", ({ request }) =>
        Effect.gen(function* () {
          const verified = verifyUnsubscribeToken(tokenOf(request.url));
          if (!verified) return html(INVALID, 400);
          const name = yield* orgName(verified.organizationId);
          if (name === null) return html(INVALID, 404);

          yield* legacy(() => suppressAlertEmail(verified.organizationId, verified.email));
          yield* legacy(() =>
            logAudit({
              organizationId: verified.organizationId,
              action: "alert_email.unsubscribe",
              entityType: "alert_email_suppression",
              entityId: verified.email,
              metadata: { email: verified.email },
            }),
          );
          return html(
            page(
              "Unsubscribed",
              `<h1>You're unsubscribed</h1>
  <p><strong>${escapeHtml(verified.email)}</strong> will no longer receive alert email from
  <strong>${escapeHtml(name)}</strong>.</p>
  <p class="hint">Changed your mind? Ask an admin of ${escapeHtml(name)} to resume delivery from Settings &rarr; Notifications &rarr; Email.</p>`,
            ),
          );
        }),
      ),
);

export const alertEmailUnsubscribeDomain = makeDomain(
  "alert-email-unsubscribe",
  AlertEmailUnsubscribeApi,
  AlertEmailUnsubscribeHandlers,
);

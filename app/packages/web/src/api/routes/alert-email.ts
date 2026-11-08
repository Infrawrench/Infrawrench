/**
 * The public alert-email unsubscribe link in every alert email, mounted at
 * the API root with no session: the HMAC-signed token in the URL is the whole
 * authorization, and all it can do is stop mail to the one address it names.
 * The GET only renders a confirmation page (link scanners and mail previewers
 * fetch every URL in a message, and must not unsubscribe anyone), and the POST
 * does the work, which is also exactly what an RFC 8058 one-click
 * `List-Unsubscribe-Post` sends.
 *
 * The org-scoped half (the recipient picker's options, the external-address
 * policy and the suppression list) is on HttpApi in `http/domains/alert-email`.
 */
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { suppressAlertEmail, verifyUnsubscribeToken } from "@infrawrench/server-core/alerts/email";
import { escapeHtml } from "@infrawrench/server-core/email-html";

import { db } from "../../db/client";
import { organizations } from "../../db/schema";
import { logAudit } from "../../services/audit";

const pub = new Hono();

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

async function orgName(organizationId: string): Promise<string | null> {
  const [row] = await db
    .select({ name: organizations.displayName })
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .limit(1);
  return row?.name ?? null;
}

const INVALID = page(
  "Link not valid",
  `<h1>This unsubscribe link is not valid</h1>
  <p>It may have been copied incompletely. Use the Unsubscribe link at the bottom of the most recent alert email instead.</p>`,
);

/** GET /api/alert-email/unsubscribe?t=: confirmation page only, never a state change. */
pub.get("/alert-email/unsubscribe", async (c) => {
  const token = c.req.query("t") ?? "";
  const verified = verifyUnsubscribeToken(token);
  if (!verified) return c.html(INVALID, 400);
  const name = await orgName(verified.organizationId);
  if (name === null) return c.html(INVALID, 404);
  return c.html(
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
});

/**
 * POST /api/alert-email/unsubscribe?t=: the confirmation form's target and the
 * RFC 8058 one-click endpoint. No cookies, no redirect (the RFC forbids one,
 * since redirected POSTs are unreliable), idempotent.
 */
pub.post("/alert-email/unsubscribe", async (c) => {
  const verified = verifyUnsubscribeToken(c.req.query("t"));
  if (!verified) return c.html(INVALID, 400);
  const name = await orgName(verified.organizationId);
  if (name === null) return c.html(INVALID, 404);

  await suppressAlertEmail(verified.organizationId, verified.email);
  await logAudit({
    organizationId: verified.organizationId,
    action: "alert_email.unsubscribe",
    entityType: "alert_email_suppression",
    entityId: verified.email,
    metadata: { email: verified.email },
  });
  return c.html(
    page(
      "Unsubscribed",
      `<h1>You're unsubscribed</h1>
  <p><strong>${escapeHtml(verified.email)}</strong> will no longer receive alert email from
  <strong>${escapeHtml(name)}</strong>.</p>
  <p class="hint">Changed your mind? Ask an admin of ${escapeHtml(name)} to resume delivery from Settings &rarr; Notifications &rarr; Email.</p>`,
    ),
  );
});

export { pub as alertEmailPublicRoutes };

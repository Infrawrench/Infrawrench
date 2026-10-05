/**
 * Alert email: the recipient picker's options, the org's external-address
 * policy, the suppression list, and the public unsubscribe endpoint.
 *
 * Two Hono apps because the halves have nothing in common but the subject:
 *
 * - `alertEmailRoutes` is org-scoped (`/api/org/:orgId/alert-email`). The
 *   options read is `costs:read`, because every cost-object editor (budgets,
 *   change alerts, anomaly and efficiency settings) needs the member list and
 *   the policy to tell the truth about what will send. The policy and the
 *   suppressions are `org:settings:write`, the same gate as alert routing.
 * - `alertEmailPublicRoutes` is the unsubscribe link in every alert email,
 *   mounted at the API root with no session: the HMAC-signed token in the URL
 *   is the whole authorization, and all it can do is stop mail to the one
 *   address it names. The GET only renders a confirmation page (link
 *   scanners and mail previewers fetch every URL in a message, and must not
 *   unsubscribe anyone), and the POST does the work, which is also exactly
 *   what an RFC 8058 one-click `List-Unsubscribe-Post` sends.
 */
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { alertEmailSettingsError, type AlertEmailSettings } from "@infrawrench/client-core";
import {
  getAlertEmailOptions,
  getAlertEmailSettingsView,
  removeAlertEmailSuppression,
  setAlertEmailSettings,
  suppressAlertEmail,
  verifyUnsubscribeToken,
} from "@infrawrench/server-core/alerts/email";
import { escapeHtml } from "@infrawrench/server-core/email-html";

import { db } from "../../db/client";
import { organizations } from "../../db/schema";
import { requirePermission } from "../../auth/permissions";
import { logAudit } from "../../services/audit";

const app = new Hono();

/** GET /api/org/:orgId/alert-email: members, policy and availability for a picker. */
app.get("/", async (c) => {
  requirePermission(c, "costs:read");
  return c.json(await getAlertEmailOptions(c.get("organizationId")));
});

/** GET /api/org/:orgId/alert-email/settings: the admin view, with suppressions. */
app.get("/settings", async (c) => {
  requirePermission(c, "org:settings:write");
  return c.json(await getAlertEmailSettingsView(c.get("organizationId")));
});

/**
 * PUT /api/org/:orgId/alert-email/settings: whole object.
 *
 * Tightening the policy does not edit any stored recipient list: an address
 * that no longer passes is skipped at send time, so loosening it again later
 * brings it back without anybody re-entering it.
 */
app.put("/settings", async (c) => {
  requirePermission(c, "org:settings:write");
  const organizationId = c.get("organizationId");
  const session = c.get("session");
  const body = (await c.req.json().catch(() => null)) as Partial<AlertEmailSettings> | null;
  if (!body || typeof body !== "object") return c.json({ error: "Invalid settings" }, 400);
  const input: AlertEmailSettings = {
    externalPolicy: body.externalPolicy as AlertEmailSettings["externalPolicy"],
    allowedDomains: body.allowedDomains as string[],
  };
  const error = alertEmailSettingsError(input);
  if (error) return c.json({ error }, 400);

  const saved = await setAlertEmailSettings(organizationId, input);
  await logAudit({
    organizationId,
    ...(session?.userId ? { userId: session.userId } : {}),
    action: "alert_email.settings.update",
    entityType: "alert_email_settings",
    entityId: organizationId,
    metadata: { externalPolicy: saved.externalPolicy, allowedDomains: saved.allowedDomains },
  });
  return c.json(await getAlertEmailSettingsView(organizationId));
});

/** DELETE /api/org/:orgId/alert-email/suppressions/:id: resume mail to an address. */
app.delete("/suppressions/:id", async (c) => {
  requirePermission(c, "org:settings:write");
  const organizationId = c.get("organizationId");
  const session = c.get("session");
  const removed = await removeAlertEmailSuppression(organizationId, c.req.param("id"));
  if (!removed) return c.json({ error: "Not found" }, 404);
  await logAudit({
    organizationId,
    ...(session?.userId ? { userId: session.userId } : {}),
    action: "alert_email.suppression.remove",
    entityType: "alert_email_suppression",
    entityId: c.req.param("id"),
  });
  return c.json({ ok: true });
});

export { app as alertEmailRoutes };

// --- Public unsubscribe ---

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

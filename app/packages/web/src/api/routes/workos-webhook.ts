import { Hono } from "hono";
import {
  claimEvent,
  eventWorkosOrgId,
  handleWorkosEvent,
  parseWorkosEvent,
  releaseEvent,
  verifyWorkosSignature,
} from "../../services/sso/webhook";
import { findSsoSettingsByWorkosOrg } from "../../services/sso/settings";

/**
 * POST /api/v1/webhooks/workos
 *
 * Directory Sync (SCIM) user and group changes, SSO connection state, and
 * organization domain verification. Public, outside every auth layer: the
 * signature over the raw body is the authentication, checked before the body
 * is even parsed. See `services/sso/webhook.ts` for the scheme and the replay
 * rules.
 *
 * Answers 200 for anything verified that we choose not to act on (an event
 * for an org that never set up SSO, a type we do not handle), because a non-2xx
 * makes WorkOS retry, and retrying an event we will never handle helps nobody.
 */
const app = new Hono();

app.post("/", async (c) => {
  const secret = process.env["WORKOS_WEBHOOK_SECRET"];
  if (!secret) {
    console.error("[workos-webhook] WORKOS_WEBHOOK_SECRET is not set; refusing the event");
    return c.json({ error: "Webhook not configured" }, 503);
  }
  const raw = await c.req.text();
  if (!verifyWorkosSignature(raw, c.req.header("workos-signature"), secret)) {
    return c.json({ error: "Invalid signature" }, 400);
  }
  const event = parseWorkosEvent(raw);
  if (!event) return c.json({ error: "Malformed event" }, 400);

  let workosOrgId: string | null;
  try {
    workosOrgId = await eventWorkosOrgId(event);
  } catch (err) {
    console.error(`[workos-webhook] resolving the organization of ${event.id} failed:`, err);
    return c.json({ error: "Could not resolve the event's organization" }, 500);
  }
  const settings = workosOrgId ? await findSsoSettingsByWorkosOrg(workosOrgId) : null;
  if (!settings) return c.json({ received: true });

  if (!(await claimEvent(event, settings.organizationId))) {
    return c.json({ received: true, duplicate: true });
  }
  try {
    await handleWorkosEvent(settings, event);
  } catch (err) {
    console.error(`[workos-webhook] handling ${event.event} ${event.id} failed:`, err);
    // Un-claim so WorkOS's retry is processed rather than dropped as a duplicate.
    await releaseEvent(event.id).catch(() => {});
    return c.json({ error: "Handler error" }, 500);
  }
  return c.json({ received: true });
});

export { app as workosWebhookRoutes };

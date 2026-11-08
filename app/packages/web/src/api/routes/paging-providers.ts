/**
 * The inbound paging-provider webhook, `/api/paging-webhooks/:token`.
 *
 * Unauthenticated by design: the token picks the account and the provider's
 * signature over the raw body is what makes a delivery trusted. Mounted before
 * the session middleware, and always served by the gateway (the signature
 * check is plugin code). It stays on Hono because it reads the raw body before
 * anything parses it.
 *
 * The org-tree routes (`/paging-providers`, `/paging-incidents`) are served by
 * the HttpApi domain in `http/domains/paging-providers/`.
 */
import { Hono } from "hono";
import { handlePagingWebhook } from "@infrawrench/server-core/paging/providers";

// ---------------------------------------------------------------------------
// /api/paging-webhooks/:token
// ---------------------------------------------------------------------------

export const pagingWebhookRoutes = new Hono();

/** Bodies past this are not a provider webhook; refuse before hashing them. */
const MAX_WEBHOOK_BYTES = 1_000_000;

pagingWebhookRoutes.post("/paging-webhooks/:token", async (c) => {
  const token = c.req.param("token");
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(token)) return c.json({ error: "Not found" }, 404);
  const body = await c.req.text();
  if (body.length > MAX_WEBHOOK_BYTES) return c.json({ error: "Payload too large" }, 413);
  const headers: Record<string, string> = {};
  c.req.raw.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });
  try {
    const status = await handlePagingWebhook(token, headers, body);
    if (status === 404) return c.json({ error: "Not found" }, 404);
    if (status === 401) return c.json({ error: "Invalid signature" }, 401);
    return c.body(null, 202);
  } catch (err) {
    console.error("[paging] webhook handling failed:", err);
    // A 5xx makes the provider retry, which is what a transient failure here wants.
    return c.json({ error: "Webhook processing failed" }, 500);
  }
});

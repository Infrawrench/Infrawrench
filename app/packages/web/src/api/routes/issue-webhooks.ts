/**
 * Inbound tracker webhooks for live issue status (`/api/issue-webhooks/*`).
 *
 * Unauthenticated by session: the signature is the authentication.
 *
 *   POST /api/issue-webhooks/jira/:token    `X-Hub-Signature: sha256=<hex>` with
 *                                           the org's stored secret
 *   POST /api/issue-webhooks/linear/:token  `Linear-Signature: <hex>` with the
 *                                           org's stored secret, plus the
 *                                           one-minute `webhookTimestamp` check
 *   POST /api/issue-webhooks/github         `X-Hub-Signature-256: sha256=<hex>`
 *                                           with `GITHUB_APP_WEBHOOK_SECRET`,
 *                                           the GitHub App's one webhook
 *
 * The Jira and Linear tokens identify the org (they are random, 43 characters,
 * and unique), and an unknown token or a bad signature both answer 404/401
 * without saying which part was wrong. The body is read raw: every signature
 * here is over the exact bytes sent, and re-serialized JSON would not match.
 *
 * Deliberately served on the edge (not in `edge/gateway-routes.ts`): the work
 * is an HMAC, a few indexed Postgres reads and writes, and at most one HTTPS
 * read from the tracker's own API, and Linear gives a receiver five seconds
 * before it counts a delivery failed (and disables a webhook that keeps
 * failing). A Lambda cold start would spend most of that.
 *
 * Answers 202 once applied; a processing failure is a 500 so the tracker
 * retries (Jira up to five times, Linear three, GitHub not at all, which the
 * poll covers).
 */
import { Hono } from "hono";
import { findJiraWebhookByToken, touchJiraWebhookDelivery } from "@infrawrench/server-core/jira";
import {
  findLinearWebhookByToken,
  touchLinearWebhookDelivery,
} from "@infrawrench/server-core/linear";
import {
  parseGithubWebhook,
  parseJiraWebhook,
  parseLinearWebhook,
  verifyHubSignature,
  verifyLinearSignature,
} from "@infrawrench/server-core/issue-status/readings";
import {
  applyGithubWebhook,
  applyJiraWebhook,
  applyLinearWebhook,
} from "@infrawrench/server-core/issue-status/sync";

export const issueWebhookRoutes = new Hono();

/** Bodies past this are not a tracker webhook; refuse before hashing them. */
const MAX_WEBHOOK_BYTES = 2_000_000;

const TOKEN = /^[A-Za-z0-9_-]{20,128}$/;

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return null;
  }
}

issueWebhookRoutes.post("/issue-webhooks/jira/:token", async (c) => {
  const token = c.req.param("token");
  if (!TOKEN.test(token)) return c.json({ error: "Not found" }, 404);
  const body = await c.req.text();
  if (body.length > MAX_WEBHOOK_BYTES) return c.json({ error: "Payload too large" }, 413);
  const hook = await findJiraWebhookByToken(token);
  if (!hook) return c.json({ error: "Not found" }, 404);
  if (!verifyHubSignature(hook.secret, body, c.req.header("x-hub-signature"))) {
    return c.json({ error: "Invalid signature" }, 401);
  }
  try {
    await touchJiraWebhookDelivery(hook.organizationId);
    await applyJiraWebhook(hook.organizationId, parseJiraWebhook(parseJson(body)));
    return c.body(null, 202);
  } catch (err) {
    console.error("[issue-status] Jira webhook failed:", err);
    return c.json({ error: "Webhook processing failed" }, 500);
  }
});

issueWebhookRoutes.post("/issue-webhooks/linear/:token", async (c) => {
  const token = c.req.param("token");
  if (!TOKEN.test(token)) return c.json({ error: "Not found" }, 404);
  const body = await c.req.text();
  if (body.length > MAX_WEBHOOK_BYTES) return c.json({ error: "Payload too large" }, 413);
  const hook = await findLinearWebhookByToken(token);
  if (!hook) return c.json({ error: "Not found" }, 404);
  const parsed = parseJson(body);
  const timestamp =
    parsed && typeof parsed === "object"
      ? (parsed as { webhookTimestamp?: unknown }).webhookTimestamp
      : undefined;
  if (!verifyLinearSignature(hook.secret, body, c.req.header("linear-signature"), timestamp)) {
    return c.json({ error: "Invalid signature" }, 401);
  }
  try {
    await touchLinearWebhookDelivery(hook.organizationId);
    await applyLinearWebhook(hook.organizationId, parseLinearWebhook(parsed));
    return c.body(null, 202);
  } catch (err) {
    console.error("[issue-status] Linear webhook failed:", err);
    return c.json({ error: "Webhook processing failed" }, 500);
  }
});

issueWebhookRoutes.post("/issue-webhooks/github", async (c) => {
  const secret = process.env["GITHUB_APP_WEBHOOK_SECRET"];
  // Without a secret there is nothing to verify against, and an unverified
  // delivery could rewrite any org's issue status.
  if (!secret) return c.json({ error: "Not found" }, 404);
  const body = await c.req.text();
  if (body.length > MAX_WEBHOOK_BYTES) return c.json({ error: "Payload too large" }, 413);
  if (!verifyHubSignature(secret, body, c.req.header("x-hub-signature-256"))) {
    return c.json({ error: "Invalid signature" }, 401);
  }
  const event = c.req.header("x-github-event");
  // GitHub sends `ping` when the webhook is saved; answering it keeps the
  // App's delivery log green.
  if (event === "ping") return c.json({ ok: true });
  try {
    await applyGithubWebhook(parseGithubWebhook(event, parseJson(body)));
    return c.body(null, 202);
  } catch (err) {
    console.error("[issue-status] GitHub webhook failed:", err);
    return c.json({ error: "Webhook processing failed" }, 500);
  }
});

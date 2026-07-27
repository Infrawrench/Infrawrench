/**
 * Paging — `POST /api/org/:orgId/pages` and `DELETE /api/org/:orgId/pages`.
 *
 * The same alert a workflow raises with `infra.page(...)`, for code that runs
 * somewhere Infrawrench does not: a health check, a deploy script, a cron on a
 * box. It fans out over the org's configured transports (Twilio SMS and voice,
 * mobile push, Slack, Microsoft Teams) and honours each recipient's opt-ins, so
 * the caller doesn't embed any of them.
 *
 * Repeat pages under the same `(source, key)` are suppressed for the cooldown
 * window rather than rejected — a monitor that fires every minute pages once
 * and then reports `suppressed: true` with the `retryAt` it can page again.
 *
 * Mounted outside the org tree's middleware stack because that stack 401s
 * `iwk_` API keys, and an unattended server has nothing else to authenticate
 * with — see `auth/org-request-auth.ts`.
 */
import { Hono } from "hono";
import { z } from "zod";

import { DEFAULT_PAGE_KEY, type PageSpec } from "@infrawrench/workflow-runtime";
import {
  clearExternalPage,
  pageFromExternal,
} from "@infrawrench/server-core/paging/external-pages";
import { isValidSourceName, SOURCE_NAME_HELP } from "@infrawrench/server-core/source-name";

import { authenticateOrgRequest } from "../../auth/org-request-auth";
import { logAudit } from "../../services/audit";

const app = new Hono();

const MAX_MESSAGE_LENGTH = 2_000;

/** A day of cooldown is the most a single call may ask for. */
const MAX_COOLDOWN_MINUTES = 1_440;

const pageSchema = z.object({
  source: z.string(),
  message: z.string().min(1).max(MAX_MESSAGE_LENGTH),
  title: z.string().min(1).max(200).optional(),
  key: z.string().min(1).max(200).optional(),
  cooldownMinutes: z.number().int().min(0).max(MAX_COOLDOWN_MINUTES).optional(),
  voice: z.boolean().optional(),
});

/** POST /api/org/:orgId/pages — raise an alert to the org's on-call transports. */
app.post("/", async (c) => {
  const orgId = c.req.param("orgId");
  if (!orgId) return c.json({ error: "Missing organization ID" }, 400);

  const auth = await authenticateOrgRequest(c, orgId, "pages:write");
  if (auth instanceof Response) return auth;

  const parsed = pageSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: "Invalid body", issues: parsed.error.issues }, 400);
  }
  const { source, message, title, key, cooldownMinutes, voice } = parsed.data;
  if (!isValidSourceName(source)) return c.json({ error: SOURCE_NAME_HELP }, 400);

  // Spread conditionally rather than passing the parsed object through: under
  // exactOptionalPropertyTypes an explicit `title: undefined` is not a PageSpec.
  const spec: PageSpec = {
    message,
    ...(title !== undefined ? { title } : {}),
    ...(key !== undefined ? { key } : {}),
    ...(cooldownMinutes !== undefined ? { cooldownMinutes } : {}),
    ...(voice !== undefined ? { voice } : {}),
  };

  const result = await pageFromExternal({ organizationId: orgId, source }, spec);

  void logAudit({
    organizationId: orgId,
    userId: auth.userId,
    apiKeyId: auth.apiKeyId,
    action: "page.raise",
    entityType: "page",
    entityId: `${source}/${key ?? DEFAULT_PAGE_KEY}`,
    metadata: {
      delivered: result.delivered,
      suppressed: result.suppressed,
      sms: result.sms,
      push: result.push,
      slack: result.slack,
      msTeams: result.msTeams,
    },
  });

  return c.json(result);
});

/**
 * DELETE /api/org/:orgId/pages?source=&key= — clear a key's cooldown so the
 * next page under it delivers immediately. Call it when the condition you
 * alerted on recovers; the workflow equivalent is `infra.page.clear(key)`.
 */
app.delete("/", async (c) => {
  const orgId = c.req.param("orgId");
  if (!orgId) return c.json({ error: "Missing organization ID" }, 400);

  const auth = await authenticateOrgRequest(c, orgId, "pages:write");
  if (auth instanceof Response) return auth;

  const source = c.req.query("source") ?? "";
  if (!isValidSourceName(source)) return c.json({ error: SOURCE_NAME_HELP }, 400);
  const key = c.req.query("key") || DEFAULT_PAGE_KEY;

  const cleared = await clearExternalPage(orgId, source, key);

  void logAudit({
    organizationId: orgId,
    userId: auth.userId,
    apiKeyId: auth.apiKeyId,
    action: "page.clear",
    entityType: "page",
    entityId: `${source}/${key}`,
    metadata: { cleared },
  });

  return c.json({ cleared });
});

export { app as pageRoutes };

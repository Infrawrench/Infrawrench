/**
 * Paging providers (PagerDuty, incident.io, any plugin with the paging
 * capability). Three route groups:
 *
 * - `/api/org/:orgId/paging-providers`: the per-account settings and the
 *   pickers the routing editor needs. Configuration is `org:settings:write`,
 *   the alert-routing stance; the "who is on call right now" preview is
 *   `team:read`, the on-call stance (nobody should need an admin to find out
 *   who is on call).
 * - `/api/org/:orgId/paging-incidents`: the provider incidents mirrored into
 *   Infrawrench, read with `incidents:read` and acknowledged or resolved with
 *   `incidents:write`, the same split declared incidents use.
 * - `/api/paging-webhooks/:token`: the inbound webhook. Unauthenticated by
 *   design; the token picks the account and the provider's signature is what
 *   makes a delivery trusted. Mounted before the session middleware, and
 *   always served by the gateway (the signature check is plugin code).
 *
 * The server half lives in `server-core/src/paging/providers.ts`; these
 * handlers only parse, gate and audit.
 */
import { Hono, type Context } from "hono";
import type { PagingProviderSettingsInput } from "@infrawrench/client-core";
import {
  PagingProviderError,
  actOnPagerIncident,
  handlePagingWebhook,
  listPagerIncidents,
  listPagingDestinations,
  listPagingEvents,
  listPagingProviders,
  previewProviderOnCall,
  syncPagingIncidents,
  updatePagingProviderSettings,
} from "@infrawrench/server-core/paging/providers";

import { requirePermission } from "../../auth/permissions";
import { logAudit } from "../../services/audit";
import type { AuthSession } from "../auth-middleware";
import { readObjectBody } from "../object-body";

declare module "hono" {
  interface ContextVariableMap {
    session: AuthSession;
  }
}

/** Map a provider error to its status; anything else is a 502 from upstream. */
function providerError(c: Context, err: unknown): Response {
  if (err instanceof PagingProviderError) {
    return c.json({ error: err.message }, err.status as 400 | 404);
  }
  const status = (err as { status?: unknown } | null)?.status;
  const message = err instanceof Error ? err.message : String(err);
  // A provider's 401/403 means the account's key cannot do this; say so as a
  // 400 rather than a 401, which the app would read as *our* session expiring.
  if (status === 401 || status === 403) {
    return c.json({ error: `The provider refused the request: ${message}` }, 400);
  }
  if (status === 404) return c.json({ error: message }, 404);
  return c.json({ error: message }, 502);
}

// ---------------------------------------------------------------------------
// /api/org/:orgId/paging-providers
// ---------------------------------------------------------------------------

export const pagingProviderRoutes = new Hono();

/** Paging-capable accounts and their settings. */
pagingProviderRoutes.get("/", async (c) => {
  requirePermission(c, "org:settings:write");
  return c.json({ accounts: await listPagingProviders(c.get("organizationId")) });
});

/**
 * The routing editor's pickers: each account's targets and on-call sources,
 * listed live from the provider. A failure is reported per account.
 */
pagingProviderRoutes.get("/destinations", async (c) => {
  requirePermission(c, "org:settings:write");
  return c.json(await listPagingDestinations(c.get("organizationId")));
});

/** The outbound event log: what Infrawrench opened upstream and where each got to. */
pagingProviderRoutes.get("/events", async (c) => {
  requirePermission(c, "org:settings:write");
  const limit = Number(c.req.query("limit") ?? 50);
  return c.json({
    events: await listPagingEvents(c.get("organizationId"), Number.isFinite(limit) ? limit : 50),
  });
});

/** Turn incident mirroring on or off, and set up the webhook that feeds it. */
pagingProviderRoutes.put("/:accountId/settings", async (c) => {
  requirePermission(c, "org:settings:write");
  const organizationId = c.get("organizationId");
  const accountId = c.req.param("accountId");
  const parsed = await readObjectBody(c.req);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const { body } = parsed;
  if (typeof body["inboundEnabled"] !== "boolean") {
    return c.json({ error: "inboundEnabled must be a boolean" }, 400);
  }
  const input: PagingProviderSettingsInput = { inboundEnabled: body["inboundEnabled"] };
  if ("webhookSecret" in body) {
    const raw = body["webhookSecret"];
    if (raw !== null && typeof raw !== "string") {
      return c.json({ error: "webhookSecret must be a string or null" }, 400);
    }
    if (typeof raw === "string" && raw.length > 512) {
      return c.json({ error: "webhookSecret is too long" }, 400);
    }
    input.webhookSecret = raw;
  }

  try {
    const result = await updatePagingProviderSettings(organizationId, accountId, input);
    void logAudit({
      organizationId,
      userId: c.get("session")?.userId ?? null,
      action: "paging_provider.settings",
      entityType: "account",
      entityId: accountId,
      // Never the secret: only whether one was set or cleared.
      metadata: {
        inboundEnabled: input.inboundEnabled,
        ...(input.webhookSecret !== undefined
          ? { webhookSecretSet: Boolean(input.webhookSecret) }
          : {}),
      },
    });
    return c.json(result);
  } catch (err) {
    return providerError(c, err);
  }
});

/** Reconcile one account's incidents now rather than at the next tick. */
pagingProviderRoutes.post("/:accountId/sync", async (c) => {
  requirePermission(c, "org:settings:write");
  try {
    const count = await syncPagingIncidents(c.get("organizationId"), c.req.param("accountId"));
    return c.json({ synced: count });
  } catch (err) {
    return providerError(c, err);
  }
});

/** Who is on call on a provider schedule or escalation policy right now. */
pagingProviderRoutes.get("/:accountId/on-call/:sourceId", async (c) => {
  requirePermission(c, "team:read");
  try {
    return c.json(
      await previewProviderOnCall(
        c.get("organizationId"),
        c.req.param("accountId"),
        c.req.param("sourceId"),
      ),
    );
  } catch (err) {
    return providerError(c, err);
  }
});

// ---------------------------------------------------------------------------
// /api/org/:orgId/paging-incidents
// ---------------------------------------------------------------------------

export const pagingIncidentRoutes = new Hono();

/** Mirrored provider incidents. `?status=all` includes resolved ones. */
pagingIncidentRoutes.get("/", async (c) => {
  requirePermission(c, "incidents:read");
  const status = c.req.query("status") === "all" ? "all" : "open";
  return c.json({
    incidents: await listPagerIncidents(c.get("organizationId"), { status }),
  });
});

for (const action of ["acknowledge", "resolve"] as const) {
  pagingIncidentRoutes.post(`/:id/${action}`, async (c) => {
    requirePermission(c, "incidents:write");
    const organizationId = c.get("organizationId");
    const session = c.get("session") as AuthSession | undefined;
    try {
      const incident = await actOnPagerIncident(
        organizationId,
        c.req.param("id"),
        action,
        session?.email ?? null,
      );
      void logAudit({
        organizationId,
        userId: session?.userId,
        action: `paging_incident.${action}`,
        entityType: "paging_incident",
        entityId: incident.id,
        metadata: {
          accountId: incident.accountId,
          externalId: incident.externalId,
          ...(incident.reference ? { reference: incident.reference } : {}),
        },
      });
      return c.json(incident);
    } catch (err) {
      return providerError(c, err);
    }
  });
}

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

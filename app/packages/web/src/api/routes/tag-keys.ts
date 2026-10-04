import { Hono } from "hono";
import { tagKeySettingsError } from "@infrawrench/client-core";
import { tagKeySettingsSchema } from "@infrawrench/ui/cost/config";
import { hasPermission } from "@infrawrench/server-core/permissions/catalog";
import {
  getOrgTagKeySettings,
  setOrgTagKeySettings,
} from "@infrawrench/server-core/cost/tag-key-settings";
import { requirePermission } from "../../auth/permissions";
import { logAudit } from "../../services/audit";
import { discoverTagKeys } from "../../services/tag-keys";
import type { AuthSession } from "../auth-middleware";

declare module "hono" {
  interface ContextVariableMap {
    session: AuthSession;
  }
}

const app = new Hono();

/**
 * GET /api/org/:orgId/tag-keys: every tag key the org's data carries, with
 * the providers that use it, how much, and whether the settings hide or pin
 * it. Readable on `resources:read` (the inventory half); the cost half is
 * included only for callers who also hold `costs:read`.
 */
app.get("/", async (c) => {
  requirePermission(c, "resources:read");
  const includeCosts = hasPermission(c.get("permissions") ?? [], "costs:read");
  return c.json(await discoverTagKeys(c.get("organizationId"), { includeCosts }));
});

/**
 * GET /api/org/:orgId/tag-keys/settings: the hidden and preferred keys.
 * Readable by anyone who can see resources, like the tag policy.
 */
app.get("/settings", async (c) => {
  requirePermission(c, "resources:read");
  return c.json(await getOrgTagKeySettings(c.get("organizationId")));
});

/**
 * PUT /api/org/:orgId/tag-keys/settings: replace both lists. Org-settings
 * gated: it changes what every member's pickers offer.
 */
app.put("/settings", async (c) => {
  requirePermission(c, "org:settings:write");
  const organizationId = c.get("organizationId");
  const session = c.get("session");

  const parsed = tagKeySettingsSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: "Invalid tag key settings", issues: parsed.error.issues }, 400);
  }
  const conflict = tagKeySettingsError(parsed.data);
  if (conflict) return c.json({ error: conflict }, 400);

  const settings = await setOrgTagKeySettings(organizationId, parsed.data);
  void logAudit({
    organizationId,
    userId: session.userId,
    action: "tag_key_settings.update",
    entityType: "tag_key_settings",
    entityId: organizationId,
    metadata: { hidden: settings.hidden, preferred: settings.preferred },
  });
  return c.json(settings);
});

export { app as tagKeyRoutes };

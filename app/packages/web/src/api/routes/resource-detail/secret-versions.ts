import type { Hono } from "hono";
import { getClientForResource } from "../../../services/plugin-clients";
import { requirePermission } from "../../../auth/permissions";

/**
 * Per-resource secret-version routes. These mirror the optional
 * `listSecretVersions` / `accessSecretVersion` / `addSecretVersion` /
 * `modifySecretVersion` methods on `PluginClient`.
 */
export function registerSecretVersionRoutes(app: Hono): void {
  /** GET /api/resources/:pluginId/:typeId/secret-versions?resourceId=...&accountId=...&parentResourceId=... */
  app.get("/:pluginId/:typeId/secret-versions", async (c) => {
    requirePermission(c, "secrets:read");
    const organizationId = c.get("organizationId");
    const pluginId = c.req.param("pluginId");
    const resourceTypeId = c.req.param("typeId");
    const resourceId = c.req.query("resourceId");
    if (!resourceId) return c.json({ error: "Missing resourceId" }, 400);
    const accountId = c.req.query("accountId");
    if (!accountId) return c.json({ error: "Missing accountId" }, 400);
    const parentResourceId = c.req.query("parentResourceId");

    const ctx = await getClientForResource(pluginId, accountId, organizationId, parentResourceId);
    if (!ctx) return c.json({ error: "Account or peer resource not found" }, 404);
    if (!ctx.client.listSecretVersions)
      return c.json({ error: "Plugin does not support secret versions" }, 400);

    const versions = await ctx.client.listSecretVersions(resourceTypeId, resourceId, accountId);
    return c.json({ versions });
  });

  /** POST /api/resources/:pluginId/:typeId/secret-versions/access */
  app.post("/:pluginId/:typeId/secret-versions/access", async (c) => {
    requirePermission(c, "secrets:read");
    const organizationId = c.get("organizationId");
    const pluginId = c.req.param("pluginId");
    const resourceTypeId = c.req.param("typeId");
    const { accountId, resourceId, versionId, parentResourceId } = await c.req.json<{
      accountId: string;
      resourceId: string;
      versionId: string;
      parentResourceId?: string;
    }>();

    const ctx = await getClientForResource(pluginId, accountId, organizationId, parentResourceId);
    if (!ctx) return c.json({ error: "Account or peer resource not found" }, 404);
    if (!ctx.client.accessSecretVersion)
      return c.json({ error: "Plugin does not support secret versions" }, 400);

    const value = await ctx.client.accessSecretVersion(
      resourceTypeId,
      resourceId,
      accountId,
      versionId,
    );
    return c.json({ value });
  });

  /** POST /api/resources/:pluginId/:typeId/secret-versions/add */
  app.post("/:pluginId/:typeId/secret-versions/add", async (c) => {
    requirePermission(c, "secrets:write");
    const organizationId = c.get("organizationId");
    const pluginId = c.req.param("pluginId");
    const resourceTypeId = c.req.param("typeId");
    const { accountId, resourceId, value, parentResourceId } = await c.req.json<{
      accountId: string;
      resourceId: string;
      value: string;
      parentResourceId?: string;
    }>();

    const ctx = await getClientForResource(pluginId, accountId, organizationId, parentResourceId);
    if (!ctx) return c.json({ error: "Account or peer resource not found" }, 404);
    if (!ctx.client.addSecretVersion)
      return c.json({ error: "Plugin does not support secret versions" }, 400);

    const version = await ctx.client.addSecretVersion(resourceTypeId, resourceId, accountId, value);
    return c.json({ version });
  });

  /** POST /api/resources/:pluginId/:typeId/secret-versions/modify */
  app.post("/:pluginId/:typeId/secret-versions/modify", async (c) => {
    requirePermission(c, "secrets:write");
    const organizationId = c.get("organizationId");
    const pluginId = c.req.param("pluginId");
    const resourceTypeId = c.req.param("typeId");
    const { accountId, resourceId, versionId, action, parentResourceId } = await c.req.json<{
      accountId: string;
      resourceId: string;
      versionId: string;
      action: "enable" | "disable" | "destroy";
      parentResourceId?: string;
    }>();

    const ctx = await getClientForResource(pluginId, accountId, organizationId, parentResourceId);
    if (!ctx) return c.json({ error: "Account or peer resource not found" }, 404);
    if (!ctx.client.modifySecretVersion)
      return c.json({ error: "Plugin does not support secret versions" }, 400);

    const version = await ctx.client.modifySecretVersion(
      resourceTypeId,
      resourceId,
      accountId,
      versionId,
      action,
    );
    return c.json({ version });
  });
}

import type { Hono } from "hono";
import { getClientForResource } from "../../../services/plugin-clients";
import { requirePermission } from "../../../auth/permissions";

/**
 * Manifest / YAML / describe / logs routes.
 *
 * All of these operate on a single resource and dispatch to optional methods
 * on the plugin client. Each call resolves the same `ctx` via
 * `getClientForResource` then 400s if the relevant method isn't implemented.
 */
export function registerManifestRoutes(app: Hono): void {
  /** GET /api/resources/:pluginId/:typeId/manifest?resourceId=...&accountId=...&parentResourceId=... */
  app.get("/:pluginId/:typeId/manifest", async (c) => {
    requirePermission(c, "resources:read");
    const organizationId = c.get("organizationId");
    const pluginId = c.req.param("pluginId");
    const resourceId = c.req.query("resourceId");
    if (!resourceId) return c.json({ error: "Missing resourceId" }, 400);
    const accountId = c.req.query("accountId");
    if (!accountId) return c.json({ error: "Missing accountId" }, 400);
    const parentResourceId = c.req.query("parentResourceId");

    const ctx = await getClientForResource(pluginId, accountId, organizationId, parentResourceId);
    if (!ctx) return c.json({ error: "Account or peer resource not found" }, 404);
    if (!ctx.client.getManifest)
      return c.json({ error: "Plugin does not support manifest viewing" }, 400);

    const manifest = await ctx.client.getManifest(resourceId, accountId);
    return c.json({ manifest });
  });

  /** POST /api/resources/:pluginId/:typeId/manifest */
  app.post("/:pluginId/:typeId/manifest", async (c) => {
    requirePermission(c, "resources:write");
    const organizationId = c.get("organizationId");
    const pluginId = c.req.param("pluginId");
    const { accountId, resourceId, manifest, parentResourceId } = await c.req.json<{
      accountId: string;
      resourceId: string;
      manifest: string;
      parentResourceId?: string;
    }>();

    const ctx = await getClientForResource(pluginId, accountId, organizationId, parentResourceId);
    if (!ctx) return c.json({ error: "Account or peer resource not found" }, 404);
    if (!ctx.client.applyManifest)
      return c.json({ error: "Plugin does not support manifest editing" }, 400);

    await ctx.client.applyManifest(resourceId, accountId, manifest);
    return c.json({ ok: true });
  });

  /** POST /api/resources/:pluginId/import-yaml — kubectl apply -f equivalent */
  app.post("/:pluginId/import-yaml", async (c) => {
    requirePermission(c, "resources:write");
    const organizationId = c.get("organizationId");
    const pluginId = c.req.param("pluginId");
    const { accountId, yaml, parentResourceId } = await c.req.json<{
      accountId: string;
      yaml: string;
      parentResourceId?: string;
    }>();

    const ctx = await getClientForResource(pluginId, accountId, organizationId, parentResourceId);
    if (!ctx) return c.json({ error: "Account or peer resource not found" }, 404);
    if (!ctx.client.importYaml)
      return c.json({ error: "Plugin does not support YAML import" }, 400);

    const result = await ctx.client.importYaml(accountId, yaml);
    return c.json(result);
  });

  /** POST /api/resources/:pluginId/:typeId/describe */
  app.post("/:pluginId/:typeId/describe", async (c) => {
    requirePermission(c, "resources:read");
    const organizationId = c.get("organizationId");
    const pluginId = c.req.param("pluginId");
    const resourceTypeId = c.req.param("typeId");
    const { accountId, resourceId, parentResourceId } = await c.req.json<{
      accountId: string;
      resourceId: string;
      parentResourceId?: string;
    }>();
    const ctx = await getClientForResource(pluginId, accountId, organizationId, parentResourceId);
    if (!ctx) {
      return c.json({ error: "Account or peer resource not found" }, 404);
    }
    if (!ctx.client.describeResource) {
      return c.json({ error: "Plugin does not support describe" }, 400);
    }

    const text = await ctx.client.describeResource(resourceTypeId, resourceId, accountId);
    return c.json({ text });
  });

  /** POST /api/resources/:pluginId/:typeId/logs */
  app.post("/:pluginId/:typeId/logs", async (c) => {
    requirePermission(c, "resources:read");
    const organizationId = c.get("organizationId");
    const pluginId = c.req.param("pluginId");
    const resourceTypeId = c.req.param("typeId");
    const { accountId, resourceId, parentResourceId, tailLines, container, previous } =
      await c.req.json<{
        accountId: string;
        resourceId: string;
        parentResourceId?: string;
        tailLines?: number;
        container?: string;
        previous?: boolean;
      }>();
    const ctx = await getClientForResource(pluginId, accountId, organizationId, parentResourceId);
    if (!ctx) {
      return c.json({ error: "Account or peer resource not found" }, 404);
    }
    if (!ctx.client.getLogs) {
      return c.json({ error: "Plugin does not support logs" }, 400);
    }

    const result = await ctx.client.getLogs(resourceTypeId, resourceId, accountId, {
      ...(tailLines !== undefined ? { tailLines } : {}),
      ...(container !== undefined ? { container } : {}),
      ...(previous !== undefined ? { previous } : {}),
    });
    return c.json(result);
  });
}

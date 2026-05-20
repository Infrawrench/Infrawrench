import type { Hono } from "hono";
import {
  getClientForAccount,
  getClientForResource,
  buildPeerPanes,
  filterVisiblePeerIntegrations,
} from "../../../services/plugin-clients";
import { getMetricRange } from "@infrawrench/server-core/clickhouse/readers";
import { requirePermission } from "../../../auth/permissions";

/**
 * Cross-cutting per-resource action routes:
 *
 * - invoke-action / nosql-command / attach / export-credential — RPC-style
 *   handlers that dispatch to optional plugin client methods.
 * - peer-panes — lazily fetched secondary tabs.
 * - metrics — historical time-series read from ClickHouse.
 */
export function registerActionRoutes(app: Hono): void {
  /** POST /api/resources/invoke-action — invoke a plugin-defined action against a resource. */
  app.post("/invoke-action", async (c) => {
    requirePermission(c, "resources:write");
    const organizationId = c.get("organizationId");
    const input = await c.req.json<{
      pluginId: string;
      accountId: string;
      resourceTypeId: string;
      resourceId: string;
      actionId: string;
      parentResourceId?: string;
    }>();
    const ctx = await getClientForResource(
      input.pluginId,
      input.accountId,
      organizationId,
      input.parentResourceId,
    );
    if (!ctx) return c.json({ error: "Account not found" }, 404);
    if (!ctx.client.invokeAction) {
      return c.json({ error: "Plugin does not support custom actions" }, 400);
    }
    try {
      await ctx.client.invokeAction(
        input.resourceTypeId,
        input.resourceId,
        input.actionId,
        input.accountId,
      );
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : "Action failed" }, 400);
    }
    return c.json({ ok: true });
  });

  /** POST /api/resources/nosql-command — run a NoSQL document-browser command against a resource. */
  app.post("/nosql-command", async (c) => {
    requirePermission(c, "resources:execute");
    const organizationId = c.get("organizationId");
    const input = await c.req.json<{
      pluginId: string;
      accountId: string;
      resourceTypeId: string;
      resourceId: string;
      command: string;
      args: (string | number)[];
      parentResourceId?: string;
    }>();
    const ctx = await getClientForResource(
      input.pluginId,
      input.accountId,
      organizationId,
      input.parentResourceId,
    );
    if (!ctx) return c.json({ error: "Account not found" }, 404);
    if (!ctx.client.executeNoSqlCommand) {
      return c.json({ error: "Plugin does not support NoSQL commands" }, 400);
    }
    try {
      const result = await ctx.client.executeNoSqlCommand(
        input.resourceTypeId,
        input.resourceId,
        input.accountId,
        input.command,
        input.args ?? [],
      );
      return c.json({ result });
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : "Command failed" }, 400);
    }
  });

  /** POST /api/resources/attach — attach a resource onto a same-account target (e.g. disk → VM). */
  app.post("/attach", async (c) => {
    requirePermission(c, "resources:write");
    const organizationId = c.get("organizationId");
    const input = await c.req.json<{
      pluginId: string;
      accountId: string;
      sourceTypeId: string;
      sourceResourceId: string;
      targetTypeId: string;
      targetResourceId: string;
    }>();

    const ctx = await getClientForResource(input.pluginId, input.accountId, organizationId);
    if (!ctx) return c.json({ error: "Account not found" }, 404);
    if (!ctx.client.attachResource) {
      return c.json({ error: "Plugin does not support attach" }, 400);
    }
    try {
      await ctx.client.attachResource(
        input.sourceTypeId,
        input.sourceResourceId,
        input.targetTypeId,
        input.targetResourceId,
        input.accountId,
      );
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : "Attach failed" }, 400);
    }
    return c.json({ ok: true });
  });

  /** POST /api/resources/:pluginId/:typeId/export-credential */
  app.post("/:pluginId/:typeId/export-credential", async (c) => {
    requirePermission(c, "secrets:read");
    const organizationId = c.get("organizationId");
    const pluginId = c.req.param("pluginId");
    const resourceTypeId = c.req.param("typeId");
    const input = await c.req.json<{
      resourceId: string;
      accountId: string;
      formatId: string;
      parentResourceId?: string;
    }>();
    if (!input.resourceId || !input.accountId || !input.formatId) {
      return c.json({ error: "Missing resourceId, accountId, or formatId" }, 400);
    }
    const ctx = await getClientForResource(
      pluginId,
      input.accountId,
      organizationId,
      input.parentResourceId,
    );
    if (!ctx) return c.json({ error: "Account or peer resource not found" }, 404);
    if (!ctx.client.exportCredential) {
      return c.json({ error: "Plugin does not support credential export" }, 400);
    }
    try {
      const result = await ctx.client.exportCredential(
        resourceTypeId,
        input.resourceId,
        input.accountId,
        input.formatId,
      );
      return c.json(result);
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : "Credential export failed" }, 400);
    }
  });

  /** POST /api/resources/:pluginId/:typeId/peer-panes */
  app.post("/:pluginId/:typeId/peer-panes", async (c) => {
    requirePermission(c, "resources:read");
    const organizationId = c.get("organizationId");
    const pluginId = c.req.param("pluginId");
    const resourceTypeId = c.req.param("typeId");
    const { accountId, resourceId, parentResourceId } = await c.req.json<{
      accountId: string;
      resourceId: string;
      parentResourceId?: string;
    }>();

    const ctx = parentResourceId
      ? await getClientForResource(pluginId, accountId, organizationId, parentResourceId)
      : await getClientForAccount(accountId, organizationId);
    if (!ctx) return c.json({ error: "Account not found" }, 404);

    const resourceTypeDef = ctx.plugin.resourceTypes.find((t) => t.id === resourceTypeId);
    if (!resourceTypeDef?.peerIntegrations?.length) return c.json([]);

    // Apply the same requiresFields/showWhen filter the eager /detail route
    // uses, so we never surface peer tabs that the detail payload hid.
    const parentResource = await ctx.client
      .getResource(resourceTypeId, resourceId, accountId)
      .catch(() => null);
    const visibleIntegrations = filterVisiblePeerIntegrations(
      resourceTypeDef.peerIntegrations,
      parentResource?.fields,
    );
    if (!visibleIntegrations.length) return c.json([]);

    const panes = await buildPeerPanes(
      ctx.client,
      ctx.plugin,
      visibleIntegrations,
      resourceTypeId,
      resourceId,
      accountId,
      organizationId,
    );

    return c.json(panes);
  });

  /**
   * POST /api/resources/:pluginId/:typeId/metrics
   *
   * Returns historical metric series for a resource. Data is sourced from
   * ClickHouse (written by the poller). Only resources pinned on some dashboard
   * accumulate points; unpinned resources will return an empty series array.
   */
  app.post("/:pluginId/:typeId/metrics", async (c) => {
    requirePermission(c, "resources:read");
    const organizationId = c.get("organizationId");
    const { resourceId, startMs, endMs } = await c.req.json<{
      accountId: string;
      resourceId: string;
      startMs?: number;
      endMs?: number;
      parentResourceId?: string;
    }>();

    const toMs = endMs ?? Date.now();
    const fromMs = startMs ?? toMs - 60 * 60 * 1000;
    const series = await getMetricRange(organizationId, resourceId, fromMs, toMs);
    return c.json({ series });
  });
}

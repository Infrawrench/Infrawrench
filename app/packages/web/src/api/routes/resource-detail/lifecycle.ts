import type { Hono } from "hono";
import { v4 as uuidv4 } from "uuid";
import { db } from "../../../db/client";
import { resources, secretFieldStates } from "../../../db/schema";
import { getClientForAccount, getClientForResource } from "../../../services/plugin-clients";
import { encrypt, buildAad } from "../../../services/encryption";
import { normalizeResourceCreateResult } from "@infrawrench/plugin-base";
import { requirePermission } from "../../../auth/permissions";

/**
 * Lifecycle routes: create / delete / picker-resources / field-action /
 * create-config / create-pricing / create-cost-estimate.
 *
 * These cover the resource-creation form's needs (option lookups, pricing
 * estimates, action buttons) plus the create + delete endpoints. The create
 * handler also persists the new row to Postgres and encrypts any
 * plaintext secrets the plugin returned.
 */
export function registerLifecycleRoutes(app: Hono): void {
  /** DELETE /api/resources/:pluginId/:typeId?resourceId=...&accountId=...&parentResourceId=... */
  app.delete("/:pluginId/:typeId", async (c) => {
    requirePermission(c, "resources:delete");
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
    if (!ctx.client.deleteResource)
      return c.json({ error: "Plugin does not support deletion" }, 400);

    await ctx.client.deleteResource(resourceTypeId, resourceId, accountId);
    return c.json({ ok: true });
  });

  /** POST /api/resources/create */
  app.post("/create", async (c) => {
    requirePermission(c, "resources:write");
    const organizationId = c.get("organizationId");
    const input = await c.req.json<{
      accountId: string;
      pluginId: string;
      resourceTypeId: string;
      fields: Record<string, string>;
      parentResourceId?: string;
    }>();

    const ctx = await getClientForResource(
      input.pluginId,
      input.accountId,
      organizationId,
      input.parentResourceId,
    );
    if (!ctx) return c.json({ error: "Account or peer resource not found" }, 404);
    if (!ctx.client.createResource)
      return c.json({ error: "Plugin does not support creation" }, 400);

    let createReturn;
    try {
      createReturn = await ctx.client.createResource(
        input.resourceTypeId,
        input.accountId,
        input.fields,
        input.parentResourceId,
      );
    } catch (e) {
      const message = e instanceof Error ? e.message : "Resource creation failed";
      return c.json({ error: message }, 400);
    }

    const { resource: created, warnings } = normalizeResourceCreateResult(createReturn);

    // Persist top-level (non-peer) resources to DB so the detail page can find
    // them without waiting for the next sync. Peer resources (e.g. k8s-pod on
    // a gcloud account) are not stored here since they aren't owned by the
    // account's native plugin.
    if (ctx.account.pluginId === input.pluginId) {
      // The resource row itself is non-critical: if the insert fails, the
      // detail page falls back to listResources. Log so regressions are
      // visible.
      try {
        await db
          .insert(resources)
          .values({
            id: created.id,
            organizationId,
            pluginId: input.pluginId,
            resourceTypeId: input.resourceTypeId,
            accountId: input.accountId,
            displayName: created.displayName,
            externalId: created.externalId ?? null,
            fieldsJson: created.fields ?? {},
            outputsJson: created.resolvedOutputs ?? {},
            parentResourceId: created.parentResourceId ?? null,
          })
          .onConflictDoUpdate({
            target: resources.id,
            set: {
              displayName: created.displayName,
              fieldsJson: created.fields ?? {},
              outputsJson: created.resolvedOutputs ?? {},
              deletedAt: null,
              updatedAt: new Date(),
            },
          });
      } catch (err) {
        console.error("[resource-detail] Failed to persist newly created resource:", err);
      }

      // Secret persistence is critical: plaintext create-time secrets only
      // exist in this response and can't be reconstructed by listResources.
      // If any write fails, surface the error so the caller knows the
      // resource was created upstream but its credentials weren't stored.
      try {
        for (const state of created.secretStates ?? []) {
          if (state.resolution.kind !== "plaintext") continue;
          const { ciphertext, iv } = await encrypt(
            state.resolution.value,
            buildAad("secretField", `${created.id}:${state.fieldKey}`, "value"),
          );
          await db
            .insert(secretFieldStates)
            .values({
              id: uuidv4(),
              resourceId: created.id,
              fieldKey: state.fieldKey,
              resolutionKind: "literal",
              encryptedValue: ciphertext,
              valueIv: iv,
            })
            .onConflictDoUpdate({
              target: [secretFieldStates.resourceId, secretFieldStates.fieldKey],
              set: {
                resolutionKind: "literal",
                encryptedValue: ciphertext,
                valueIv: iv,
                sourcePluginId: null,
                sourceResourceTypeId: null,
                sourceResourceId: null,
                sourceAccountId: null,
                sourceOutputKey: null,
                cachedEncryptedValue: null,
                cachedValueIv: null,
                cachedAt: null,
                updatedAt: new Date(),
              },
            });
        }
      } catch (err) {
        console.error(
          "[resource-detail] Failed to persist secret state for created resource:",
          err,
        );
        const detail = err instanceof Error ? err.message : "unknown error";
        return c.json(
          {
            error:
              `Resource ${created.displayName} was created but its credentials could not be stored (${detail}). ` +
              `Delete the resource and retry, or set the missing fields manually.`,
          },
          500,
        );
      }
    }

    return c.json({ id: created.id, displayName: created.displayName, warnings });
  });

  /** POST /api/resources/create-config */
  app.post("/create-config", async (c) => {
    requirePermission(c, "resources:write");
    const organizationId = c.get("organizationId");
    const input = await c.req.json<{
      accountId: string;
      resourceTypeId: string;
      pluginId?: string;
      parentResourceId?: string;
    }>();

    const ctx = input.pluginId
      ? await getClientForResource(
          input.pluginId,
          input.accountId,
          organizationId,
          input.parentResourceId,
        )
      : await getClientForAccount(input.accountId, organizationId);
    if (!ctx) return c.json({ error: "Account or peer resource not found" }, 404);
    if (!ctx.client.getCreateConfig)
      return c.json({ error: "Plugin does not support dynamic create config" }, 400);

    const config = await ctx.client.getCreateConfig(input.resourceTypeId, input.parentResourceId);
    return c.json(config);
  });

  /** POST /api/resources/picker-resources — get resources for resource-picker field */
  app.post("/picker-resources", async (c) => {
    requirePermission(c, "resources:read");
    const organizationId = c.get("organizationId");
    const input = await c.req.json<{
      sources: Array<{ pluginId: string; resourceTypeId: string; outputKey: string }>;
      accountId: string;
      regionHint?: string;
    }>();

    const results: Array<{
      id: string;
      label: string;
      pluginId: string;
      resourceTypeId: string;
      accountId: string;
      outputKey: string;
      outputValue: string;
    }> = [];

    for (const source of input.sources) {
      try {
        const ctx = await getClientForAccount(input.accountId, organizationId);
        if (!ctx || ctx.plugin.manifest.id !== source.pluginId) continue;

        const resources = await ctx.client.listResources(
          source.resourceTypeId,
          input.accountId,
          input.regionHint ? { regionHint: input.regionHint } : undefined,
        );
        for (const resource of resources) {
          try {
            // Prefer the value the lister already populated — avoids an N+1
            // re-list when resolveOutput would just re-fetch the same data.
            const preResolved = resource.resolvedOutputs[source.outputKey];
            const outputValue =
              preResolved != null && String(preResolved) !== ""
                ? String(preResolved)
                : await ctx.client.resolveOutput(
                    source.resourceTypeId,
                    resource.id,
                    source.outputKey,
                    input.accountId,
                  );
            results.push({
              id: resource.id,
              label: resource.displayName,
              pluginId: source.pluginId,
              resourceTypeId: source.resourceTypeId,
              accountId: input.accountId,
              outputKey: source.outputKey,
              outputValue,
            });
          } catch {
            // Skip resources where output can't be resolved
          }
        }
      } catch {
        // Skip sources that fail
      }
    }

    return c.json(results);
  });

  /** POST /api/resources/create-pricing — get size pricing for create form */
  app.post("/create-pricing", async (c) => {
    requirePermission(c, "resources:read");
    const organizationId = c.get("organizationId");
    const input = await c.req.json<{
      accountId: string;
      resourceTypeId: string;
      regionId?: string;
      sizes: Array<{ id: string; vcpus: number; memoryMb: number }>;
      pluginId?: string;
      parentResourceId?: string;
    }>();

    const ctx = input.pluginId
      ? await getClientForResource(
          input.pluginId,
          input.accountId,
          organizationId,
          input.parentResourceId,
        )
      : await getClientForAccount(input.accountId, organizationId);
    if (!ctx) return c.json({ error: "Account or peer resource not found" }, 404);
    if (!ctx.client.getCreateSizePricing) return c.json({});

    const pricing = await ctx.client.getCreateSizePricing(input.resourceTypeId, {
      ...(input.regionId ? { regionId: input.regionId } : {}),
      sizes: input.sizes,
    });
    return c.json(pricing ?? {});
  });

  /** POST /api/resources/field-action — execute an in-form field action (e.g. mint an IAM role) */
  app.post("/field-action", async (c) => {
    requirePermission(c, "resources:write");
    const organizationId = c.get("organizationId");
    const input = await c.req.json<{
      accountId: string;
      resourceTypeId: string;
      fieldKey: string;
      actionId: string;
      fields: Record<string, string>;
      actionFields?: Record<string, string>;
      pluginId?: string;
      parentResourceId?: string;
    }>();

    const ctx = input.pluginId
      ? await getClientForResource(
          input.pluginId,
          input.accountId,
          organizationId,
          input.parentResourceId,
        )
      : await getClientForAccount(input.accountId, organizationId);
    if (!ctx) return c.json({ error: "Account or peer resource not found" }, 404);
    if (!ctx.client.executeFieldAction) {
      return c.json({ error: "Plugin does not support field actions" }, 400);
    }

    const result = await ctx.client.executeFieldAction(
      input.resourceTypeId,
      input.fieldKey,
      input.actionId,
      input.accountId,
      input.fields,
      input.actionFields,
    );
    return c.json(result);
  });

  /** POST /api/resources/create-cost-estimate — get cost estimate for create form */
  app.post("/create-cost-estimate", async (c) => {
    requirePermission(c, "resources:read");
    const organizationId = c.get("organizationId");
    const input = await c.req.json<{
      accountId: string;
      resourceTypeId: string;
      fields: Record<string, string>;
      pluginId?: string;
      parentResourceId?: string;
    }>();

    const ctx = input.pluginId
      ? await getClientForResource(
          input.pluginId,
          input.accountId,
          organizationId,
          input.parentResourceId,
        )
      : await getClientForAccount(input.accountId, organizationId);
    if (!ctx) return c.json({ error: "Account or peer resource not found" }, 404);
    if (!ctx.client.getCreateCostEstimate) return c.json({ estimate: null });

    const estimate = await ctx.client.getCreateCostEstimate(input.resourceTypeId, input.fields);
    return c.json({ estimate: estimate ?? null });
  });
}

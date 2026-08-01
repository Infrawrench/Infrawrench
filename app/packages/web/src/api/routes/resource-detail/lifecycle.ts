import type { Hono } from "hono";
import { v4 as uuidv4 } from "uuid";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "../../../db/client";
import { accounts, associations, resources } from "../../../db/schema";
import { getClientForAccount, getClientForResource } from "../../../services/plugin-clients";
import { encrypt, decrypt, buildAad } from "../../../services/encryption";
import {
  setLiteralSecretState,
  setOutputRefSecretState,
} from "@infrawrench/server-core/secret-states";
import { upsertCreatedResource } from "@infrawrench/server-core/created-resource";
import { normalizeResourceCreateResult, parseOutputRef } from "@infrawrench/plugin-base";
import type { OutputRefValue } from "@infrawrench/plugin-base";
import { requirePermission } from "../../../auth/permissions";
import { nextAssociationSyncVersion } from "../../../services/sync-versions";
import { checkChangeFreeze } from "../../../services/change-freezes";
import { checkTagPolicyOnCreate } from "../../../services/tag-policy";

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

    const frozen = await checkChangeFreeze(c, {
      action: "resource.delete",
      entityType: "resource",
      entityId: resourceId,
      metadata: { pluginId, resourceTypeId },
    });
    if (frozen) return frozen;

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

    // Reference-mode picker fields arrive encoded. Flatten them to the literal
    // value resolved at pick time so the plugin sees a normal string, but
    // remember the identity so we can persist a live output-ref association.
    const resolvedFields: Record<string, string> = {};
    const refFields: Array<{ fieldKey: string; ref: OutputRefValue }> = [];
    for (const [fieldKey, value] of Object.entries(input.fields)) {
      const ref = typeof value === "string" ? parseOutputRef(value) : null;
      if (ref) {
        resolvedFields[fieldKey] = ref.value;
        refFields.push({ fieldKey, ref });
      } else {
        resolvedFields[fieldKey] = value;
      }
    }

    // Org tag policy: refuse creates missing required tags (422, code
    // `tag_policy_unmet`) the same way the change freeze refuses destructive
    // mutations. Types that cannot carry tags are exempt inside the check.
    const policyBlock = await checkTagPolicyOnCreate(c, {
      client: ctx.client,
      pluginId: input.pluginId,
      resourceTypeId: input.resourceTypeId,
      accountId: input.accountId,
      parentResourceId: input.parentResourceId,
      fields: resolvedFields,
    });
    if (policyBlock) return policyBlock;

    let createReturn;
    try {
      createReturn = await ctx.client.createResource(
        input.resourceTypeId,
        input.accountId,
        resolvedFields,
        input.parentResourceId,
      );
    } catch (e) {
      const message = e instanceof Error ? e.message : "Resource creation failed";
      return c.json({ error: message }, 400);
    }

    const {
      resource: created,
      warnings,
      credentialUpdates,
    } = normalizeResourceCreateResult(createReturn);

    // If the plugin minted sidecar credentials during creation (e.g. DO
    // auto-generating Spaces S3 keys on first bucket-create), merge them
    // into the account's encrypted credentials row. We do this before
    // persisting the resource so the next ctx fetch for this account sees
    // the new keys. A failure here is non-fatal: the resource still got
    // created upstream and the user can edit the account to paste the
    // keys manually.
    if (credentialUpdates && Object.keys(credentialUpdates).length > 0) {
      try {
        const [acct] = await db
          .select()
          .from(accounts)
          .where(
            and(eq(accounts.id, input.accountId), eq(accounts.organizationId, organizationId)),
          );
        if (acct) {
          const aad = buildAad("account", acct.id, "credentials");
          const plaintext = await decrypt(acct.encryptedCredentials, acct.credentialsIv, aad);
          const existing = JSON.parse(plaintext) as Record<string, string>;
          const merged = { ...existing, ...credentialUpdates };
          const { ciphertext, iv } = await encrypt(JSON.stringify(merged), aad);
          await db
            .update(accounts)
            .set({ encryptedCredentials: ciphertext, credentialsIv: iv, updatedAt: new Date() })
            .where(eq(accounts.id, acct.id));
        }
      } catch (err) {
        console.error("[resource-detail] Failed to persist auto-minted credentials:", err);
        warnings.push({
          code: "do.credential-persist-failed",
          message: `Couldn't save auto-generated account credentials: ${err instanceof Error ? err.message : String(err)}. Edit the account to add them manually.`,
        });
      }
    }

    // Persist top-level (non-peer) resources to DB so the detail page can find
    // them without waiting for the next sync. Peer resources (e.g. k8s-pod on
    // a gcloud account) are not stored here since they aren't owned by the
    // account's native plugin.
    if (ctx.account.pluginId === input.pluginId) {
      // The resource row itself is non-critical: if the insert fails, the
      // detail page falls back to listResources. Log so regressions are
      // visible.
      try {
        await upsertCreatedResource({
          organizationId,
          pluginId: input.pluginId,
          resourceTypeId: input.resourceTypeId,
          accountId: input.accountId,
          resource: created,
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
          await setLiteralSecretState(created.id, state.fieldKey, state.resolution.value);
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

      // Persist live output references for picker-in-reference-mode fields. The
      // secret_field_states row is the source of truth the reconciler reads;
      // the associations row is best-effort topology (its provider FK can fail
      // if the source resource hasn't been synced into this org yet).
      for (const { fieldKey, ref } of refFields) {
        try {
          await setOutputRefSecretState(
            created.id,
            fieldKey,
            {
              pluginId: ref.pluginId,
              resourceTypeId: ref.resourceTypeId,
              resourceId: ref.resourceId,
              accountId: ref.accountId,
              outputKey: ref.outputKey,
            },
            ref.value,
          );
          // Best-effort topology row — provider FK may not exist yet.
          try {
            await db
              .insert(associations)
              .values({
                id: uuidv4(),
                consumerResourceId: created.id,
                consumerFieldKey: fieldKey,
                providerResourceId: ref.resourceId,
                providerOutputKey: ref.outputKey,
                syncVersion: nextAssociationSyncVersion(organizationId),
              })
              .onConflictDoUpdate({
                target: [associations.consumerResourceId, associations.consumerFieldKey],
                set: {
                  providerResourceId: ref.resourceId,
                  providerOutputKey: ref.outputKey,
                  syncVersion: nextAssociationSyncVersion(organizationId),
                  updatedAt: new Date(),
                },
              });
          } catch (assocErr) {
            console.warn(
              "[resource-detail] Skipped association topology row (provider not yet synced):",
              assocErr instanceof Error ? assocErr.message : assocErr,
            );
          }
        } catch (err) {
          console.error("[resource-detail] Failed to persist output reference:", err);
        }
      }
    }

    return c.json({ id: created.id, displayName: created.displayName, warnings });
  });

  /** POST /api/resources/update */
  app.post("/update", async (c) => {
    requirePermission(c, "resources:write");
    const organizationId = c.get("organizationId");
    const input = await c.req.json<{
      accountId: string;
      pluginId: string;
      resourceTypeId: string;
      resourceId: string;
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
    if (!ctx.client.updateResource)
      return c.json({ error: "Plugin does not support updates" }, 400);

    let updated;
    try {
      updated = await ctx.client.updateResource(
        input.resourceTypeId,
        input.resourceId,
        input.accountId,
        input.fields,
      );
    } catch (e) {
      const message = e instanceof Error ? e.message : "Resource update failed";
      return c.json({ error: message }, 400);
    }

    // Mirror the refreshed fields/displayName into the DB so the next page
    // load sees the new values without waiting for a sync cycle. Peer-managed
    // resources skip this — they aren't owned by the account's native plugin.
    if (ctx.account.pluginId === input.pluginId) {
      try {
        await db
          .update(resources)
          .set({
            displayName: updated.displayName,
            fieldsJson: updated.fields ?? {},
            outputsJson: updated.resolvedOutputs ?? {},
            updatedAt: new Date(),
          })
          .where(eq(resources.id, input.resourceId));
      } catch (err) {
        console.error("[resource-detail] Failed to persist updated resource:", err);
      }
    }

    return c.json({
      id: updated.id,
      displayName: updated.displayName,
      fields: updated.fields ?? {},
    });
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
      /**
       * When true, search every account in the org whose plugin matches a
       * source — used by reference-mode pickers (e.g. DNS content) where the
       * target resource usually lives in a different account/provider.
       */
      crossAccount?: boolean;
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

    // Resolve the set of (accountId) to search per source. Single-account mode
    // only ever uses the creating account; cross-account mode fans out to all
    // org accounts whose pluginId matches the source.
    let accountsByPlugin: Map<string, string[]> | null = null;
    const accountNames = new Map<string, string>();
    if (input.crossAccount) {
      accountsByPlugin = new Map();
      const rows = await db
        .select({ id: accounts.id, pluginId: accounts.pluginId, displayName: accounts.displayName })
        .from(accounts)
        .where(and(eq(accounts.organizationId, organizationId), isNull(accounts.deletedAt)));
      for (const row of rows) {
        const list = accountsByPlugin.get(row.pluginId) ?? [];
        list.push(row.id);
        accountsByPlugin.set(row.pluginId, list);
        accountNames.set(row.id, row.displayName);
      }
    }

    for (const source of input.sources) {
      const targetAccountIds = accountsByPlugin
        ? (accountsByPlugin.get(source.pluginId) ?? [])
        : [input.accountId];

      for (const acctId of targetAccountIds) {
        try {
          const ctx = await getClientForAccount(acctId, organizationId);
          if (!ctx || ctx.plugin.manifest.id !== source.pluginId) continue;

          const resources = await ctx.client.listResources(
            source.resourceTypeId,
            acctId,
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
                      acctId,
                    );
              if (!outputValue) continue;
              results.push({
                id: resource.id,
                label: accountsByPlugin
                  ? `${resource.displayName} · ${accountNames.get(acctId) ?? acctId}`
                  : resource.displayName,
                pluginId: source.pluginId,
                resourceTypeId: source.resourceTypeId,
                accountId: acctId,
                outputKey: source.outputKey,
                outputValue,
              });
            } catch {
              // Skip resources where output can't be resolved
            }
          }
        } catch {
          // Skip accounts/sources that fail
        }
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

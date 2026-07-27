/**
 * Persisting a resource that was just created upstream.
 *
 * Four flows create resources — the REST create route, the two agent-tool
 * create paths, and agent-VM provisioning — and each has to land a `resources`
 * row immediately so the detail page can find the resource before the next
 * sync. They all wrote the same upsert by hand, which is how one of them ended
 * up not refreshing `external_id` on conflict.
 *
 * This is deliberately *not* `sync-resources.ts`'s `upsertResource`: that one
 * merges JSON columns and bumps `sync_version` because a lister's view of a
 * resource is partial. A create response is authoritative, so it overwrites.
 */
import type { ResourceInstance } from "@infrawrench/plugin-base";
import { db } from "./db/client";
import { resources } from "./db/schema";

export interface UpsertCreatedResourceParams {
  organizationId: string;
  /**
   * Owning plugin / type / account. Passed explicitly rather than read off the
   * instance: callers know which account they created against, and a plugin
   * that returns a differently-tagged instance must not silently re-home the
   * row into another account.
   */
  pluginId: string;
  resourceTypeId: string;
  accountId: string;
  resource: ResourceInstance;
}

/** Insert (or refresh) the `resources` row for a freshly created resource. */
export async function upsertCreatedResource({
  organizationId,
  pluginId,
  resourceTypeId,
  accountId,
  resource,
}: UpsertCreatedResourceParams): Promise<void> {
  const row = {
    displayName: resource.displayName,
    externalId: resource.externalId ?? null,
    fieldsJson: resource.fields ?? {},
    outputsJson: resource.resolvedOutputs ?? {},
    parentResourceId: resource.parentResourceId ?? null,
  };
  await db
    .insert(resources)
    .values({
      id: resource.id,
      organizationId,
      pluginId,
      resourceTypeId,
      accountId,
      ...row,
    })
    .onConflictDoUpdate({
      target: resources.id,
      // Re-creating over a soft-deleted id revives the row.
      set: { ...row, deletedAt: null, updatedAt: new Date() },
    });
}

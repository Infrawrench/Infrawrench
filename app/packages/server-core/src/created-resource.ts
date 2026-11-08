/**
 * Persisting a resource that was just created upstream.
 *
 * Four flows create resources (the REST create route, the two agent-tool
 * create paths, and agent-VM provisioning) and each has to land a `resources`
 * row immediately so the detail page can find the resource before the next
 * sync. They all wrote the same upsert by hand, which is how one of them ended
 * up not refreshing `external_id` on conflict.
 *
 * This is deliberately *not* `sync-resources.ts`'s `upsertResource`: that one
 * merges JSON columns and bumps `sync_version` because a lister's view of a
 * resource is partial. A create response is authoritative, so it overwrites.
 */
import { and, eq, inArray, notExists, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { ResourceInstance } from "@infrawrench/plugin-base";
import { db, type Db } from "./db/client";
import {
  associations,
  dashboardPins,
  dashboards,
  environmentInstanceMembers,
  eventSubscriptions,
  queryMonitors,
  resourceLeases,
  resourceOwnership,
  resourceSchedules,
  resources,
  secretFieldStates,
  serviceMembers,
  slos,
  starredItems,
  syntheticProbes,
} from "./db/schema";

/** `db`, or a transaction on it. */
type Executor = Pick<Db, "insert" | "update" | "select">;

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
export async function upsertCreatedResource(
  { organizationId, pluginId, resourceTypeId, accountId, resource }: UpsertCreatedResourceParams,
  executor: Executor = db,
): Promise<void> {
  const row = {
    displayName: resource.displayName,
    externalId: resource.externalId ?? null,
    fieldsJson: resource.fields ?? {},
    outputsJson: resource.resolvedOutputs ?? {},
    parentResourceId: resource.parentResourceId ?? null,
  };
  await executor
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

/**
 * Where an edit answered with a different id, as a provider that makes each edit a new
 * version does: the new id gets the row, and the old one is soft deleted. A sync revives
 * it if the provider still lists it. Writing the new fields under the old id would have
 * the next edit, sent to that id, build on the old version and drop this one.
 *
 * What people attached to the resource follows it to the new id (see
 * `carryResourceReferences`); the record of what happened to the old id stays with it.
 *
 * Stored secrets stay with the old id, because they are encrypted against it. A plugin
 * whose edits change the id and which keeps a secret copies it with `setPlaintext`. The
 * same holds for the output references this resource's own fields resolve from: their
 * cached values are encrypted against the old id too.
 */
export async function supersedeResource({
  previousId,
  ...created
}: UpsertCreatedResourceParams & { previousId: string }): Promise<void> {
  await db.transaction(async (tx) => {
    await upsertCreatedResource(created, tx);
    await tx
      .update(resources)
      .set({
        deletedAt: new Date(),
        updatedAt: new Date(),
        // As the sync's own soft delete does, so `/api/v1/sync/pull` hands the delete on.
        syncVersion: sql<number>`COALESCE((SELECT MAX(sync_version) FROM resources WHERE organization_id = ${created.organizationId}), 0) + 1`,
      })
      .where(
        and(
          eq(resources.id, previousId),
          eq(resources.organizationId, created.organizationId),
          eq(resources.accountId, created.accountId),
        ),
      );
    await carryResourceReferences(tx, {
      organizationId: created.organizationId,
      previousId,
      nextId: created.resource.id,
      displayName: created.resource.displayName,
    });
  });
}

/**
 * Point what people attached to a resource at the id it now goes by. The rule: a
 * reference that says what the resource is to someone moves (a dashboard pin, a star,
 * its owner and purpose, its service, a schedule or lease that acts on it, an environment
 * that tears it down, a probe, SLO, query monitor or event subscription aimed at it, and
 * the output references other resources resolve from it). A record of what happened
 * stays with the id it happened to: its change timeline, alert events, savings, session
 * recordings, deploy events, findings and dismissals, and the audit log. A dismissed
 * finding stays because the new version is a new configuration, to be judged afresh.
 *
 * Where the new id already has its own row of a one-per-resource kind (a pin on the same
 * dashboard, the same member's star), that one wins and the old one stays where it was.
 *
 * `previousId` and `nextId` are resource ids, which are unique across organizations
 * because they carry their account's id; tables with an organization column are scoped
 * by it as well.
 */
export async function carryResourceReferences(
  executor: Executor,
  {
    organizationId,
    previousId,
    nextId,
    displayName,
  }: { organizationId: string; previousId: string; nextId: string; displayName: string },
): Promise<void> {
  if (previousId === nextId) return;

  const otherPin = alias(dashboardPins, "other_pin");
  await executor
    .update(dashboardPins)
    .set({ resourceId: nextId })
    .where(
      and(
        eq(dashboardPins.resourceId, previousId),
        inArray(
          dashboardPins.dashboardId,
          executor
            .select({ id: dashboards.id })
            .from(dashboards)
            .where(eq(dashboards.organizationId, organizationId)),
        ),
        notExists(
          executor
            .select({ id: otherPin.id })
            .from(otherPin)
            .where(
              and(
                eq(otherPin.dashboardId, dashboardPins.dashboardId),
                eq(otherPin.resourceId, nextId),
              ),
            ),
        ),
      ),
    );

  const otherStar = alias(starredItems, "other_star");
  await executor
    .update(starredItems)
    .set({ objectId: nextId })
    .where(
      and(
        eq(starredItems.organizationId, organizationId),
        eq(starredItems.kind, "resource"),
        eq(starredItems.objectId, previousId),
        notExists(
          executor
            .select({ id: otherStar.id })
            .from(otherStar)
            .where(
              and(
                eq(otherStar.organizationId, organizationId),
                eq(otherStar.userId, starredItems.userId),
                eq(otherStar.kind, "resource"),
                eq(otherStar.objectId, nextId),
              ),
            ),
        ),
      ),
    );

  const otherMember = alias(serviceMembers, "other_member");
  await executor
    .update(serviceMembers)
    .set({ resourceId: nextId, resourceName: displayName })
    .where(
      and(
        eq(serviceMembers.organizationId, organizationId),
        eq(serviceMembers.resourceId, previousId),
        notExists(
          executor
            .select({ id: otherMember.id })
            .from(otherMember)
            .where(
              and(
                eq(otherMember.serviceId, serviceMembers.serviceId),
                eq(otherMember.resourceId, nextId),
              ),
            ),
        ),
      ),
    );

  // One per resource in the organization: moved only when the new id has none.
  const otherOwnership = alias(resourceOwnership, "other_ownership");
  await executor
    .update(resourceOwnership)
    .set({ resourceId: nextId, resourceName: displayName, updatedAt: new Date() })
    .where(
      and(
        eq(resourceOwnership.organizationId, organizationId),
        eq(resourceOwnership.resourceId, previousId),
        notExists(
          executor
            .select({ id: otherOwnership.id })
            .from(otherOwnership)
            .where(
              and(
                eq(otherOwnership.organizationId, organizationId),
                eq(otherOwnership.resourceId, nextId),
              ),
            ),
        ),
      ),
    );

  const otherSchedule = alias(resourceSchedules, "other_schedule");
  await executor
    .update(resourceSchedules)
    .set({ resourceId: nextId })
    .where(
      and(
        eq(resourceSchedules.organizationId, organizationId),
        eq(resourceSchedules.resourceId, previousId),
        notExists(
          executor
            .select({ id: otherSchedule.id })
            .from(otherSchedule)
            .where(
              and(
                eq(otherSchedule.organizationId, organizationId),
                eq(otherSchedule.resourceId, nextId),
              ),
            ),
        ),
      ),
    );

  const otherLease = alias(resourceLeases, "other_lease");
  await executor
    .update(resourceLeases)
    .set({ resourceId: nextId })
    .where(
      and(
        eq(resourceLeases.organizationId, organizationId),
        eq(resourceLeases.resourceId, previousId),
        notExists(
          executor
            .select({ id: otherLease.id })
            .from(otherLease)
            .where(
              and(eq(otherLease.organizationId, organizationId), eq(otherLease.resourceId, nextId)),
            ),
        ),
      ),
    );

  // Any number per resource.
  await executor
    .update(environmentInstanceMembers)
    .set({ resourceId: nextId, updatedAt: new Date() })
    .where(
      and(
        eq(environmentInstanceMembers.organizationId, organizationId),
        eq(environmentInstanceMembers.resourceId, previousId),
      ),
    );
  await executor
    .update(syntheticProbes)
    .set({ resourceId: nextId })
    .where(
      and(
        eq(syntheticProbes.organizationId, organizationId),
        eq(syntheticProbes.resourceId, previousId),
      ),
    );
  await executor
    .update(slos)
    .set({ resourceId: nextId, updatedAt: new Date() })
    .where(and(eq(slos.organizationId, organizationId), eq(slos.resourceId, previousId)));
  await executor
    .update(queryMonitors)
    .set({ resourceId: nextId, updatedAt: new Date() })
    .where(
      and(
        eq(queryMonitors.organizationId, organizationId),
        eq(queryMonitors.resourceId, previousId),
      ),
    );
  await executor
    .update(eventSubscriptions)
    .set({ publishResourceId: nextId, updatedAt: new Date() })
    .where(
      and(
        eq(eventSubscriptions.organizationId, organizationId),
        eq(eventSubscriptions.publishResourceId, previousId),
      ),
    );

  // Other resources' fields that resolve from this one's outputs now resolve from the
  // new version, so the next sync pushes its values to them. Neither table has an
  // organization column; the resource id is what scopes them.
  await executor
    .update(associations)
    .set({ providerResourceId: nextId, updatedAt: new Date() })
    .where(eq(associations.providerResourceId, previousId));
  await executor
    .update(secretFieldStates)
    .set({ sourceResourceId: nextId, updatedAt: new Date() })
    .where(
      and(
        eq(secretFieldStates.resolutionKind, "output-ref"),
        eq(secretFieldStates.sourceResourceId, previousId),
      ),
    );
}

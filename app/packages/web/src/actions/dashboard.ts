"use server";

import { requireAuth } from "@/auth/session";
import { db } from "@/db/client";
import { dashboards, dashboardPins, resources } from "@/db/schema";
import { eq, and, isNull, desc } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";

export async function pinResourceToDashboard(input: {
  dashboardId: string;
  resourceId: string;
  gridX?: number;
  gridY?: number;
}) {
  const { organizationId } = await requireAuth();

  // Verify dashboard and resource belong to this org
  const [dashboard] = await db
    .select({ id: dashboards.id })
    .from(dashboards)
    .where(and(eq(dashboards.id, input.dashboardId), eq(dashboards.organizationId, organizationId)))
    .limit(1);
  if (!dashboard) throw new Error("Dashboard not found");

  const [resource] = await db
    .select({ id: resources.id })
    .from(resources)
    .where(and(eq(resources.id, input.resourceId), eq(resources.organizationId, organizationId)))
    .limit(1);
  if (!resource) throw new Error("Resource not found");

  await db
    .insert(dashboardPins)
    .values({
      id: uuidv4(),
      dashboardId: input.dashboardId,
      resourceId: input.resourceId,
      gridX: input.gridX ?? 0,
      gridY: input.gridY ?? 0,
    })
    .onConflictDoNothing();
}

export async function unpinResourceFromDashboard(input: {
  dashboardId: string;
  resourceId: string;
}) {
  const { organizationId } = await requireAuth();

  const [dashboard] = await db
    .select({ id: dashboards.id })
    .from(dashboards)
    .where(and(eq(dashboards.id, input.dashboardId), eq(dashboards.organizationId, organizationId)))
    .limit(1);
  if (!dashboard) throw new Error("Dashboard not found");

  await db
    .delete(dashboardPins)
    .where(
      and(
        eq(dashboardPins.dashboardId, input.dashboardId),
        eq(dashboardPins.resourceId, input.resourceId),
      ),
    );
}

export async function createDashboard(input: { name: string }) {
  const { organizationId } = await requireAuth();

  const [created] = await db
    .insert(dashboards)
    .values({
      id: uuidv4(),
      organizationId,
      name: input.name,
      isDefault: false,
    })
    .returning();

  return created;
}

export async function listDashboards() {
  const { organizationId } = await requireAuth();

  return db
    .select({
      id: dashboards.id,
      name: dashboards.name,
      isDefault: dashboards.isDefault,
    })
    .from(dashboards)
    .where(
      and(
        eq(dashboards.organizationId, organizationId),
        isNull(dashboards.deletedAt),
      ),
    )
    .orderBy(desc(dashboards.isDefault), dashboards.createdAt);
}

export async function renameDashboard(input: { id: string; name: string }) {
  const { organizationId } = await requireAuth();

  await db
    .update(dashboards)
    .set({ name: input.name, updatedAt: new Date() })
    .where(
      and(
        eq(dashboards.id, input.id),
        eq(dashboards.organizationId, organizationId),
      ),
    );
}

export async function deleteDashboard(input: { id: string }) {
  const { organizationId } = await requireAuth();

  // Don't allow deleting the default dashboard
  const [dash] = await db
    .select({ isDefault: dashboards.isDefault })
    .from(dashboards)
    .where(
      and(
        eq(dashboards.id, input.id),
        eq(dashboards.organizationId, organizationId),
      ),
    )
    .limit(1);

  if (!dash) throw new Error("Dashboard not found");
  if (dash.isDefault) throw new Error("Cannot delete the default dashboard");

  // Delete pins first, then the dashboard
  await db
    .delete(dashboardPins)
    .where(eq(dashboardPins.dashboardId, input.id));

  await db
    .delete(dashboards)
    .where(
      and(
        eq(dashboards.id, input.id),
        eq(dashboards.organizationId, organizationId),
      ),
    );
}

export async function getDashboardWithPins(dashboardId: string) {
  const { organizationId } = await requireAuth();

  const [dashboard] = await db
    .select()
    .from(dashboards)
    .where(
      and(
        eq(dashboards.id, dashboardId),
        eq(dashboards.organizationId, organizationId),
        isNull(dashboards.deletedAt),
      ),
    )
    .limit(1);

  if (!dashboard) return null;

  const pins = await db
    .select({
      pinId: dashboardPins.id,
      resourceId: dashboardPins.resourceId,
      gridX: dashboardPins.gridX,
      gridY: dashboardPins.gridY,
      gridW: dashboardPins.gridW,
      gridH: dashboardPins.gridH,
      displayName: resources.displayName,
      pluginId: resources.pluginId,
      resourceTypeId: resources.resourceTypeId,
      accountId: resources.accountId,
      fieldsJson: resources.fieldsJson,
      outputsJson: resources.outputsJson,
    })
    .from(dashboardPins)
    .innerJoin(resources, eq(dashboardPins.resourceId, resources.id))
    .where(
      and(
        eq(dashboardPins.dashboardId, dashboardId),
        isNull(dashboardPins.deletedAt),
      ),
    );

  return { dashboard, pins };
}

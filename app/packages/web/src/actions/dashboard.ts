"use server";

import { requireAuth } from "@/auth/session";
import { db } from "@/db/client";
import { dashboards, dashboardPins, resources } from "@/db/schema";
import { eq, and } from "drizzle-orm";
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

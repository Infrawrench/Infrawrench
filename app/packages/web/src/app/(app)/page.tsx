import { requireAuth } from "@/auth/session";
import { db } from "@/db/client";
import { dashboards, dashboardPins, resources } from "@/db/schema";
import { and, eq, isNull } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import { DashboardView } from "@/components/DashboardView";

export default async function HomePage() {
  const { organizationId } = await requireAuth();

  // Find or create the default dashboard
  let [defaultDashboard] = await db
    .select()
    .from(dashboards)
    .where(
      and(
        eq(dashboards.organizationId, organizationId),
        eq(dashboards.isDefault, true),
        isNull(dashboards.deletedAt),
      ),
    )
    .limit(1);

  if (!defaultDashboard) {
    const [created] = await db
      .insert(dashboards)
      .values({
        id: uuidv4(),
        organizationId,
        name: "Home",
        isDefault: true,
      })
      .returning();
    defaultDashboard = created!;
  }

  // Fetch pinned resources
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
        eq(dashboardPins.dashboardId, defaultDashboard.id),
        isNull(dashboardPins.deletedAt),
      ),
    );

  return (
    <DashboardView
      dashboardId={defaultDashboard.id}
      dashboardName={defaultDashboard.name}
      pins={pins}
    />
  );
}

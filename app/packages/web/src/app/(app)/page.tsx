import { requireAuth } from "@/auth/session";
import { db } from "@/db/client";
import { dashboards } from "@/db/schema";
import { and, eq } from "drizzle-orm";

export default async function HomePage() {
  const { organizationId } = await requireAuth();

  // Find or create the default dashboard
  let [defaultDashboard] = await db
    .select()
    .from(dashboards)
    .where(and(eq(dashboards.organizationId, organizationId), eq(dashboards.isDefault, true)))
    .limit(1);

  if (!defaultDashboard) {
    const { v4: uuidv4 } = await import("uuid");
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

  return (
    <div className="p-6">
      <h1 className="text-2xl font-semibold mb-6">{defaultDashboard.name}</h1>
      {/* Dashboard grid — rendered by @infrawrench/ui DashboardGrid */}
      <div id="dashboard-root" data-dashboard-id={defaultDashboard.id} />
    </div>
  );
}

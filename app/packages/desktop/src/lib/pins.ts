import type { DraggableResource } from "@infrawrench/ui";
import type { DbClient } from "../db/client";

export type { DraggableResource };

export async function createDashboard(name: string, db: DbClient): Promise<string> {
  const id = crypto.randomUUID();
  await db.execute("INSERT INTO dashboards (id, name, is_default) VALUES ($1, $2, 0)", [id, name]);
  return id;
}

export async function pinResource(
  resource: DraggableResource,
  db: DbClient,
  dashboardId?: string | undefined,
): Promise<void> {
  await db.execute(
    `INSERT OR REPLACE INTO resources
     (id, plugin_id, resource_type_id, account_id, display_name, external_id, fields_json)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      resource.id,
      resource.pluginId,
      resource.resourceTypeId,
      resource.accountId,
      resource.displayName,
      resource.externalId ?? resource.id,
      JSON.stringify(resource.fields),
    ],
  );

  let dashId: string;
  if (dashboardId) {
    dashId = dashboardId;
  } else {
    const dashboards = await db.select<{ id: string }[]>(
      "SELECT id FROM dashboards WHERE is_default = 1 LIMIT 1",
    );
    if (dashboards[0]) {
      dashId = dashboards[0].id;
    } else {
      dashId = crypto.randomUUID();
      await db.execute("INSERT INTO dashboards (id, name, is_default) VALUES ($1, $2, 1)", [
        dashId,
        "Home",
      ]);
    }
  }

  // Place at the end of the grid
  const maxRows = await db.select<{ max_x: number | null }[]>(
    "SELECT MAX(grid_x) as max_x FROM dashboard_pins WHERE dashboard_id = $1",
    [dashId],
  );
  const nextX = (maxRows[0]?.max_x ?? -1) + 1;

  await db.execute(
    "INSERT OR IGNORE INTO dashboard_pins (id, dashboard_id, resource_id, grid_x) VALUES ($1, $2, $3, $4)",
    [crypto.randomUUID(), dashId, resource.id, nextX],
  );
}

/** Pin a (local) workflow onto a dashboard so its metrics render as a card. */
export async function pinWorkflow(
  workflowId: string,
  dashboardId: string,
  db: DbClient,
): Promise<void> {
  const maxRows = await db.select<{ max_x: number | null }[]>(
    "SELECT MAX(grid_x) as max_x FROM dashboard_workflow_pins WHERE dashboard_id = $1",
    [dashboardId],
  );
  const nextX = (maxRows[0]?.max_x ?? -1) + 1;
  await db.execute(
    "INSERT OR IGNORE INTO dashboard_workflow_pins (id, dashboard_id, workflow_id, grid_x) VALUES ($1, $2, $3, $4)",
    [crypto.randomUUID(), dashboardId, workflowId, nextX],
  );
}

export async function unpinWorkflow(
  workflowId: string,
  dashboardId: string,
  db: DbClient,
): Promise<void> {
  await db.execute(
    "DELETE FROM dashboard_workflow_pins WHERE dashboard_id = $1 AND workflow_id = $2",
    [dashboardId, workflowId],
  );
}

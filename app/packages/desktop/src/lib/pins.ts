import Database from "@tauri-apps/plugin-sql";

export interface DraggableResource {
  id: string;
  pluginId: string;
  resourceTypeId: string;
  accountId: string;
  displayName: string;
  fields: Record<string, unknown>;
  externalId?: string | undefined;
}

export const DRAG_MIME = "application/x-infrawrench-resource";

// WebKit (Tauri/macOS) silently returns "" for custom MIME types in getData().
// Always write text/plain too, and read text/plain on drop.
export function setDragData(e: React.DragEvent, resource: DraggableResource): void {
  const json = JSON.stringify(resource);
  e.dataTransfer.setData(DRAG_MIME, json);
  e.dataTransfer.setData("text/plain", json);
  e.dataTransfer.effectAllowed = "copy";
}

export function getDragData(e: React.DragEvent): DraggableResource | null {
  const raw = e.dataTransfer.getData(DRAG_MIME) || e.dataTransfer.getData("text/plain");
  if (!raw) return null;
  try { return JSON.parse(raw) as DraggableResource; }
  catch { return null; }
}

export async function createDashboard(name: string, db: Database): Promise<string> {
  const id = crypto.randomUUID();
  await db.execute(
    "INSERT INTO dashboards (id, name, is_default) VALUES ($1, $2, 0)",
    [id, name],
  );
  return id;
}

export async function pinResource(
  resource: DraggableResource,
  db: Database,
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
      await db.execute(
        "INSERT INTO dashboards (id, name, is_default) VALUES ($1, $2, 1)",
        [dashId, "Home"],
      );
    }
  }

  await db.execute(
    "INSERT OR IGNORE INTO dashboard_pins (id, dashboard_id, resource_id) VALUES ($1, $2, $3)",
    [crypto.randomUUID(), dashId, resource.id],
  );
}

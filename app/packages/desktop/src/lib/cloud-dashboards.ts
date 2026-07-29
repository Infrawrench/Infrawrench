import type { Dashboard, DashboardCardRef, WorkspaceTabTarget } from "@infrawrench/ui";
import type { DashboardWidget } from "@infrawrench/ui/cost";
import type { ProbeStatus } from "@infrawrench/plugin-base";
import { invoke } from "./invoke";

interface CloudDashboardPin {
  pinId: string;
  resourceId: string;
  gridX: number;
  gridY: number;
  gridW: number;
  gridH: number;
}

/**
 * A workflow pinned onto a cloud dashboard. Unlike resource pins (which need a
 * live provider probe, hence the separate `cloud_get_pin` enrich call), the
 * card's whole contents are DB-only server-side, so they arrive inline with the
 * dashboard.
 */
export interface CloudDashboardWorkflowPin {
  pinId: string;
  workflowId: string;
  gridX: number;
  name: string;
  lastRunAt: string | null;
  lastStatus: string | null;
  metrics: Array<{ key: string; label: string; unit: string | null; value: unknown }>;
}

interface CloudDashboardFull {
  dashboard: Dashboard & { organizationId: string; createdAt?: string };
  pins: CloudDashboardPin[];
  workflowPins?: CloudDashboardWorkflowPin[];
  widgets?: DashboardWidget[];
}

export interface CloudProbeItem {
  resourceId: string;
  accountId: string;
  pluginId: string;
  resourceTypeId: string;
}

interface CloudEnrichedPin extends CloudDashboardPin {
  displayName: string;
  pluginId: string;
  resourceTypeId: string;
  accountId: string;
  /**
   * Server returns these as already-parsed JSON objects (the `jsonb` Postgres
   * columns deserialize through `cloudFetch`). The desktop side previously
   * declared `string` here and the consumer in `DashboardView.tsx` defensively
   * coerced either case — kept that coercion but the canonical wire shape is
   * a parsed object.
   */
  fieldsJson: Record<string, unknown>;
  outputsJson: Record<string, unknown>;
  pluginLogoSvg: string;
  pluginDisplayName: string;
  status: ProbeStatus;
}

export async function listCloudDashboards(orgId: string): Promise<Dashboard[]> {
  return invoke("cloud_list_dashboards", { orgId });
}

export async function getCloudDashboard(
  orgId: string,
  dashboardId: string,
): Promise<CloudDashboardFull> {
  return invoke("cloud_get_dashboard", { orgId, dashboardId });
}

export async function createCloudDashboard(orgId: string, name: string): Promise<Dashboard | null> {
  return invoke("cloud_create_dashboard", { orgId, name });
}

export async function deleteCloudDashboard(orgId: string, id: string): Promise<void> {
  await invoke("cloud_delete_dashboard", { orgId, id });
}

export async function renameCloudDashboard(orgId: string, id: string, name: string): Promise<void> {
  await invoke("cloud_rename_dashboard", { orgId, id, name });
}

/**
 * Which of the restored workspace tabs still point at rows that exist in the
 * org. Tabs whose ids come back are kept; the rest are dropped.
 */
export async function validateCloudWorkspaceTabs(
  orgId: string,
  tabs: Array<{ id: string; target: WorkspaceTabTarget }>,
): Promise<string[]> {
  const result = await invoke<{ validTabIds: string[] }>("cloud_validate_tabs", { orgId, tabs });
  return result?.validTabIds ?? [];
}

export async function pinCloudResource(
  orgId: string,
  dashboardId: string,
  resourceId: string,
): Promise<void> {
  await invoke("cloud_pin_resource", { orgId, dashboardId, resourceId });
}

export async function unpinCloudResource(
  orgId: string,
  dashboardId: string,
  resourceId: string,
): Promise<void> {
  await invoke("cloud_unpin_resource", { orgId, dashboardId, resourceId });
}

export async function reorderCloudCards(
  orgId: string,
  dashboardId: string,
  cards: DashboardCardRef[],
): Promise<void> {
  await invoke("cloud_reorder_pins", { orgId, dashboardId, cards });
}

export async function probeCloudPins(
  orgId: string,
  items: CloudProbeItem[],
): Promise<Record<string, ProbeStatus>> {
  return invoke("cloud_probe_pins", { orgId, items });
}

export async function getCloudEnrichedPin(orgId: string, pinId: string): Promise<CloudEnrichedPin> {
  return invoke("cloud_get_pin", { orgId, pinId });
}

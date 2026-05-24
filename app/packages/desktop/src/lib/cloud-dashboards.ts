import type { Dashboard } from "@infrawrench/ui";
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

interface CloudDashboardFull {
  dashboard: Dashboard & { organizationId: string; createdAt?: string };
  pins: CloudDashboardPin[];
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
  fieldsJson: string;
  outputsJson: string;
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

export async function reorderCloudPins(
  orgId: string,
  dashboardId: string,
  resourceIds: string[],
): Promise<void> {
  await invoke("cloud_reorder_pins", { orgId, dashboardId, resourceIds });
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

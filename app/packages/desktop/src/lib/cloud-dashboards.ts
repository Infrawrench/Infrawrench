import type {
  Dashboard,
  DashboardCardRef,
  DashboardDefaultClient,
  WorkspaceTabTarget,
} from "@infrawrench/ui";
import type { DefaultDashboardResolution } from "@infrawrench/client-core";
import type { DashboardWidget } from "@infrawrench/ui/cost";
import type { ProbeStatus } from "@infrawrench/plugin-base";
import { cloudClient } from "./cloud-client";
import { runRpc } from "./rpc/client";

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
 * live provider probe, hence the separate `getCloudEnrichedPin` call), the
 * card's whole contents are DB-only server-side, so they arrive inline with the
 * dashboard.
 */
interface CloudDashboardWorkflowPin {
  pinId: string;
  workflowId: string;
  gridX: number;
  name: string;
  lastRunAt: string | null;
  lastStatus: string | null;
  /** `value` is absent for a metric the workflow has not reported yet. */
  metrics: Array<{ key: string; label: string; unit: string | null; value?: unknown }>;
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
   * columns deserialize through `cloudFetch`). `DashboardView.tsx` still
   * coerces a string defensively, but the canonical wire shape is a parsed
   * object.
   */
  fieldsJson: Record<string, unknown>;
  outputsJson: Record<string, unknown>;
  pluginLogoSvg: string;
  pluginDisplayName: string;
  status: ProbeStatus;
}

const dashboards = () => cloudClient("dashboards");

export function listCloudDashboards(orgId: string): Promise<Dashboard[]> {
  return runRpc(dashboards().dashboards.list({ params: { orgId } }));
}

export function getCloudDashboard(orgId: string, dashboardId: string): Promise<CloudDashboardFull> {
  return runRpc(dashboards().dashboards.get({ params: { orgId, id: dashboardId } }));
}

export function createCloudDashboard(orgId: string, name: string): Promise<Dashboard | null> {
  return runRpc(dashboards().dashboards.create({ params: { orgId }, payload: { name } }));
}

export async function deleteCloudDashboard(orgId: string, id: string): Promise<void> {
  await runRpc(dashboards().dashboards.delete({ params: { orgId, id } }));
}

export async function renameCloudDashboard(orgId: string, id: string, name: string): Promise<void> {
  await runRpc(dashboards().dashboards.rename({ params: { orgId, id }, payload: { name } }));
}

/** Which dashboard this member lands on: their own, else their role's, else the org's. */
export function getCloudDefaultDashboard(orgId: string): Promise<DefaultDashboardResolution> {
  return runRpc(dashboards().dashboardDefaults.resolve({ params: { orgId } }));
}

export function setMyCloudDefaultDashboard(
  orgId: string,
  dashboardId: string,
): Promise<DefaultDashboardResolution> {
  return runRpc(
    dashboards().dashboardDefaults.setMine({ params: { orgId }, payload: { dashboardId } }),
  );
}

export function clearMyCloudDefaultDashboard(orgId: string): Promise<DefaultDashboardResolution> {
  return runRpc(dashboards().dashboardDefaults.clearMine({ params: { orgId } }));
}

/** The shared header menu's transport, over the three calls above. */
export function createCloudDashboardDefaultClient(orgId: string): DashboardDefaultClient {
  return {
    getDefault: () => getCloudDefaultDashboard(orgId),
    setMine: (dashboardId) => setMyCloudDefaultDashboard(orgId, dashboardId),
    clearMine: () => clearMyCloudDefaultDashboard(orgId),
  };
}

/**
 * Which of the restored workspace tabs still point at rows that exist in the
 * org. Tabs whose ids come back are kept; the rest are dropped.
 */
export async function validateCloudWorkspaceTabs(
  orgId: string,
  tabs: Array<{ id: string; target: WorkspaceTabTarget }>,
): Promise<string[]> {
  const result = await runRpc(
    dashboards().dashboards.validateTabs({ params: { orgId }, payload: { tabs } }),
  );
  // An empty answer keeps the old reading: no ids came back.
  return result?.validTabIds ?? [];
}

export async function pinCloudResource(
  orgId: string,
  dashboardId: string,
  resourceId: string,
): Promise<void> {
  await runRpc(
    dashboards().dashboardPins.pin({ params: { orgId }, payload: { dashboardId, resourceId } }),
  );
}

export async function unpinCloudResource(
  orgId: string,
  dashboardId: string,
  resourceId: string,
): Promise<void> {
  await runRpc(
    dashboards().dashboardPins.unpin({ params: { orgId }, payload: { dashboardId, resourceId } }),
  );
}

/**
 * `cards` is the whole grid in its new order: resource pins, workflow pins
 * and widgets share one drag sequence, so the reorder can't be expressed as
 * resource ids alone.
 */
export async function reorderCloudCards(
  orgId: string,
  dashboardId: string,
  cards: DashboardCardRef[],
): Promise<void> {
  await runRpc(
    dashboards().dashboards.reorder({ params: { orgId, id: dashboardId }, payload: { cards } }),
  );
}

export function probeCloudPins(
  orgId: string,
  items: CloudProbeItem[],
): Promise<Record<string, ProbeStatus>> {
  return runRpc(dashboards().dashboardPins.probe({ params: { orgId }, payload: { items } }));
}

export function getCloudEnrichedPin(orgId: string, pinId: string): Promise<CloudEnrichedPin> {
  return runRpc(dashboards().dashboardPins.pinFull({ params: { orgId, pinId } }));
}

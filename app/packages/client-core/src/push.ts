import type { CloudFetch } from "./fetch";

/**
 * Device registration for mobile push. Server contract: user-scoped
 * `/api/push/devices` routes (see web `api/routes/push-devices.ts`).
 */

export interface RegisterPushTokenArgs {
  expoPushToken: string;
  platform: "ios" | "android";
  deviceName?: string;
}

export interface PushDeviceSummary {
  id: string;
  platform: "ios" | "android";
  deviceName: string | null;
  lastSeenAt: string;
  disabled: boolean;
}

/**
 * The notification `data` payload the server sends — the deep-link contract.
 * Mirrors server-core `push/types.ts` PushData.
 */
export type PushNotificationData =
  | {
      type: "sync_incident";
      orgId: string;
      accountId: string;
      resourceTypeId: string;
      incidentId: string;
    }
  | {
      type: "budget_breach";
      orgId: string;
      budgetId: string;
      month: string;
      thresholdPercent: number;
    }
  | {
      type: "workflow_page";
      orgId: string;
      workflowId: string;
      /** The run that raised the page, so the app can open its logs. */
      runId?: string;
    }
  | {
      /** A run is suspended on `infra.waitForApproval(...)` and needs a decision. */
      type: "workflow_approval";
      orgId: string;
      workflowId: string;
      /** The suspended run, so the app can open its view. */
      runId: string;
      approvalId: string;
    }
  | {
      /** A page a server outside Infrawrench raised over `POST /pages`. */
      type: "api_page";
      orgId: string;
      /** The caller's name for the system that paged. */
      source: string;
      /** The throttle key it paged under. */
      key: string;
    }
  | { type: "test"; orgId: string };

export async function registerPushToken(
  api: CloudFetch,
  args: RegisterPushTokenArgs,
): Promise<{ id: string } | null> {
  return api.api<{ id: string }>("/api/push/devices", {
    method: "POST",
    body: JSON.stringify(args),
  });
}

export async function listPushDevices(api: CloudFetch): Promise<PushDeviceSummary[]> {
  return (await api.api<PushDeviceSummary[]>("/api/push/devices")) ?? [];
}

export async function unregisterPushDevice(api: CloudFetch, deviceId: string): Promise<void> {
  await api.api(`/api/push/devices/${encodeURIComponent(deviceId)}`, { method: "DELETE" });
}

export interface PushPreferences {
  syncIncidents: boolean;
  budgetAlerts: boolean;
  /**
   * Alerts raised by your own code — a workflow calling `infra.page(...)` or a
   * server calling `POST /api/org/{orgId}/pages`.
   */
  workflowPages: boolean;
}

export async function getPushPreferences(api: CloudFetch, orgId: string): Promise<PushPreferences> {
  return (
    (await api.org<PushPreferences>(orgId, "/push/preferences")) ?? {
      syncIncidents: true,
      budgetAlerts: true,
      workflowPages: true,
    }
  );
}

export async function updatePushPreferences(
  api: CloudFetch,
  orgId: string,
  prefs: Partial<PushPreferences>,
): Promise<void> {
  await api.org(orgId, "/push/preferences", { method: "PUT", body: JSON.stringify(prefs) });
}

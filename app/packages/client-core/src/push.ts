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
      /**
       * A spend anomaly: either a statistical spike against the trailing
       * baseline or a provider/service that started spending from nothing.
       */
      type: "cost_anomaly";
      orgId: string;
      /** The anomalous day, YYYY-MM-DD (UTC). */
      day: string;
      /**
       * Which detection fired. Optional: notifications sent before new-source
       * detection existed carry no `kind`, and a reader should treat its
       * absence as `"spike"`.
       */
      kind?: "spike" | "new_source";
      dimension: "provider" | "service";
      dimensionKey: string;
    }
  | {
      /**
       * A metric threshold alert rule fired (or recovered) on one resource —
       * "CPU > 90% for 15 minutes" (see server-core `metric-alerts/eval.ts`).
       *
       * Target route: the resource's detail view when it still exists,
       * otherwise the org's metric alerts list.
       */
      type: "metric_alert";
      orgId: string;
      ruleId: string;
      resourceId: string;
      /** Whether this notification announces the breach or the recovery. */
      status: "firing" | "resolved";
    }
  | {
      type: "workflow_page";
      orgId: string;
      workflowId: string;
      /** The run that raised the page, so the app can open its logs. */
      runId?: string;
    }
  | {
      /**
       * A batched digest of the change timeline: every resource that appeared,
       * changed or disappeared since the previous drift notification. Never one
       * notification per change — the server batches a whole window into this
       * single payload (see server-core `drift/alerts.ts`).
       *
       * Target route: the mobile **Changes** screen,
       * `/org/{orgId}/changes` — scoped to `accountId` when present and, ideally,
       * filtered to `createdAt > since` so the screen opens on exactly the
       * window the notification described.
       */
      type: "resource_drift";
      orgId: string;
      /**
       * Changes in the window. Capped at the server's read ceiling (500), so a
       * larger window reports the ceiling rather than the true total.
       */
      changeCount: number;
      /** ISO timestamp of the window start — the `from` filter for the feed. */
      since: string;
      /** Present only when every change in the window came from one account. */
      accountId?: string;
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
  | {
      /**
       * A provider status-page incident overlapping resources the org holds
       * (see server-core `status/`). One notification per (incident, org).
       *
       * Target route: the mobile **Changes** screen, `/org/{orgId}/changes`,
       * where the incident banner and overlap section render.
       */
      type: "provider_incident";
      orgId: string;
      /** The plugin whose provider is having the incident. */
      pluginId: string;
      /** Cached incident row id (`provider_status_incidents.id`). */
      incidentId: string;
      /** How many of the org's resources matched when the alert fired. */
      affectedResourceCount: number;
    }
  | {
      /**
       * A daily digest of approaching deadlines on synced resources — expiring
       * TLS certificates, domain registrations, API tokens, keys past their
       * rotation budget (see server-core `expiry/alerts.ts`). Never one
       * notification per deadline: the server batches everything inside the
       * org's lead time into this single payload, at most once per 24h.
       *
       * Target route: the expiry radar, `/org/{orgId}/expiring`.
       */
      type: "expiry_alert";
      orgId: string;
    }
  | {
      /**
       * A saved log-workspace query with alerting enabled found matching log
       * lines (see server-core `log-workspaces/pass.ts`). At most one
       * notification per cooldown window, never one per matching line.
       *
       * Target route: the log workspace list, `/org/{orgId}/log-workspaces`
       * (the query's own viewer at `/org/{orgId}/log-workspaces/{queryId}`).
       */
      type: "log_match";
      orgId: string;
      /** Saved query row id (`log_workspace_queries.id`). */
      queryId: string;
      /** Matching lines counted this evaluation (capped server-side). */
      matchCount: number;
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
  /** Statistical spend-spike (cost anomaly) alerts. */
  anomalyAlerts: boolean;
  /** Metric threshold rule firings and recoveries. */
  metricAlerts: boolean;
  /**
   * Batched resource-drift digests from the change timeline. Defaults **off**:
   * drift is continuous where the other alerts are exceptional.
   */
  resourceDrift: boolean;
  /**
   * Alerts raised by your own code — a workflow calling `infra.page(...)`, a
   * run suspended on `infra.waitForApproval(...)`, or a server calling
   * `POST /api/org/{orgId}/pages`.
   */
  workflowPages: boolean;
  /** Provider status-page incidents overlapping resources the org holds. */
  providerIncidents: boolean;
  /** Daily digests of approaching resource deadlines (certs, domains, keys). */
  expiryAlerts: boolean;
  /** Saved log-query matches from the log workspace alert pass. */
  logMatchAlerts: boolean;
}

export async function getPushPreferences(api: CloudFetch, orgId: string): Promise<PushPreferences> {
  return (
    (await api.org<PushPreferences>(orgId, "/push/preferences")) ?? {
      syncIncidents: true,
      budgetAlerts: true,
      anomalyAlerts: true,
      metricAlerts: true,
      resourceDrift: false,
      workflowPages: true,
      providerIncidents: true,
      expiryAlerts: true,
      logMatchAlerts: true,
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

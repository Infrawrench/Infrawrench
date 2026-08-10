import type { CloudFetch } from "./fetch";
import { DEFAULT_MUTED_TRIGGERS, type AlertTrigger } from "./alert-routing";

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
       * A change-based cost alert fired: spend on the alert's scope moved
       * past its configured threshold versus the prior period (see
       * server-core `cost/change-eval.ts`).
       *
       * Target route: the Costs tab, where the change alerts section lists
       * the fired events.
       */
      type: "cost_change";
      orgId: string;
      alertId: string;
      /** The cadence period that fired, e.g. "2026-08-09" / "2026-W32" / "2026-08". */
      periodKey: string;
      /** The offending group; "" when the alert watches one total. */
      groupKey: string;
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
      /**
       * Someone asked for break-glass access: a time-boxed elevation above
       * what their role grants (see server-core `access/break-glass.ts`).
       *
       * Target route: the org's **Break-glass access** settings section,
       * which is the screen with the Approve/Deny buttons on it.
       */
      type: "access_request";
      orgId: string;
      requestId: string;
      /** Who is asking, for a notification that reads without a fetch. */
      requestedByName: string;
      /** How long the elevation would last once granted. */
      durationMinutes: number;
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
       * Critical/high security posture findings on synced resources (see
       * server-core `posture/alerts.ts`). At most one notification per
       * cooldown window, never one per finding.
       *
       * Target route: the posture screen, `/org/{orgId}/posture`.
       */
      type: "posture_alert";
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
  | {
      /**
       * A synthetic probe crossed its consecutive-failure threshold and went
       * down, or a down probe answered again (see server-core
       * `probes/pass.ts`). One notification per transition, never per check.
       *
       * Target route: the probes list, `/org/{orgId}/probes`.
       */
      type: "probe_alert";
      orgId: string;
      /** Probe row id (`synthetic_probes.id`). */
      probeId: string;
      /** Whether this notification announces the outage or the recovery. */
      status: "down" | "up";
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

/**
 * A member's own push mutes for one org.
 *
 * One array rather than eleven booleans: a trigger the member has not named is
 * on, so a build that adds a trigger needs no migration and no client update to
 * start delivering it. The shipped defaults for a member who has never saved
 * anything are `DEFAULT_MUTED_TRIGGERS` in `alert-routing.ts`.
 *
 * This is the one piece of the old boolean matrix that stayed personal. Slack
 * and Teams routing became org-level `alert_rules`; whether *your* phone rings
 * is still yours.
 */
export interface PushPreferences {
  mutedTriggers: AlertTrigger[];
}

export async function getPushPreferences(api: CloudFetch, orgId: string): Promise<PushPreferences> {
  return (
    (await api.org<PushPreferences>(orgId, "/push/preferences")) ?? {
      mutedTriggers: [...DEFAULT_MUTED_TRIGGERS],
    }
  );
}

/** Whether `trigger` reaches this member's devices. */
export function pushTriggerEnabled(prefs: PushPreferences, trigger: AlertTrigger): boolean {
  return !prefs.mutedTriggers.includes(trigger);
}

/** Toggle one trigger, returning the new mute list. */
export function withPushTrigger(
  prefs: PushPreferences,
  trigger: AlertTrigger,
  enabled: boolean,
): AlertTrigger[] {
  const set = new Set(prefs.mutedTriggers);
  if (enabled) set.delete(trigger);
  else set.add(trigger);
  return [...set];
}

export async function updatePushPreferences(
  api: CloudFetch,
  orgId: string,
  prefs: Partial<PushPreferences>,
): Promise<void> {
  await api.org(orgId, "/push/preferences", { method: "PUT", body: JSON.stringify(prefs) });
}

import { ipcMain } from "electron";
import { cloudFetch, cloudFetchBytes, cloudFetchText } from "./shared";

// Cost graphs, budgets, and dashboard widgets: cloud-mode only (there is no
// local-SQLite equivalent; cost data lives in the cloud ClickHouse store).

ipcMain.handle(
  "cloud_costs_query",
  async (_e, { orgId, request }: { orgId: string; request: unknown }) => {
    return cloudFetch(orgId, "/costs/query", { method: "POST", body: JSON.stringify(request) });
  },
);

// The FOCUS 1.3 CSV of a report's rows. Text, not JSON, so `cloudFetchText`;
// the renderer hands the body to the browser's own download path.
ipcMain.handle(
  "cloud_costs_focus_export",
  async (_e, { orgId, request }: { orgId: string; request: unknown }) => {
    return cloudFetchText(orgId, "/costs/focus-export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    });
  },
);

ipcMain.handle(
  "cloud_costs_dimensions",
  async (
    _e,
    { orgId, dimension, tagKey }: { orgId: string; dimension: string; tagKey?: string },
  ) => {
    const params = new URLSearchParams({ dimension });
    if (tagKey) params.set("tagKey", tagKey);
    return cloudFetch(orgId, `/costs/dimensions?${params.toString()}`);
  },
);

ipcMain.handle("cloud_costs_status", async (_e, { orgId }: { orgId: string }) => {
  return cloudFetch(orgId, "/costs/status");
});

// The carbon estimate on the Costs panel. Cloud-only like the rest of this
// file: resolving instance types to vCPUs needs the org's provider
// credentials. One resource's carbon rides `cloud_get_cost_estimate`.
ipcMain.handle(
  "cloud_carbon_estimate",
  async (_e, { orgId, windowDays }: { orgId: string; windowDays?: number }) => {
    return cloudFetch(orgId, `/carbon${windowDays ? `?windowDays=${windowDays}` : ""}`);
  },
);

ipcMain.handle(
  "cloud_costs_anomalies",
  async (_e, { orgId, days }: { orgId: string; days?: number }) => {
    const params = new URLSearchParams();
    if (days) params.set("days", String(days));
    const qs = params.toString();
    return cloudFetch(orgId, `/costs/anomalies${qs ? `?${qs}` : ""}`);
  },
);

/**
 * Explain a finding. The server dates the annotation it creates from the
 * anomaly itself, so there is nothing here to get wrong but the sentence.
 */
ipcMain.handle(
  "cloud_costs_acknowledge_anomaly",
  async (
    _e,
    { orgId, anomalyId, explanation }: { orgId: string; anomalyId: string; explanation: string },
  ) => {
    return cloudFetch(orgId, `/costs/anomalies/${encodeURIComponent(anomalyId)}/acknowledge`, {
      method: "POST",
      body: JSON.stringify({ explanation }),
    });
  },
);

// Budget alert notes. The server derives the chart marker's date from the
// firing and posts the follow-up to the alert's Slack threads and Teams
// webhooks, so the renderer sends only the sentence.
ipcMain.handle(
  "cloud_budget_alert_events",
  async (_e, { orgId, budgetId }: { orgId: string; budgetId: string }) => {
    return cloudFetch(orgId, `/budgets/${encodeURIComponent(budgetId)}/events`);
  },
);

/**
 * Anomaly feedback: a verdict on a finding (optionally creating a
 * suppression), the suppression list and editor, and the two read models.
 * Org-level cloud state like the tuning, so desktop gets all of it.
 */
ipcMain.handle(
  "cloud_costs_anomaly_feedback",
  async (_e, { orgId, anomalyId, input }: { orgId: string; anomalyId: string; input: unknown }) => {
    return cloudFetch(orgId, `/costs/anomalies/${encodeURIComponent(anomalyId)}/feedback`, {
      method: "POST",
      body: JSON.stringify(input),
    });
  },
);

ipcMain.handle(
  "cloud_budget_alert_note",
  async (
    _e,
    {
      orgId,
      budgetId,
      eventId,
      note,
    }: { orgId: string; budgetId: string; eventId: string; note: string },
  ) => {
    return cloudFetch(
      orgId,
      `/budgets/${encodeURIComponent(budgetId)}/events/${encodeURIComponent(eventId)}/note`,
      { method: "POST", body: JSON.stringify({ note }) },
    );
  },
);

ipcMain.handle(
  "cloud_costs_clear_anomaly_feedback",
  async (_e, { orgId, anomalyId }: { orgId: string; anomalyId: string }) => {
    return cloudFetch(orgId, `/costs/anomalies/${encodeURIComponent(anomalyId)}/feedback`, {
      method: "DELETE",
    });
  },
);

ipcMain.handle("cloud_costs_anomaly_suppressions", async (_e, { orgId }: { orgId: string }) => {
  return cloudFetch(orgId, "/costs/anomaly-suppressions");
});

ipcMain.handle(
  "cloud_costs_create_anomaly_suppression",
  async (_e, { orgId, input }: { orgId: string; input: unknown }) => {
    return cloudFetch(orgId, "/costs/anomaly-suppressions", {
      method: "POST",
      body: JSON.stringify(input),
    });
  },
);

ipcMain.handle(
  "cloud_costs_update_anomaly_suppression",
  async (
    _e,
    { orgId, suppressionId, input }: { orgId: string; suppressionId: string; input: unknown },
  ) => {
    return cloudFetch(orgId, `/costs/anomaly-suppressions/${encodeURIComponent(suppressionId)}`, {
      method: "PUT",
      body: JSON.stringify(input),
    });
  },
);

ipcMain.handle(
  "cloud_costs_delete_anomaly_suppression",
  async (_e, { orgId, suppressionId }: { orgId: string; suppressionId: string }) => {
    await cloudFetch(orgId, `/costs/anomaly-suppressions/${encodeURIComponent(suppressionId)}`, {
      method: "DELETE",
    });
    return null;
  },
);

ipcMain.handle("cloud_costs_anomaly_sensitivity", async (_e, { orgId }: { orgId: string }) => {
  return cloudFetch(orgId, "/costs/anomaly-sensitivity");
});

ipcMain.handle(
  "cloud_costs_anomaly_precision",
  async (_e, { orgId, months }: { orgId: string; months?: number }) => {
    const m = Number.isInteger(months) ? `?months=${months}` : "";
    return cloudFetch(orgId, `/costs/anomaly-precision${m}`);
  },
);

ipcMain.handle("cloud_costs_anomaly_settings", async (_e, { orgId }: { orgId: string }) => {
  return cloudFetch(orgId, "/costs/anomaly-settings");
});

ipcMain.handle(
  "cloud_costs_update_anomaly_settings",
  async (_e, { orgId, settings }: { orgId: string; settings: unknown }) => {
    return cloudFetch(orgId, "/costs/anomaly-settings", {
      method: "PUT",
      body: JSON.stringify(settings),
    });
  },
);

/**
 * The three efficiency alerts (commitment expiry, idle commitments, unit-cost
 * regression) and their tuning. Cloud-only for the same reason the anomaly
 * settings are: the detectors run server-side after each cost collection.
 */
ipcMain.handle(
  "cloud_costs_efficiency_alerts",
  async (_e, { orgId, kind, limit }: { orgId: string; kind?: string; limit?: number }) => {
    const params = new URLSearchParams();
    if (kind) params.set("kind", kind);
    if (limit) params.set("limit", String(limit));
    const qs = params.toString();
    return cloudFetch(orgId, `/costs/efficiency-alerts${qs ? `?${qs}` : ""}`);
  },
);

ipcMain.handle("cloud_costs_efficiency_settings", async (_e, { orgId }: { orgId: string }) => {
  return cloudFetch(orgId, "/costs/efficiency-alert-settings");
});

ipcMain.handle(
  "cloud_costs_update_efficiency_settings",
  async (_e, { orgId, settings }: { orgId: string; settings: unknown }) => {
    return cloudFetch(orgId, "/costs/efficiency-alert-settings", {
      method: "PUT",
      body: JSON.stringify(settings),
    });
  },
);

ipcMain.handle("cloud_tag_policy", async (_e, { orgId }: { orgId: string }) => {
  return cloudFetch(orgId, "/tag-policy");
});

ipcMain.handle("cloud_tag_compliance", async (_e, { orgId }: { orgId: string }) => {
  return cloudFetch(orgId, "/tag-policy/compliance");
});

function rangeQs(from?: string, to?: string): string {
  const params = new URLSearchParams();
  if (from) params.set("from", from);
  if (to) params.set("to", to);
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

ipcMain.handle(
  "cloud_costs_untagged",
  async (_e, { orgId, from, to }: { orgId: string; from?: string; to?: string }) => {
    return cloudFetch(orgId, `/costs/untagged${rangeQs(from, to)}`);
  },
);

ipcMain.handle(
  "cloud_costs_showback",
  async (_e, { orgId, from, to }: { orgId: string; from?: string; to?: string }) => {
    return cloudFetch(orgId, `/costs/showback${rangeQs(from, to)}`);
  },
);

/**
 * The org's billing rules, read-only. The Costs panel uses this to decide
 * whether to offer the "Apply billing rules" toggle at all; editing goes
 * through the settings proxy, which enforces `org:settings:write` server-side.
 */
ipcMain.handle("cloud_billing_rules", async (_e, { orgId }: { orgId: string }) => {
  return cloudFetch(orgId, "/billing-rules");
});

/**
 * Prepaid credit balances with their burn rate and runway. Cloud-only, like
 * every other read here: the burn is derived from a server-side series of
 * readings, and a local-only workspace has no series to derive it from.
 */
ipcMain.handle("cloud_credit_burndown", async (_e, { orgId }: { orgId: string }) => {
  return cloudFetch(orgId, "/credits");
});

/**
 * Commitments (reservations, savings plans, committed-use discounts) with
 * coverage, utilization and planner recommendations. Cloud-only: the
 * inventory is collected server-side and joined against server-side cost
 * rows; a local-only workspace has neither.
 */
ipcMain.handle("cloud_commitments", async (_e, { orgId }: { orgId: string }) => {
  return cloudFetch(orgId, "/commitments");
});

/**
 * Network costs: the org-wide pair view and its collection switch, plus one
 * Kubernetes cluster's report and its billed source. Cloud-only: flows are
 * collected server-side into the cloud store.
 */
ipcMain.handle(
  "cloud_network_flows",
  async (
    _e,
    {
      orgId,
      options,
    }: { orgId: string; options?: { from?: string; to?: string; scope?: string; limit?: number } },
  ) => {
    const params = new URLSearchParams();
    if (options?.from) params.set("from", options.from);
    if (options?.to) params.set("to", options.to);
    if (options?.scope) params.set("scope", options.scope);
    if (options?.limit !== undefined) params.set("limit", String(options.limit));
    const qs = params.toString();
    return cloudFetch(orgId, `/network-flows${qs ? `?${qs}` : ""}`);
  },
);

ipcMain.handle(
  "cloud_network_flow_settings_update",
  async (_e, { orgId, settings }: { orgId: string; settings: unknown }) => {
    return cloudFetch(orgId, "/network-flows/settings", {
      method: "PUT",
      body: JSON.stringify(settings),
    });
  },
);

ipcMain.handle(
  "cloud_kubernetes_network",
  async (
    _e,
    {
      orgId,
      accountId,
      options,
    }: {
      orgId: string;
      accountId: string;
      options?: { from?: string; to?: string; limit?: number };
    },
  ) => {
    const params = new URLSearchParams();
    if (options?.from) params.set("from", options.from);
    if (options?.to) params.set("to", options.to);
    if (options?.limit !== undefined) params.set("limit", String(options.limit));
    const qs = params.toString();
    return cloudFetch(
      orgId,
      `/network-flows/kubernetes/${encodeURIComponent(accountId)}${qs ? `?${qs}` : ""}`,
    );
  },
);

ipcMain.handle(
  "cloud_kubernetes_network_settings_update",
  async (
    _e,
    {
      orgId,
      accountId,
      settings,
    }: { orgId: string; accountId: string; settings: { billedQuery: string | null } },
  ) => {
    return cloudFetch(
      orgId,
      `/network-flows/kubernetes/${encodeURIComponent(accountId)}/settings`,
      {
        method: "PUT",
        body: JSON.stringify(settings),
      },
    );
  },
);
/* ------------------------------------------------------------------ *
 * Realized savings. Cloud-only: the events are recorded server-side
 * (resizes, deletions, schedules, the sync diff) and measured against
 * server-side billing.
 * ------------------------------------------------------------------ */

ipcMain.handle(
  "cloud_realized_savings",
  async (_e, { orgId, from, to }: { orgId: string; from?: string; to?: string }) => {
    const params = new URLSearchParams();
    if (from) params.set("from", from);
    if (to) params.set("to", to);
    const qs = params.toString();
    return cloudFetch(orgId, `/savings/realized${qs ? `?${qs}` : ""}`);
  },
);

ipcMain.handle(
  "cloud_create_savings_event",
  async (_e, { orgId, input }: { orgId: string; input: unknown }) => {
    return cloudFetch(orgId, "/savings/events", { method: "POST", body: JSON.stringify(input) });
  },
);

ipcMain.handle(
  "cloud_update_savings_event",
  async (_e, { orgId, eventId, input }: { orgId: string; eventId: string; input: unknown }) => {
    return cloudFetch(orgId, `/savings/events/${encodeURIComponent(eventId)}`, {
      method: "PUT",
      body: JSON.stringify(input),
    });
  },
);

ipcMain.handle(
  "cloud_annotate_savings_event",
  async (_e, { orgId, eventId, input }: { orgId: string; eventId: string; input: unknown }) => {
    return cloudFetch(orgId, `/savings/events/${encodeURIComponent(eventId)}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    });
  },
);

ipcMain.handle(
  "cloud_delete_savings_event",
  async (_e, { orgId, eventId }: { orgId: string; eventId: string }) => {
    return cloudFetch(orgId, `/savings/events/${encodeURIComponent(eventId)}`, {
      method: "DELETE",
    });
  },
);

ipcMain.handle(
  "cloud_update_savings_settings",
  async (_e, { orgId, settings }: { orgId: string; settings: unknown }) => {
    return cloudFetch(orgId, "/savings/settings", {
      method: "PUT",
      body: JSON.stringify(settings),
    });
  },
);

/** The manual-entry resource picker: the org's spotlight index, resources only. */
ipcMain.handle(
  "cloud_savings_search_resources",
  async (_e, { orgId, query }: { orgId: string; query: string }) => {
    return (await cloudFetch(orgId, `/search?q=${encodeURIComponent(query)}`)) ?? [];
  },
);

ipcMain.handle("cloud_list_budgets", async (_e, { orgId }: { orgId: string }) => {
  return (await cloudFetch(orgId, "/budgets")) ?? [];
});

ipcMain.handle(
  "cloud_create_budget",
  async (_e, { orgId, input }: { orgId: string; input: unknown }) => {
    return cloudFetch(orgId, "/budgets", { method: "POST", body: JSON.stringify(input) });
  },
);

ipcMain.handle(
  "cloud_update_budget",
  async (_e, { orgId, budgetId, input }: { orgId: string; budgetId: string; input: unknown }) => {
    return cloudFetch(orgId, `/budgets/${encodeURIComponent(budgetId)}`, {
      method: "PUT",
      body: JSON.stringify(input),
    });
  },
);

ipcMain.handle(
  "cloud_delete_budget",
  async (_e, { orgId, budgetId }: { orgId: string; budgetId: string }) => {
    return cloudFetch(orgId, `/budgets/${encodeURIComponent(budgetId)}`, { method: "DELETE" });
  },
);

/* ------------------------------------------------------------------ *
 * Change-based cost alerts: "spend moved more than X% (or $Y) vs the
 * prior period". Cloud-mode only like everything above: evaluation and
 * the fired events live server-side.
 * ------------------------------------------------------------------ */

ipcMain.handle("cloud_list_cost_alerts", async (_e, { orgId }: { orgId: string }) => {
  return cloudFetch(orgId, "/cost-alerts");
});

ipcMain.handle(
  "cloud_list_cost_alert_events",
  async (_e, { orgId, alertId, limit }: { orgId: string; alertId?: string; limit?: number }) => {
    const params = new URLSearchParams();
    if (alertId) params.set("alertId", alertId);
    if (limit !== undefined) params.set("limit", String(limit));
    const qs = params.toString();
    return cloudFetch(orgId, `/cost-alerts/events${qs ? `?${qs}` : ""}`);
  },
);

ipcMain.handle(
  "cloud_create_cost_alert",
  async (_e, { orgId, input }: { orgId: string; input: unknown }) => {
    return cloudFetch(orgId, "/cost-alerts", { method: "POST", body: JSON.stringify(input) });
  },
);

ipcMain.handle(
  "cloud_update_cost_alert",
  async (_e, { orgId, alertId, input }: { orgId: string; alertId: string; input: unknown }) => {
    return cloudFetch(orgId, `/cost-alerts/${encodeURIComponent(alertId)}`, {
      method: "PUT",
      body: JSON.stringify(input),
    });
  },
);

ipcMain.handle(
  "cloud_delete_cost_alert",
  async (_e, { orgId, alertId }: { orgId: string; alertId: string }) => {
    return cloudFetch(orgId, `/cost-alerts/${encodeURIComponent(alertId)}`, {
      method: "DELETE",
    });
  },
);

ipcMain.handle(
  "cloud_create_widget",
  async (_e, { orgId, request }: { orgId: string; request: unknown }) => {
    return cloudFetch(orgId, "/dashboards/widgets", {
      method: "POST",
      body: JSON.stringify(request),
    });
  },
);

ipcMain.handle(
  "cloud_update_widget",
  async (
    _e,
    { orgId, widgetId, request }: { orgId: string; widgetId: string; request: unknown },
  ) => {
    return cloudFetch(orgId, `/dashboards/widgets/${encodeURIComponent(widgetId)}`, {
      method: "PATCH",
      body: JSON.stringify(request),
    });
  },
);

ipcMain.handle(
  "cloud_delete_widget",
  async (_e, { orgId, widgetId }: { orgId: string; widgetId: string }) => {
    return cloudFetch(orgId, `/dashboards/widgets/${encodeURIComponent(widgetId)}`, {
      method: "DELETE",
    });
  },
);

/* ------------------------------------------------------------------ *
 * Cost reports: named, saved cost graphs. Cloud-mode only for the same
 * reason as everything above: the spend they draw lives in the cloud.
 * ------------------------------------------------------------------ */

ipcMain.handle("cloud_list_cost_reports", async (_e, { orgId }: { orgId: string }) => {
  return (await cloudFetch(orgId, "/cost-reports")) ?? [];
});

ipcMain.handle(
  "cloud_get_cost_report",
  async (_e, { orgId, reportId }: { orgId: string; reportId: string }) => {
    return cloudFetch(orgId, `/cost-reports/${encodeURIComponent(reportId)}`);
  },
);

ipcMain.handle(
  "cloud_create_cost_report",
  async (_e, { orgId, input }: { orgId: string; input: unknown }) => {
    return cloudFetch(orgId, "/cost-reports", { method: "POST", body: JSON.stringify(input) });
  },
);

ipcMain.handle(
  "cloud_update_cost_report",
  async (_e, { orgId, reportId, input }: { orgId: string; reportId: string; input: unknown }) => {
    return cloudFetch(orgId, `/cost-reports/${encodeURIComponent(reportId)}`, {
      method: "PUT",
      body: JSON.stringify(input),
    });
  },
);

ipcMain.handle(
  "cloud_delete_cost_report",
  async (_e, { orgId, reportId }: { orgId: string; reportId: string }) => {
    return cloudFetch(orgId, `/cost-reports/${encodeURIComponent(reportId)}`, {
      method: "DELETE",
    });
  },
);

// Bulk move/delete of reports and folders. The server validates every item
// and applies all or nothing; its 400 message names the blocking items.
ipcMain.handle(
  "cloud_bulk_cost_reports",
  async (_e, { orgId, request }: { orgId: string; request: unknown }) => {
    return cloudFetch(orgId, "/cost-reports/bulk", {
      method: "POST",
      body: JSON.stringify(request),
    });
  },
);

ipcMain.handle(
  "cloud_run_cost_report",
  async (_e, { orgId, reportId }: { orgId: string; reportId: string }) => {
    return cloudFetch(orgId, `/cost-reports/${encodeURIComponent(reportId)}/run`, {
      method: "POST",
    });
  },
);

/* ------------------------------------------------------------------ *
 * Cost annotations: dated notes drawn over cost charts. Their own
 * channel family rather than a child of the report ones: a note with no
 * report id is org-wide and belongs to every chart, so it is not a
 * sub-resource of any one report.
 * ------------------------------------------------------------------ */

ipcMain.handle(
  "cloud_list_cost_annotations",
  async (_e, { orgId, reportId }: { orgId: string; reportId?: string }) => {
    const qs = reportId ? `?reportId=${encodeURIComponent(reportId)}` : "";
    return cloudFetch(orgId, `/cost-annotations${qs}`);
  },
);

ipcMain.handle(
  "cloud_create_cost_annotation",
  async (_e, { orgId, input }: { orgId: string; input: unknown }) => {
    return cloudFetch(orgId, "/cost-annotations", {
      method: "POST",
      body: JSON.stringify(input),
    });
  },
);

ipcMain.handle(
  "cloud_update_cost_annotation",
  async (
    _e,
    { orgId, annotationId, input }: { orgId: string; annotationId: string; input: unknown },
  ) => {
    return cloudFetch(orgId, `/cost-annotations/${encodeURIComponent(annotationId)}`, {
      method: "PUT",
      body: JSON.stringify(input),
    });
  },
);

ipcMain.handle(
  "cloud_delete_cost_annotation",
  async (_e, { orgId, annotationId }: { orgId: string; annotationId: string }) => {
    return cloudFetch(orgId, `/cost-annotations/${encodeURIComponent(annotationId)}`, {
      method: "DELETE",
    });
  },
);

/* ------------------------------------------------------------------ *
 * Cost-report folders: the tree the Reports list groups by.
 * ------------------------------------------------------------------ */

ipcMain.handle("cloud_list_cost_report_folders", async (_e, { orgId }: { orgId: string }) => {
  return (await cloudFetch(orgId, "/cost-report-folders")) ?? [];
});

ipcMain.handle(
  "cloud_create_cost_report_folder",
  async (_e, { orgId, input }: { orgId: string; input: unknown }) => {
    return cloudFetch(orgId, "/cost-report-folders", {
      method: "POST",
      body: JSON.stringify(input),
    });
  },
);

ipcMain.handle(
  "cloud_update_cost_report_folder",
  async (_e, { orgId, folderId, input }: { orgId: string; folderId: string; input: unknown }) => {
    return cloudFetch(orgId, `/cost-report-folders/${encodeURIComponent(folderId)}`, {
      method: "PUT",
      body: JSON.stringify(input),
    });
  },
);

ipcMain.handle(
  "cloud_delete_cost_report_folder",
  async (_e, { orgId, folderId }: { orgId: string; folderId: string }) => {
    return cloudFetch(orgId, `/cost-report-folders/${encodeURIComponent(folderId)}`, {
      method: "DELETE",
    });
  },
);

/* ------------------------------------------------------------------ *
 * Report delivery schedules: scheduled sends of a saved report to
 * Slack/Teams/email. Same thin proxy pattern as everything above; the
 * server owns validation and permissions (reads costs:read, writes
 * org:settings:write).
 * ------------------------------------------------------------------ */

ipcMain.handle(
  "cloud_list_report_notifications",
  async (_e, { orgId, reportId }: { orgId: string; reportId: string }) => {
    return (
      (await cloudFetch(orgId, `/cost-reports/${encodeURIComponent(reportId)}/notifications`)) ?? []
    );
  },
);

ipcMain.handle(
  "cloud_report_delivery_targets",
  async (_e, { orgId, reportId }: { orgId: string; reportId: string }) => {
    return cloudFetch(orgId, `/cost-reports/${encodeURIComponent(reportId)}/notifications/targets`);
  },
);

ipcMain.handle(
  "cloud_create_report_notification",
  async (_e, { orgId, reportId, input }: { orgId: string; reportId: string; input: unknown }) => {
    return cloudFetch(orgId, `/cost-reports/${encodeURIComponent(reportId)}/notifications`, {
      method: "POST",
      body: JSON.stringify(input),
    });
  },
);

ipcMain.handle(
  "cloud_update_report_notification",
  async (
    _e,
    {
      orgId,
      reportId,
      notificationId,
      input,
    }: { orgId: string; reportId: string; notificationId: string; input: unknown },
  ) => {
    return cloudFetch(
      orgId,
      `/cost-reports/${encodeURIComponent(reportId)}/notifications/${encodeURIComponent(notificationId)}`,
      { method: "PUT", body: JSON.stringify(input) },
    );
  },
);

ipcMain.handle(
  "cloud_delete_report_notification",
  async (
    _e,
    {
      orgId,
      reportId,
      notificationId,
    }: { orgId: string; reportId: string; notificationId: string },
  ) => {
    return cloudFetch(
      orgId,
      `/cost-reports/${encodeURIComponent(reportId)}/notifications/${encodeURIComponent(notificationId)}`,
      { method: "DELETE" },
    );
  },
);

ipcMain.handle(
  "cloud_send_report_notification",
  async (
    _e,
    {
      orgId,
      reportId,
      notificationId,
    }: { orgId: string; reportId: string; notificationId: string },
  ) => {
    return cloudFetch(
      orgId,
      `/cost-reports/${encodeURIComponent(reportId)}/notifications/${encodeURIComponent(notificationId)}/send`,
      { method: "POST" },
    );
  },
);

/* ------------------------------------------------------------------ *
 * PDF export: a cost report or a dashboard rendered server-side. Bytes,
 * not JSON; the renderer turns them into a download.
 * ------------------------------------------------------------------ */

/**
 * `?tz=` with the local zone, so the PDF's "generated at" line reads in the
 * user's time. client-core's `withPdfTimezone`, re-derived here: this module
 * graph is CommonJS and client-core is ESM (see `local-posture.ts`).
 */
function withPdfTimezone(path: string): string {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return tz ? `${path}?tz=${encodeURIComponent(tz)}` : path;
}

ipcMain.handle(
  "cloud_cost_report_pdf",
  async (_e, { orgId, reportId }: { orgId: string; reportId: string }) => {
    return cloudFetchBytes(
      orgId,
      withPdfTimezone(`/cost-reports/${encodeURIComponent(reportId)}/pdf`),
    );
  },
);

ipcMain.handle(
  "cloud_dashboard_pdf",
  async (_e, { orgId, dashboardId }: { orgId: string; dashboardId: string }) => {
    return cloudFetchBytes(
      orgId,
      withPdfTimezone(`/dashboards/${encodeURIComponent(dashboardId)}/pdf`),
    );
  },
);

/* ------------------------------------------------------------------ *
 * Dashboard delivery schedules: the report-schedule proxy above, keyed by
 * dashboard, with the PDF attached at each send. Reads dashboards:read,
 * writes org:settings:write; the server enforces both.
 * ------------------------------------------------------------------ */

ipcMain.handle(
  "cloud_list_dashboard_notifications",
  async (_e, { orgId, dashboardId }: { orgId: string; dashboardId: string }) => {
    return (
      (await cloudFetch(orgId, `/dashboards/${encodeURIComponent(dashboardId)}/notifications`)) ??
      []
    );
  },
);

ipcMain.handle(
  "cloud_dashboard_delivery_targets",
  async (_e, { orgId, dashboardId }: { orgId: string; dashboardId: string }) => {
    return cloudFetch(
      orgId,
      `/dashboards/${encodeURIComponent(dashboardId)}/notifications/targets`,
    );
  },
);

ipcMain.handle(
  "cloud_create_dashboard_notification",
  async (
    _e,
    { orgId, dashboardId, input }: { orgId: string; dashboardId: string; input: unknown },
  ) => {
    return cloudFetch(orgId, `/dashboards/${encodeURIComponent(dashboardId)}/notifications`, {
      method: "POST",
      body: JSON.stringify(input),
    });
  },
);

ipcMain.handle(
  "cloud_update_dashboard_notification",
  async (
    _e,
    {
      orgId,
      dashboardId,
      notificationId,
      input,
    }: { orgId: string; dashboardId: string; notificationId: string; input: unknown },
  ) => {
    return cloudFetch(
      orgId,
      `/dashboards/${encodeURIComponent(dashboardId)}/notifications/${encodeURIComponent(notificationId)}`,
      { method: "PUT", body: JSON.stringify(input) },
    );
  },
);

ipcMain.handle(
  "cloud_delete_dashboard_notification",
  async (
    _e,
    {
      orgId,
      dashboardId,
      notificationId,
    }: { orgId: string; dashboardId: string; notificationId: string },
  ) => {
    return cloudFetch(
      orgId,
      `/dashboards/${encodeURIComponent(dashboardId)}/notifications/${encodeURIComponent(notificationId)}`,
      { method: "DELETE" },
    );
  },
);

ipcMain.handle(
  "cloud_send_dashboard_notification",
  async (
    _e,
    {
      orgId,
      dashboardId,
      notificationId,
    }: { orgId: string; dashboardId: string; notificationId: string },
  ) => {
    return cloudFetch(
      orgId,
      `/dashboards/${encodeURIComponent(dashboardId)}/notifications/${encodeURIComponent(notificationId)}/send`,
      { method: "POST" },
    );
  },
);

/* ------------------------------------------------------------------ *
 * Saved cost filters: named `CostFilter[]` sets that graphs, reports and
 * budgets apply by reference; the server resolves the id at query time.
 * Cloud-mode only like everything above.
 * ------------------------------------------------------------------ */

ipcMain.handle("cloud_list_saved_cost_filters", async (_e, { orgId }: { orgId: string }) => {
  return (await cloudFetch(orgId, "/saved-cost-filters")) ?? [];
});

ipcMain.handle(
  "cloud_create_saved_cost_filter",
  async (_e, { orgId, input }: { orgId: string; input: unknown }) => {
    return cloudFetch(orgId, "/saved-cost-filters", {
      method: "POST",
      body: JSON.stringify(input),
    });
  },
);

ipcMain.handle(
  "cloud_update_saved_cost_filter",
  async (
    _e,
    { orgId, savedFilterId, input }: { orgId: string; savedFilterId: string; input: unknown },
  ) => {
    return cloudFetch(orgId, `/saved-cost-filters/${encodeURIComponent(savedFilterId)}`, {
      method: "PUT",
      body: JSON.stringify(input),
    });
  },
);

// A 409 passes through as an error whose message lists the referents: the
// server's refusal to delete a still-referenced filter is the feature, and the
// renderer shows it verbatim.
ipcMain.handle(
  "cloud_delete_saved_cost_filter",
  async (_e, { orgId, savedFilterId }: { orgId: string; savedFilterId: string }) => {
    return cloudFetch(orgId, `/saved-cost-filters/${encodeURIComponent(savedFilterId)}`, {
      method: "DELETE",
    });
  },
);

ipcMain.handle(
  "cloud_saved_cost_filter_referents",
  async (_e, { orgId, savedFilterId }: { orgId: string; savedFilterId: string }) => {
    return cloudFetch(orgId, `/saved-cost-filters/${encodeURIComponent(savedFilterId)}/referents`);
  },
);

/* ------------------------------------------------------------------ *
 * Scenario models: named sets of known future cost overlaid on a
 * forecast. Cloud-mode only like everything above; the model is resolved
 * server-side at query time, so nothing here holds a copy.
 * ------------------------------------------------------------------ */

ipcMain.handle("cloud_list_cost_scenarios", async (_e, { orgId }: { orgId: string }) => {
  const res = await cloudFetch<{ models: unknown[] }>(orgId, "/cost-scenarios");
  return res?.models ?? [];
});

ipcMain.handle(
  "cloud_create_cost_scenario",
  async (_e, { orgId, input }: { orgId: string; input: unknown }) => {
    return cloudFetch(orgId, "/cost-scenarios", { method: "POST", body: JSON.stringify(input) });
  },
);

ipcMain.handle(
  "cloud_update_cost_scenario",
  async (_e, { orgId, modelId, input }: { orgId: string; modelId: string; input: unknown }) => {
    return cloudFetch(orgId, `/cost-scenarios/${encodeURIComponent(modelId)}`, {
      method: "PUT",
      body: JSON.stringify(input),
    });
  },
);

// A 409 passes through as an error whose message lists the referents: the
// server's refusal to delete a still-referenced model is the feature, and the
// renderer shows it verbatim.
ipcMain.handle(
  "cloud_delete_cost_scenario",
  async (_e, { orgId, modelId }: { orgId: string; modelId: string }) => {
    return cloudFetch(orgId, `/cost-scenarios/${encodeURIComponent(modelId)}`, {
      method: "DELETE",
    });
  },
);

ipcMain.handle(
  "cloud_cost_scenario_referents",
  async (_e, { orgId, modelId }: { orgId: string; modelId: string }) => {
    return cloudFetch(orgId, `/cost-scenarios/${encodeURIComponent(modelId)}/referents`);
  },
);

/* ------------------------------------------------------------------ *
 * Business metrics: the denominators unit costs divide by, plus the
 * unit-cost query itself. Cloud-mode only like everything above: the
 * numerator lives in the cloud's cost store.
 * ------------------------------------------------------------------ */

ipcMain.handle("cloud_list_business_metrics", async (_e, { orgId }: { orgId: string }) => {
  const res = await cloudFetch<{ metrics: unknown[] }>(orgId, "/business-metrics");
  return res?.metrics ?? [];
});

ipcMain.handle(
  "cloud_create_business_metric",
  async (_e, { orgId, input }: { orgId: string; input: unknown }) => {
    return cloudFetch(orgId, "/business-metrics", {
      method: "POST",
      body: JSON.stringify(input),
    });
  },
);

ipcMain.handle(
  "cloud_update_business_metric",
  async (_e, { orgId, metricId, input }: { orgId: string; metricId: string; input: unknown }) => {
    return cloudFetch(orgId, `/business-metrics/${encodeURIComponent(metricId)}`, {
      method: "PUT",
      body: JSON.stringify(input),
    });
  },
);

ipcMain.handle(
  "cloud_delete_business_metric",
  async (_e, { orgId, metricId }: { orgId: string; metricId: string }) => {
    return cloudFetch(orgId, `/business-metrics/${encodeURIComponent(metricId)}`, {
      method: "DELETE",
    });
  },
);

ipcMain.handle(
  "cloud_list_business_metric_values",
  async (_e, { orgId, metricId, limit }: { orgId: string; metricId: string; limit?: number }) => {
    const res = await cloudFetch<{ values: unknown[] }>(
      orgId,
      `/business-metrics/${encodeURIComponent(metricId)}/values?limit=${limit ?? 90}`,
    );
    return res?.values ?? [];
  },
);

// Re-reporting a day restates it rather than accumulating: the server's
// guarantee, repeated here only because it is what makes this handler safe to
// call twice from a retrying renderer.
ipcMain.handle(
  "cloud_write_business_metric_values",
  async (_e, { orgId, metricId, values }: { orgId: string; metricId: string; values: unknown }) => {
    return cloudFetch(orgId, `/business-metrics/${encodeURIComponent(metricId)}/values`, {
      method: "POST",
      body: JSON.stringify({ values }),
    });
  },
);

// Business-metric importers. The importer runs in the cloud (the poller
// claims it), so the desktop is purely a client of these routes.
ipcMain.handle("cloud_list_business_metric_sources", async (_e, { orgId }: { orgId: string }) => {
  const res = await cloudFetch<{ sources: unknown[] }>(orgId, "/business-metrics/importer-sources");
  return res?.sources ?? [];
});

ipcMain.handle(
  "cloud_list_business_metric_source_options",
  async (_e, { orgId, request }: { orgId: string; request: unknown }) => {
    const res = await cloudFetch<{ options: unknown[] }>(
      orgId,
      "/business-metrics/importer-options",
      { method: "POST", body: JSON.stringify(request) },
    );
    return res?.options ?? [];
  },
);

ipcMain.handle(
  "cloud_preview_business_metric_import",
  async (_e, { orgId, request }: { orgId: string; request: unknown }) => {
    return cloudFetch(orgId, "/business-metrics/importer-preview", {
      method: "POST",
      body: JSON.stringify(request),
    });
  },
);

ipcMain.handle(
  "cloud_get_business_metric_importer",
  async (_e, { orgId, metricId }: { orgId: string; metricId: string }) => {
    const res = await cloudFetch<{ importer: unknown }>(
      orgId,
      `/business-metrics/${encodeURIComponent(metricId)}/importer`,
    );
    return res?.importer ?? null;
  },
);

ipcMain.handle(
  "cloud_save_business_metric_importer",
  async (_e, { orgId, metricId, input }: { orgId: string; metricId: string; input: unknown }) => {
    return cloudFetch(orgId, `/business-metrics/${encodeURIComponent(metricId)}/importer`, {
      method: "PUT",
      body: JSON.stringify(input),
    });
  },
);

ipcMain.handle(
  "cloud_delete_business_metric_importer",
  async (_e, { orgId, metricId }: { orgId: string; metricId: string }) => {
    return cloudFetch(orgId, `/business-metrics/${encodeURIComponent(metricId)}/importer`, {
      method: "DELETE",
    });
  },
);

ipcMain.handle(
  "cloud_run_business_metric_importer",
  async (
    _e,
    { orgId, metricId, request }: { orgId: string; metricId: string; request?: unknown },
  ) => {
    return cloudFetch(orgId, `/business-metrics/${encodeURIComponent(metricId)}/importer/run`, {
      method: "POST",
      body: JSON.stringify(request ?? {}),
    });
  },
);

ipcMain.handle(
  "cloud_list_business_metric_import_runs",
  async (_e, { orgId, metricId, limit }: { orgId: string; metricId: string; limit?: number }) => {
    const res = await cloudFetch<{ runs: unknown[] }>(
      orgId,
      `/business-metrics/${encodeURIComponent(metricId)}/importer/runs?limit=${limit ?? 20}`,
    );
    return res?.runs ?? [];
  },
);

ipcMain.handle(
  "cloud_query_unit_costs",
  async (
    _e,
    { orgId, metricId, request }: { orgId: string; metricId: string; request: unknown },
  ) => {
    return cloudFetch(orgId, `/business-metrics/${encodeURIComponent(metricId)}/unit-costs`, {
      method: "POST",
      body: JSON.stringify(request),
    });
  },
);

ipcMain.handle(
  "cloud_query_usage_unit_costs",
  async (_e, { orgId, request }: { orgId: string; request: unknown }) => {
    return cloudFetch(orgId, "/business-metrics/usage-unit-costs", {
      method: "POST",
      body: JSON.stringify(request),
    });
  },
);

ipcMain.handle("cloud_list_usage_units", async (_e, { orgId }: { orgId: string }) => {
  const res = await cloudFetch<{ units: unknown[] }>(orgId, "/business-metrics/usage-units");
  return res?.units ?? [];
});

ipcMain.handle(
  "cloud_list_business_metric_labels",
  async (_e, { orgId, metricId }: { orgId: string; metricId: string }) => {
    const res = await cloudFetch<{ labels: unknown[] }>(
      orgId,
      `/business-metrics/${encodeURIComponent(metricId)}/labels`,
    );
    return res?.labels ?? [];
  },
);

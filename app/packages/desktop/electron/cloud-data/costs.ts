import { ipcMain } from "electron";
import { cloudFetch } from "./shared";

// Cost graphs, budgets, and dashboard widgets — cloud-mode only (there is no
// local-SQLite equivalent; cost data lives in the cloud ClickHouse store).

ipcMain.handle(
  "cloud_costs_query",
  async (_e, { orgId, request }: { orgId: string; request: unknown }) => {
    return cloudFetch(orgId, "/costs/query", { method: "POST", body: JSON.stringify(request) });
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

ipcMain.handle(
  "cloud_costs_anomalies",
  async (_e, { orgId, days }: { orgId: string; days?: number }) => {
    const params = new URLSearchParams();
    if (days) params.set("days", String(days));
    const qs = params.toString();
    return cloudFetch(orgId, `/costs/anomalies${qs ? `?${qs}` : ""}`);
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
 * Prepaid credit balances with their burn rate and runway. Cloud-only, like
 * every other read here — the burn is derived from a server-side series of
 * readings, and a local-only workspace has no series to derive it from.
 */
ipcMain.handle("cloud_credit_burndown", async (_e, { orgId }: { orgId: string }) => {
  return cloudFetch(orgId, "/credits");
});

/**
 * Commitments — reservations, savings plans, committed-use discounts — with
 * coverage, utilization and planner recommendations. Cloud-only: the
 * inventory is collected server-side and joined against server-side cost
 * rows; a local-only workspace has neither.
 */
ipcMain.handle("cloud_commitments", async (_e, { orgId }: { orgId: string }) => {
  return cloudFetch(orgId, "/commitments");
});

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
 * Change-based cost alerts — "spend moved more than X% (or $Y) vs the
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
 * Cost reports — named, saved cost graphs. Cloud-mode only for the same
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

ipcMain.handle(
  "cloud_run_cost_report",
  async (_e, { orgId, reportId }: { orgId: string; reportId: string }) => {
    return cloudFetch(orgId, `/cost-reports/${encodeURIComponent(reportId)}/run`, {
      method: "POST",
    });
  },
);

/* ------------------------------------------------------------------ *
 * Cost-report folders — the tree the Reports list groups by.
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
 * Report delivery schedules — scheduled sends of a saved report to
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
 * Saved cost filters — named `CostFilter[]` sets that graphs, reports and
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

// A 409 passes through as an error whose message lists the referents — the
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

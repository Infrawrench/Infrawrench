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

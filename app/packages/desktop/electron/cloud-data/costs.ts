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

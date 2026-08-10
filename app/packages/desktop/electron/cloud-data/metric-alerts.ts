import { ipcMain } from "electron";
import { cloudFetch } from "./shared";

// Metric threshold alert rules — cloud-mode only (evaluation runs in the
// cloud poller against the cloud ClickHouse metric store).

ipcMain.handle("cloud_metric_alerts_list", async (_e, { orgId }: { orgId: string }) => {
  return cloudFetch(orgId, "/metric-alerts");
});

ipcMain.handle(
  "cloud_metric_alerts_events",
  async (_e, { orgId, ruleId, limit }: { orgId: string; ruleId?: string; limit?: number }) => {
    const params = new URLSearchParams();
    if (ruleId) params.set("ruleId", ruleId);
    if (limit) params.set("limit", String(limit));
    const qs = params.toString();
    return cloudFetch(orgId, `/metric-alerts/events${qs ? `?${qs}` : ""}`);
  },
);

ipcMain.handle(
  "cloud_metric_alerts_metric_keys",
  async (
    _e,
    {
      orgId,
      pluginId,
      resourceTypeId,
    }: { orgId: string; pluginId?: string; resourceTypeId?: string },
  ) => {
    const params = new URLSearchParams();
    if (pluginId) params.set("pluginId", pluginId);
    if (resourceTypeId) params.set("resourceTypeId", resourceTypeId);
    const qs = params.toString();
    return cloudFetch(orgId, `/metric-alerts/metric-keys${qs ? `?${qs}` : ""}`);
  },
);

ipcMain.handle("cloud_metric_alerts_selector_options", async (_e, { orgId }: { orgId: string }) => {
  return cloudFetch(orgId, "/metric-alerts/selector-options");
});

ipcMain.handle(
  "cloud_metric_alerts_selector_preview",
  async (_e, { orgId, selector }: { orgId: string; selector: Record<string, string | null> }) => {
    const params = new URLSearchParams();
    for (const key of ["pluginId", "resourceTypeId", "tagKey", "tagValue"] as const) {
      const value = selector?.[key];
      if (value) params.set(key, value);
    }
    const qs = params.toString();
    return cloudFetch(orgId, `/metric-alerts/selector-preview${qs ? `?${qs}` : ""}`);
  },
);

ipcMain.handle(
  "cloud_metric_alerts_create",
  async (_e, { orgId, input }: { orgId: string; input: unknown }) => {
    return cloudFetch(orgId, "/metric-alerts", { method: "POST", body: JSON.stringify(input) });
  },
);

ipcMain.handle(
  "cloud_metric_alerts_update",
  async (_e, { orgId, ruleId, input }: { orgId: string; ruleId: string; input: unknown }) => {
    return cloudFetch(orgId, `/metric-alerts/${encodeURIComponent(ruleId)}`, {
      method: "PUT",
      body: JSON.stringify(input),
    });
  },
);

ipcMain.handle(
  "cloud_metric_alerts_delete",
  async (_e, { orgId, ruleId }: { orgId: string; ruleId: string }) => {
    return cloudFetch(orgId, `/metric-alerts/${encodeURIComponent(ruleId)}`, {
      method: "DELETE",
    });
  },
);

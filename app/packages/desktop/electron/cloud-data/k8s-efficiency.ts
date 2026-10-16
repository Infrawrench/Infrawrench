import { ipcMain } from "electron";
import { cloudFetch } from "./shared";

/* ------------------------------------------------------------------ *
 * Kubernetes efficiency reports (cloud mode only, like every cost
 * surface). Folders ride the existing `cloud_list_cost_report_folders`
 * channel and sharing the allowlisted settings channel.
 * ------------------------------------------------------------------ */

const enc = encodeURIComponent;
const BASE = "/k8s-efficiency-reports";
const reportPath = (reportId: string) => `${BASE}/${enc(reportId)}`;

ipcMain.handle("cloud_k8s_efficiency_list", async (_e, { orgId }: { orgId: string }) => {
  return (await cloudFetch(orgId, BASE)) ?? [];
});

ipcMain.handle(
  "cloud_k8s_efficiency_get",
  async (_e, { orgId, reportId }: { orgId: string; reportId: string }) => {
    return cloudFetch(orgId, reportPath(reportId));
  },
);

ipcMain.handle(
  "cloud_k8s_efficiency_run",
  async (_e, { orgId, reportId }: { orgId: string; reportId: string }) => {
    return cloudFetch(orgId, `${reportPath(reportId)}/run`, { method: "POST", body: "{}" });
  },
);

ipcMain.handle(
  "cloud_k8s_efficiency_query",
  async (_e, { orgId, config }: { orgId: string; config: unknown }) => {
    return cloudFetch(orgId, `${BASE}/query`, {
      method: "POST",
      body: JSON.stringify({ config }),
    });
  },
);

ipcMain.handle("cloud_k8s_efficiency_options", async (_e, { orgId }: { orgId: string }) => {
  return cloudFetch(orgId, `${BASE}/options`);
});

ipcMain.handle(
  "cloud_k8s_efficiency_values",
  async (_e, { orgId, tagKey }: { orgId: string; tagKey: string }) => {
    return cloudFetch(orgId, `${BASE}/values?tagKey=${enc(tagKey)}`);
  },
);

ipcMain.handle(
  "cloud_k8s_efficiency_create",
  async (_e, { orgId, input }: { orgId: string; input: unknown }) => {
    return cloudFetch(orgId, BASE, { method: "POST", body: JSON.stringify(input) });
  },
);

ipcMain.handle(
  "cloud_k8s_efficiency_update",
  async (_e, { orgId, reportId, input }: { orgId: string; reportId: string; input: unknown }) => {
    return cloudFetch(orgId, reportPath(reportId), { method: "PUT", body: JSON.stringify(input) });
  },
);

ipcMain.handle(
  "cloud_k8s_efficiency_delete",
  async (_e, { orgId, reportId }: { orgId: string; reportId: string }) => {
    return cloudFetch(orgId, reportPath(reportId), { method: "DELETE" });
  },
);

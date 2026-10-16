// Saved network flow reports (cloud-only): bytes and estimated cost by flow
// pair over time, read from the server's network-flow store. One channel per
// route, each on the preload allowlist; nothing here forwards an arbitrary
// path. Sharing goes through the existing `cloud_settings_request` channel,
// whose allowlist already covers `/sharing`.
import { ipcMain } from "electron";
import { cloudFetch } from "./shared";

const reportPath = (reportId: string) => `/network-flows/reports/${encodeURIComponent(reportId)}`;

ipcMain.handle("cloud_network_flow_reports", async (_e, { orgId }: { orgId: string }) => {
  return cloudFetch(orgId, "/network-flows/reports");
});

ipcMain.handle("cloud_network_flow_report_options", async (_e, { orgId }: { orgId: string }) => {
  return cloudFetch(orgId, "/network-flows/report-options");
});

ipcMain.handle(
  "cloud_network_flow_report_run",
  async (_e, { orgId, reportId }: { orgId: string; reportId: string }) => {
    return cloudFetch(orgId, `${reportPath(reportId)}/run`, { method: "POST", body: "{}" });
  },
);

ipcMain.handle(
  "cloud_network_flow_report_create",
  async (_e, { orgId, input }: { orgId: string; input: unknown }) => {
    return cloudFetch(orgId, "/network-flows/reports", {
      method: "POST",
      body: JSON.stringify(input),
    });
  },
);

ipcMain.handle(
  "cloud_network_flow_report_update",
  async (_e, { orgId, reportId, input }: { orgId: string; reportId: string; input: unknown }) => {
    return cloudFetch(orgId, reportPath(reportId), {
      method: "PUT",
      body: JSON.stringify(input),
    });
  },
);

ipcMain.handle(
  "cloud_network_flow_report_delete",
  async (_e, { orgId, reportId }: { orgId: string; reportId: string }) => {
    await cloudFetch(orgId, reportPath(reportId), { method: "DELETE" });
  },
);

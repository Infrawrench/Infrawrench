// Saved commitment reports (cloud-only): coverage, utilization and savings
// over time, read from server-side cost rows and the commitment inventory.
// One channel per route, each on the preload allowlist; nothing here
// forwards an arbitrary path.
import { ipcMain } from "electron";
import { cloudFetch } from "./shared";

const reportPath = (reportId: string) => `/commitments/reports/${encodeURIComponent(reportId)}`;

ipcMain.handle("cloud_commitment_reports", async (_e, { orgId }: { orgId: string }) => {
  return cloudFetch(orgId, "/commitments/reports");
});

ipcMain.handle("cloud_commitment_report_options", async (_e, { orgId }: { orgId: string }) => {
  return cloudFetch(orgId, "/commitments/report-options");
});

ipcMain.handle(
  "cloud_commitment_report_run",
  async (_e, { orgId, reportId }: { orgId: string; reportId: string }) => {
    return cloudFetch(orgId, `${reportPath(reportId)}/run`, { method: "POST", body: "{}" });
  },
);

ipcMain.handle(
  "cloud_commitment_report_create",
  async (_e, { orgId, input }: { orgId: string; input: unknown }) => {
    return cloudFetch(orgId, "/commitments/reports", {
      method: "POST",
      body: JSON.stringify(input),
    });
  },
);

ipcMain.handle(
  "cloud_commitment_report_update",
  async (_e, { orgId, reportId, input }: { orgId: string; reportId: string; input: unknown }) => {
    return cloudFetch(orgId, reportPath(reportId), {
      method: "PUT",
      body: JSON.stringify(input),
    });
  },
);

ipcMain.handle(
  "cloud_commitment_report_delete",
  async (_e, { orgId, reportId }: { orgId: string; reportId: string }) => {
    await cloudFetch(orgId, reportPath(reportId), { method: "DELETE" });
  },
);

import { ipcMain } from "electron";
import { cloudFetch, cloudFetchText } from "./shared";

// Resource reports: cloud-mode only. The report is an org row and its rows
// are a server-side join of the synced inventory with the cost store, so
// local mode has neither half.

const base = "/resource-reports";
const one = (reportId: string) => `${base}/${encodeURIComponent(reportId)}`;

ipcMain.handle("cloud_resource_reports_list", async (_e, { orgId }: { orgId: string }) => {
  return cloudFetch(orgId, base);
});

ipcMain.handle(
  "cloud_resource_reports_get",
  async (_e, { orgId, reportId }: { orgId: string; reportId: string }) => {
    return cloudFetch(orgId, one(reportId));
  },
);

ipcMain.handle("cloud_resource_reports_folders", async (_e, { orgId }: { orgId: string }) => {
  return cloudFetch(orgId, `${base}/folders`);
});

ipcMain.handle(
  "cloud_resource_reports_options",
  async (_e, { orgId, types }: { orgId: string; types: string }) => {
    return cloudFetch(
      orgId,
      `${base}/options${types ? `?types=${encodeURIComponent(types)}` : ""}`,
    );
  },
);

ipcMain.handle(
  "cloud_resource_reports_tag_values",
  async (_e, { orgId, source, key }: { orgId: string; source: string; key: string }) => {
    const params = new URLSearchParams({ source, key });
    return cloudFetch(orgId, `${base}/tag-values?${params.toString()}`);
  },
);

ipcMain.handle(
  "cloud_resource_reports_query",
  async (_e, { orgId, request }: { orgId: string; request: unknown }) => {
    return cloudFetch(orgId, `${base}/query`, { method: "POST", body: JSON.stringify(request) });
  },
);

// CSV is text, not JSON, so `cloudFetchText`; the renderer hands the body to
// the browser's own download path, as the FOCUS export does.
ipcMain.handle(
  "cloud_resource_reports_csv",
  async (_e, { orgId, config, name }: { orgId: string; config: unknown; name: string }) => {
    return cloudFetchText(orgId, `${base}/csv`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ config, name }),
    });
  },
);

ipcMain.handle(
  "cloud_resource_reports_create",
  async (_e, { orgId, input }: { orgId: string; input: unknown }) => {
    return cloudFetch(orgId, base, { method: "POST", body: JSON.stringify(input) });
  },
);

ipcMain.handle(
  "cloud_resource_reports_update",
  async (_e, { orgId, reportId, input }: { orgId: string; reportId: string; input: unknown }) => {
    return cloudFetch(orgId, one(reportId), { method: "PUT", body: JSON.stringify(input) });
  },
);

ipcMain.handle(
  "cloud_resource_reports_delete",
  async (_e, { orgId, reportId }: { orgId: string; reportId: string }) => {
    return cloudFetch(orgId, one(reportId), { method: "DELETE" });
  },
);

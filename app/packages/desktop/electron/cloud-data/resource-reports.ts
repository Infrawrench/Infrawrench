import { ipcMain } from "electron";
import { cloudFetchText } from "./shared";

// Resource reports: cloud-mode only. Every JSON route is a typed call over the
// cloud transport (`src/lib/resource-reports-client.ts`); the CSV export
// stays here until the transport reads a text answer.

// CSV is text, not JSON, so `cloudFetchText`; the renderer hands the body to
// the browser's own download path, as the FOCUS export does.
ipcMain.handle(
  "cloud_resource_reports_csv",
  async (_e, { orgId, config, name }: { orgId: string; config: unknown; name: string }) => {
    return cloudFetchText(orgId, "/resource-reports/csv", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ config, name }),
    });
  },
);

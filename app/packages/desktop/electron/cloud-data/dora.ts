import { ipcMain } from "electron";
import { cloudFetch } from "./shared";

// Delivery (DORA metrics): cloud-mode only. The deploy events, incidents and
// commit times live in the cloud; the renderer passes the query string it
// built with `doraQueryString`, and the path is fixed here.

/** Only the query string crosses IPC; a path or a host never does. */
function query(qs: unknown): string {
  if (typeof qs !== "string" || /[\s#/?]/.test(qs)) return "";
  return qs ? `?${qs}` : "";
}

ipcMain.handle("cloud_dora_report", async (_e, { orgId, qs }: { orgId: string; qs: string }) => {
  return cloudFetch(orgId, `/dora${query(qs)}`);
});

ipcMain.handle("cloud_dora_changes", async (_e, { orgId, qs }: { orgId: string; qs: string }) => {
  return cloudFetch(orgId, `/dora/changes${query(qs)}`);
});

ipcMain.handle("cloud_dora_restores", async (_e, { orgId, qs }: { orgId: string; qs: string }) => {
  return cloudFetch(orgId, `/dora/restores${query(qs)}`);
});

ipcMain.handle("cloud_dora_settings_get", async (_e, { orgId }: { orgId: string }) => {
  return cloudFetch(orgId, "/dora/settings");
});

ipcMain.handle(
  "cloud_dora_settings_update",
  async (_e, { orgId, patch }: { orgId: string; patch: unknown }) => {
    return cloudFetch(orgId, "/dora/settings", { method: "PUT", body: JSON.stringify(patch) });
  },
);

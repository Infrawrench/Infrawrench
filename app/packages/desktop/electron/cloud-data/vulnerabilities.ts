import { ipcMain } from "electron";
import { cloudFetch } from "./shared";

// Vulnerabilities: cloud only. Findings are collected from each provider's
// own scanner by the cloud poller and joined to synced resources server-side
// (`GET /vulnerabilities`, the endpoint the web tab, mobile and the CLI's
// `infrawrench vulnerabilities` read). Local mode has no poller to collect
// them, so there is deliberately no local counterpart.

ipcMain.handle("cloud_vulnerabilities", async (_e, { orgId }: { orgId: string }) => {
  return cloudFetch(orgId, "/vulnerabilities");
});

// A dismissal is org state (it silences the org's alerts too), so it is
// recorded through the API like the posture one. `artifactKey` "*" means the
// advisory everywhere.
ipcMain.handle(
  "cloud_vulnerabilities_dismiss",
  async (
    _e,
    {
      orgId,
      advisoryId,
      artifactKey,
      reason,
    }: { orgId: string; advisoryId: string; artifactKey: string; reason?: string },
  ) => {
    const trimmed = reason?.trim();
    return cloudFetch(orgId, "/vulnerabilities/dismissals", {
      method: "POST",
      body: JSON.stringify({ advisoryId, artifactKey, ...(trimmed ? { reason: trimmed } : {}) }),
    });
  },
);

// The key travels in the query: artifact keys carry slashes.
ipcMain.handle(
  "cloud_vulnerabilities_restore",
  async (
    _e,
    { orgId, advisoryId, artifactKey }: { orgId: string; advisoryId: string; artifactKey: string },
  ) => {
    const query = new URLSearchParams({ advisoryId, artifactKey });
    return cloudFetch(orgId, `/vulnerabilities/dismissals?${query.toString()}`, {
      method: "DELETE",
    });
  },
);

ipcMain.handle("cloud_vulnerability_settings_get", async (_e, { orgId }: { orgId: string }) => {
  return cloudFetch(orgId, "/vulnerabilities/settings");
});

ipcMain.handle(
  "cloud_vulnerability_settings_update",
  async (
    _e,
    {
      orgId,
      patch,
    }: {
      orgId: string;
      patch: { alertsEnabled?: boolean; minSeverity?: "critical" | "high"; runningOnly?: boolean };
    },
  ) => {
    return cloudFetch(orgId, "/vulnerabilities/settings", {
      method: "PUT",
      body: JSON.stringify(patch),
    });
  },
);

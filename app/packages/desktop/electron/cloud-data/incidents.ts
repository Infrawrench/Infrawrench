import { ipcMain } from "electron";
import { cloudFetch } from "./shared";

// Incident mode — cloud-mode only. An incident is org-scoped, and declaring one
// composes cloud features (change freezes, alert routing, status pages), none of
// which a local-mode desktop app has. The "incident" here is the declared kind,
// not a provider status incident.

ipcMain.handle(
  "cloud_incidents_list",
  async (_e, { orgId, status }: { orgId: string; status?: string }) => {
    const query = status && status !== "all" ? `?status=${encodeURIComponent(status)}` : "";
    return cloudFetch(orgId, `/incidents${query}`);
  },
);

ipcMain.handle(
  "cloud_incidents_get",
  async (_e, { orgId, incidentId }: { orgId: string; incidentId: string }) => {
    return cloudFetch(orgId, `/incidents/${encodeURIComponent(incidentId)}`);
  },
);

ipcMain.handle(
  "cloud_incidents_timeline",
  async (_e, { orgId, incidentId }: { orgId: string; incidentId: string }) => {
    return cloudFetch(orgId, `/incidents/${encodeURIComponent(incidentId)}/timeline`);
  },
);

ipcMain.handle(
  "cloud_incidents_postmortem",
  async (_e, { orgId, incidentId }: { orgId: string; incidentId: string }) => {
    return cloudFetch(orgId, `/incidents/${encodeURIComponent(incidentId)}/postmortem`);
  },
);

ipcMain.handle(
  "cloud_incidents_declare",
  async (_e, { orgId, input }: { orgId: string; input: unknown }) => {
    return cloudFetch(orgId, "/incidents", { method: "POST", body: JSON.stringify(input) });
  },
);

ipcMain.handle(
  "cloud_incidents_update",
  async (
    _e,
    { orgId, incidentId, patch }: { orgId: string; incidentId: string; patch: unknown },
  ) => {
    return cloudFetch(orgId, `/incidents/${encodeURIComponent(incidentId)}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    });
  },
);

ipcMain.handle(
  "cloud_incidents_retry_artifacts",
  async (_e, { orgId, incidentId }: { orgId: string; incidentId: string }) => {
    return cloudFetch(orgId, `/incidents/${encodeURIComponent(incidentId)}/retry-artifacts`, {
      method: "POST",
      body: "{}",
    });
  },
);

ipcMain.handle(
  "cloud_incidents_add_note",
  async (_e, { orgId, incidentId, body }: { orgId: string; incidentId: string; body: unknown }) => {
    return cloudFetch(orgId, `/incidents/${encodeURIComponent(incidentId)}/notes`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  },
);

ipcMain.handle(
  "cloud_incidents_delete_note",
  async (
    _e,
    { orgId, incidentId, noteId }: { orgId: string; incidentId: string; noteId: string },
  ) => {
    return cloudFetch(
      orgId,
      `/incidents/${encodeURIComponent(incidentId)}/notes/${encodeURIComponent(noteId)}`,
      { method: "DELETE" },
    );
  },
);

ipcMain.handle(
  "cloud_incidents_delete",
  async (_e, { orgId, incidentId }: { orgId: string; incidentId: string }) => {
    return cloudFetch(orgId, `/incidents/${encodeURIComponent(incidentId)}`, { method: "DELETE" });
  },
);

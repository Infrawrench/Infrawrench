import { ipcMain } from "electron";
import { cloudFetch } from "./shared";

// Ephemeral environments — cloud-mode only. An environment is created against
// org accounts, recorded in org tables and torn down by the cloud lease pass;
// there is no local half to mirror, so unlike the environment diff this file
// has no renderer-side counterpart.

ipcMain.handle("cloud_environments_templates", async (_e, { orgId }: { orgId: string }) => {
  return cloudFetch(orgId, "/environments/templates");
});

ipcMain.handle("cloud_environments_instances", async (_e, { orgId }: { orgId: string }) => {
  return cloudFetch(orgId, "/environments/instances");
});

ipcMain.handle("cloud_environments_settings", async (_e, { orgId }: { orgId: string }) => {
  return cloudFetch(orgId, "/environments/settings");
});

ipcMain.handle(
  "cloud_environments_settings_update",
  async (_e, { orgId, settings }: { orgId: string; settings: unknown }) => {
    return cloudFetch(orgId, "/environments/settings", {
      method: "PUT",
      body: JSON.stringify(settings),
    });
  },
);

ipcMain.handle(
  "cloud_environments_capture",
  async (_e, { orgId, selector }: { orgId: string; selector: unknown }) => {
    return cloudFetch(orgId, "/environments/capture", {
      method: "POST",
      body: JSON.stringify(selector),
    });
  },
);

ipcMain.handle(
  "cloud_environments_template_create",
  async (_e, { orgId, input }: { orgId: string; input: unknown }) => {
    return cloudFetch(orgId, "/environments/templates", {
      method: "POST",
      body: JSON.stringify(input),
    });
  },
);

ipcMain.handle(
  "cloud_environments_template_delete",
  async (_e, { orgId, templateId }: { orgId: string; templateId: string }) => {
    return cloudFetch(orgId, `/environments/templates/${encodeURIComponent(templateId)}`, {
      method: "DELETE",
    });
  },
);

ipcMain.handle(
  "cloud_environments_estimate",
  async (_e, { orgId, templateId, body }: { orgId: string; templateId: string; body: unknown }) => {
    return cloudFetch(orgId, `/environments/templates/${encodeURIComponent(templateId)}/estimate`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  },
);

ipcMain.handle(
  "cloud_environments_instantiate",
  async (_e, { orgId, templateId, body }: { orgId: string; templateId: string; body: unknown }) => {
    return cloudFetch(
      orgId,
      `/environments/templates/${encodeURIComponent(templateId)}/instantiate`,
      { method: "POST", body: JSON.stringify(body) },
    );
  },
);

ipcMain.handle(
  "cloud_environments_teardown",
  async (_e, { orgId, instanceId }: { orgId: string; instanceId: string }) => {
    return cloudFetch(orgId, `/environments/instances/${encodeURIComponent(instanceId)}/teardown`, {
      method: "POST",
    });
  },
);

ipcMain.handle(
  "cloud_environments_forget",
  async (_e, { orgId, instanceId }: { orgId: string; instanceId: string }) => {
    return cloudFetch(orgId, `/environments/instances/${encodeURIComponent(instanceId)}`, {
      method: "DELETE",
    });
  },
);

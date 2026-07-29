import { ipcMain } from "electron";
import { cloudFetch } from "./shared";

ipcMain.handle("cloud_list_dashboards", async (_e, { orgId }: { orgId: string }) => {
  return (
    (await cloudFetch<Array<{ id: string; name: string; isDefault: boolean }>>(
      orgId,
      "/dashboards",
    )) ?? []
  );
});

ipcMain.handle(
  "cloud_get_dashboard",
  async (_e, { orgId, dashboardId }: { orgId: string; dashboardId: string }) => {
    return cloudFetch(orgId, `/dashboards/${encodeURIComponent(dashboardId)}`);
  },
);

ipcMain.handle(
  "cloud_create_dashboard",
  async (_e, { orgId, name }: { orgId: string; name: string }) => {
    return cloudFetch<{ id: string; name: string; isDefault: boolean }>(orgId, "/dashboards", {
      method: "POST",
      body: JSON.stringify({ name }),
    });
  },
);

ipcMain.handle(
  "cloud_delete_dashboard",
  async (_e, { orgId, id }: { orgId: string; id: string }) => {
    await cloudFetch(orgId, `/dashboards/${encodeURIComponent(id)}`, { method: "DELETE" });
    return { ok: true };
  },
);

ipcMain.handle(
  "cloud_rename_dashboard",
  async (_e, { orgId, id, name }: { orgId: string; id: string; name: string }) => {
    await cloudFetch(orgId, `/dashboards/${encodeURIComponent(id)}/rename`, {
      method: "POST",
      body: JSON.stringify({ name }),
    });
    return { ok: true };
  },
);

ipcMain.handle(
  "cloud_pin_resource",
  async (
    _e,
    { orgId, dashboardId, resourceId }: { orgId: string; dashboardId: string; resourceId: string },
  ) => {
    await cloudFetch(orgId, `/dashboards/pin`, {
      method: "POST",
      body: JSON.stringify({ dashboardId, resourceId }),
    });
    return { ok: true };
  },
);

ipcMain.handle(
  "cloud_unpin_resource",
  async (
    _e,
    { orgId, dashboardId, resourceId }: { orgId: string; dashboardId: string; resourceId: string },
  ) => {
    await cloudFetch(orgId, `/dashboards/unpin`, {
      method: "POST",
      body: JSON.stringify({ dashboardId, resourceId }),
    });
    return { ok: true };
  },
);

ipcMain.handle(
  "cloud_pin_workflow",
  async (
    _e,
    { orgId, dashboardId, workflowId }: { orgId: string; dashboardId: string; workflowId: string },
  ) => {
    await cloudFetch(orgId, `/dashboards/workflow-pin`, {
      method: "POST",
      body: JSON.stringify({ dashboardId, workflowId }),
    });
    return { ok: true };
  },
);

ipcMain.handle(
  "cloud_unpin_workflow",
  async (
    _e,
    { orgId, dashboardId, workflowId }: { orgId: string; dashboardId: string; workflowId: string },
  ) => {
    await cloudFetch(orgId, `/dashboards/workflow-unpin`, {
      method: "POST",
      body: JSON.stringify({ dashboardId, workflowId }),
    });
    return { ok: true };
  },
);

// `cards` is the whole grid in its new order — resource pins, workflow pins,
// and widgets share one drag sequence, so the reorder can't be expressed as
// resource ids alone.
ipcMain.handle(
  "cloud_reorder_pins",
  async (
    _e,
    {
      orgId,
      dashboardId,
      cards,
    }: { orgId: string; dashboardId: string; cards: Array<{ kind: string; id: string }> },
  ) => {
    await cloudFetch(orgId, `/dashboards/${encodeURIComponent(dashboardId)}/reorder`, {
      method: "POST",
      body: JSON.stringify({ cards }),
    });
    return { ok: true };
  },
);

ipcMain.handle(
  "cloud_probe_pins",
  async (_e, { orgId, items }: { orgId: string; items: unknown[] }) => {
    return (
      (await cloudFetch<Record<string, unknown>>(orgId, `/dashboards/probe`, {
        method: "POST",
        body: JSON.stringify({ items }),
      })) ?? {}
    );
  },
);

ipcMain.handle("cloud_get_pin", async (_e, { orgId, pinId }: { orgId: string; pinId: string }) => {
  return cloudFetch(orgId, `/dashboards/pin/${encodeURIComponent(pinId)}`);
});

// Restored workspace tabs point at cloud rows when an org is active, so they
// have to be validated against the org — the local database knows nothing
// about them.
ipcMain.handle(
  "cloud_validate_tabs",
  async (_e, { orgId, tabs }: { orgId: string; tabs: Array<{ id: string; target: unknown }> }) => {
    return (
      (await cloudFetch<{ validTabIds: string[] }>(orgId, `/dashboards/validate-tabs`, {
        method: "POST",
        body: JSON.stringify({ tabs }),
      })) ?? { validTabIds: [] }
    );
  },
);

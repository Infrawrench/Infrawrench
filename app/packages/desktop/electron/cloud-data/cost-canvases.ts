import { ipcMain } from "electron";
import { cloudFetch, cloudFetchBytes } from "./shared";

/* ------------------------------------------------------------------ *
 * Cost canvases: reports built from a description by the chat agent.
 * Cloud-mode only, like every cost surface. The conversation that builds a
 * canvas is the ordinary chat (cloud-data/chat.ts); these channels cover the
 * canvas object itself, its run/preview, PDF and delivery schedules.
 * ------------------------------------------------------------------ */

const enc = encodeURIComponent;
const canvasPath = (canvasId: string) => `/cost-canvases/${enc(canvasId)}`;

function withPdfTimezone(path: string): string {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return tz ? `${path}?tz=${enc(tz)}` : path;
}

ipcMain.handle("cloud_cost_canvases_list", async (_e, { orgId }: { orgId: string }) => {
  return (await cloudFetch(orgId, "/cost-canvases")) ?? [];
});

ipcMain.handle(
  "cloud_cost_canvas_get",
  async (_e, { orgId, canvasId }: { orgId: string; canvasId: string }) => {
    return cloudFetch(orgId, canvasPath(canvasId));
  },
);

ipcMain.handle(
  "cloud_cost_canvas_run",
  async (
    _e,
    {
      orgId,
      canvasId,
      includeChartData,
    }: { orgId: string; canvasId: string; includeChartData?: boolean },
  ) => {
    return cloudFetch(orgId, `${canvasPath(canvasId)}/run`, {
      method: "POST",
      body: JSON.stringify({ includeChartData: includeChartData !== false }),
    });
  },
);

ipcMain.handle(
  "cloud_cost_canvas_preview",
  async (_e, { orgId, spec, name }: { orgId: string; spec: unknown; name: string }) => {
    return cloudFetch(orgId, "/cost-canvases/preview", {
      method: "POST",
      body: JSON.stringify({ spec, name, includeChartData: false }),
    });
  },
);

ipcMain.handle(
  "cloud_cost_canvas_draft",
  async (_e, { orgId, input }: { orgId: string; input: unknown }) => {
    return cloudFetch(orgId, "/cost-canvases/draft", {
      method: "POST",
      body: JSON.stringify(input),
    });
  },
);

ipcMain.handle(
  "cloud_cost_canvas_update",
  async (_e, { orgId, canvasId, input }: { orgId: string; canvasId: string; input: unknown }) => {
    return cloudFetch(orgId, canvasPath(canvasId), {
      method: "PUT",
      body: JSON.stringify(input),
    });
  },
);

ipcMain.handle(
  "cloud_cost_canvas_delete",
  async (_e, { orgId, canvasId }: { orgId: string; canvasId: string }) => {
    return cloudFetch(orgId, canvasPath(canvasId), { method: "DELETE" });
  },
);

ipcMain.handle(
  "cloud_cost_canvas_conversation",
  async (_e, { orgId, canvasId, fresh }: { orgId: string; canvasId: string; fresh?: boolean }) => {
    return cloudFetch(orgId, `${canvasPath(canvasId)}/conversation`, {
      method: "POST",
      body: JSON.stringify(fresh ? { fresh: true } : {}),
    });
  },
);

ipcMain.handle(
  "cloud_cost_canvas_pdf",
  async (_e, { orgId, canvasId }: { orgId: string; canvasId: string }) => {
    return cloudFetchBytes(orgId, withPdfTimezone(`${canvasPath(canvasId)}/pdf`));
  },
);

ipcMain.handle(
  "cloud_cost_canvas_notifications",
  async (_e, { orgId, canvasId }: { orgId: string; canvasId: string }) => {
    return (await cloudFetch(orgId, `${canvasPath(canvasId)}/notifications`)) ?? [];
  },
);

ipcMain.handle(
  "cloud_cost_canvas_delivery_targets",
  async (_e, { orgId, canvasId }: { orgId: string; canvasId: string }) => {
    return cloudFetch(orgId, `${canvasPath(canvasId)}/notifications/targets`);
  },
);

ipcMain.handle(
  "cloud_create_cost_canvas_notification",
  async (_e, { orgId, canvasId, input }: { orgId: string; canvasId: string; input: unknown }) => {
    return cloudFetch(orgId, `${canvasPath(canvasId)}/notifications`, {
      method: "POST",
      body: JSON.stringify(input),
    });
  },
);

ipcMain.handle(
  "cloud_update_cost_canvas_notification",
  async (
    _e,
    {
      orgId,
      canvasId,
      notificationId,
      input,
    }: { orgId: string; canvasId: string; notificationId: string; input: unknown },
  ) => {
    return cloudFetch(orgId, `${canvasPath(canvasId)}/notifications/${enc(notificationId)}`, {
      method: "PUT",
      body: JSON.stringify(input),
    });
  },
);

ipcMain.handle(
  "cloud_delete_cost_canvas_notification",
  async (
    _e,
    {
      orgId,
      canvasId,
      notificationId,
    }: { orgId: string; canvasId: string; notificationId: string },
  ) => {
    return cloudFetch(orgId, `${canvasPath(canvasId)}/notifications/${enc(notificationId)}`, {
      method: "DELETE",
    });
  },
);

ipcMain.handle(
  "cloud_send_cost_canvas_notification",
  async (
    _e,
    {
      orgId,
      canvasId,
      notificationId,
    }: { orgId: string; canvasId: string; notificationId: string },
  ) => {
    return cloudFetch(orgId, `${canvasPath(canvasId)}/notifications/${enc(notificationId)}/send`, {
      method: "POST",
      body: "{}",
    });
  },
);

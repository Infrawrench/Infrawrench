/**
 * The desktop Canvases client (cloud mode): the shared cost reads from
 * {@link createDesktopCostApi}, canvas calls over the `cloud_cost_canvas_*`
 * IPC channels (electron/cloud-data/cost-canvases.ts), sharing over the
 * allowlisted settings channel, and the desktop chat client for the side
 * conversation. Built per org (the viewport keys the panel by org), because
 * the chat client binds its org at construction.
 */
import {
  pdfFileName,
  type CostCanvas,
  type CostCanvasDraftInput,
  type CostCanvasInput,
  type CostCanvasNotification,
  type CostCanvasNotificationInput,
  type CostCanvasNotificationSendResult,
  type CostCanvasRunResult,
  type CostCanvasSpec,
  type ReportDeliveryTargets,
} from "@infrawrench/client-core";
import { downloadPdfBytes } from "@infrawrench/ui";
import type { CostCanvasesClient } from "@infrawrench/ui/cost-canvases";
import type { CostsPanelDashboard } from "@infrawrench/ui/cost";
import { invoke } from "./invoke";
import { createCloudWidget, deleteCloudWidget } from "./cloud-costs";
import { listCloudDashboards } from "./cloud-dashboards";
import { createDesktopCostApi } from "./cost-api";
import { createDesktopChatClient } from "./cloud-chat";
import { createDesktopSharingClient } from "./cost-reports-client";

export function createDesktopCostCanvasesClient(orgId: string): CostCanvasesClient {
  return {
    ...createDesktopCostApi(),
    chat: createDesktopChatClient(orgId),
    sharing: createDesktopSharingClient(),
    listCanvases: async () =>
      (await invoke<CostCanvas[]>("cloud_cost_canvases_list", { orgId })) ?? [],
    getCanvas: (canvasId: string) =>
      invoke<CostCanvas>("cloud_cost_canvas_get", { orgId, canvasId }),
    runCanvas: (canvasId: string, opts?: { includeChartData?: boolean }) =>
      invoke<CostCanvasRunResult>("cloud_cost_canvas_run", {
        orgId,
        canvasId,
        includeChartData: opts?.includeChartData ?? true,
      }),
    previewCanvas: (spec: CostCanvasSpec, name: string) =>
      invoke<CostCanvasRunResult>("cloud_cost_canvas_preview", { orgId, spec, name }),
    draftCanvas: (input: CostCanvasDraftInput) =>
      invoke<CostCanvas>("cloud_cost_canvas_draft", { orgId, input }),
    updateCanvas: (canvasId: string, input: CostCanvasInput) =>
      invoke<CostCanvas>("cloud_cost_canvas_update", { orgId, canvasId, input }),
    deleteCanvas: async (canvasId: string) => {
      await invoke("cloud_cost_canvas_delete", { orgId, canvasId });
    },
    ensureConversation: async (canvasId: string, opts?: { fresh?: boolean }) => {
      const res = await invoke<{ conversationId: string }>("cloud_cost_canvas_conversation", {
        orgId,
        canvasId,
        ...(opts?.fresh ? { fresh: true } : {}),
      });
      return res.conversationId;
    },
    listDashboards: async (): Promise<CostsPanelDashboard[]> => {
      const rows = await listCloudDashboards(orgId);
      return rows.map((d) => ({ id: d.id, name: d.name }));
    },
    addCanvasToDashboard: async (dashboardId: string, canvasId: string, title: string) => {
      await createCloudWidget(orgId, {
        dashboardId,
        kind: "cost_canvas",
        title,
        config: { version: 1, canvasId },
      });
    },
    removeCanvasPlacement: (widgetId: string) => deleteCloudWidget(orgId, widgetId),
    downloadCanvasPdf: async (canvasId: string, canvasName: string) => {
      const bytes = await invoke<Uint8Array>("cloud_cost_canvas_pdf", { orgId, canvasId });
      downloadPdfBytes(bytes, pdfFileName(canvasName, "canvas"));
    },
    listCanvasNotifications: async (canvasId: string) =>
      (await invoke<CostCanvasNotification[]>("cloud_cost_canvas_notifications", {
        orgId,
        canvasId,
      })) ?? [],
    listCanvasDeliveryTargets: (canvasId: string) =>
      invoke<ReportDeliveryTargets>("cloud_cost_canvas_delivery_targets", { orgId, canvasId }),
    createCanvasNotification: (canvasId: string, input: CostCanvasNotificationInput) =>
      invoke<CostCanvasNotification>("cloud_create_cost_canvas_notification", {
        orgId,
        canvasId,
        input,
      }),
    updateCanvasNotification: (
      canvasId: string,
      notificationId: string,
      input: CostCanvasNotificationInput,
    ) =>
      invoke<CostCanvasNotification>("cloud_update_cost_canvas_notification", {
        orgId,
        canvasId,
        notificationId,
        input,
      }),
    deleteCanvasNotification: async (canvasId: string, notificationId: string) => {
      await invoke("cloud_delete_cost_canvas_notification", { orgId, canvasId, notificationId });
    },
    sendCanvasNotificationNow: (canvasId: string, notificationId: string) =>
      invoke<CostCanvasNotificationSendResult>("cloud_send_cost_canvas_notification", {
        orgId,
        canvasId,
        notificationId,
      }),
  };
}

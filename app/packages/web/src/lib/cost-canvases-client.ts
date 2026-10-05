/**
 * The web Canvases client: canvas CRUD, run/preview, the editing
 * conversation, sharing, dashboard placement, PDF and delivery, over
 * cookie-authenticated fetch. Spreads `createWebCostApi` so canvas charts
 * query exactly the endpoint a dashboard cost card does, and carries the web
 * chat client so the side conversation is the ordinary chat.
 */
import {
  pdfFileName,
  withPdfTimezone,
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
import { downloadBlob } from "@infrawrench/ui";
import type { CostCanvasesClient } from "@infrawrench/ui/cost-canvases";
import type { CostsPanelDashboard } from "@infrawrench/ui/cost";
import { apiDelete, apiGet, apiGetBlob, apiPost, apiPut } from "./api";
import { createWebCostApi, createWebSharingClient } from "./cost-client";
import { createWebChatClient } from "./chat-client";

export function createWebCostCanvasesClient(orgId: string): CostCanvasesClient {
  const base = `/api/org/${orgId}/cost-canvases`;
  return {
    ...createWebCostApi(orgId),
    chat: createWebChatClient(orgId),
    sharing: createWebSharingClient(orgId),
    listCanvases: () => apiGet<CostCanvas[]>(base),
    getCanvas: (canvasId: string) => apiGet<CostCanvas>(`${base}/${canvasId}`),
    runCanvas: (canvasId: string, opts?: { includeChartData?: boolean }) =>
      apiPost<CostCanvasRunResult>(`${base}/${canvasId}/run`, {
        includeChartData: opts?.includeChartData ?? true,
      }),
    previewCanvas: (spec: CostCanvasSpec, name: string) =>
      apiPost<CostCanvasRunResult>(`${base}/preview`, { spec, name, includeChartData: false }),
    draftCanvas: (input: CostCanvasDraftInput) => apiPost<CostCanvas>(`${base}/draft`, input),
    updateCanvas: (canvasId: string, input: CostCanvasInput) =>
      apiPut<CostCanvas>(`${base}/${canvasId}`, input),
    deleteCanvas: async (canvasId: string) => {
      await apiDelete(`${base}/${canvasId}`);
    },
    ensureConversation: async (canvasId: string, opts?: { fresh?: boolean }) => {
      const res = await apiPost<{ conversationId: string }>(`${base}/${canvasId}/conversation`, {
        ...(opts?.fresh ? { fresh: true } : {}),
      });
      return res.conversationId;
    },
    listDashboards: () => apiGet<CostsPanelDashboard[]>(`/api/org/${orgId}/dashboards`),
    addCanvasToDashboard: async (dashboardId: string, canvasId: string, title: string) => {
      await apiPost(`/api/org/${orgId}/dashboards/widgets`, {
        dashboardId,
        kind: "cost_canvas",
        title,
        config: { version: 1, canvasId },
      });
    },
    removeCanvasPlacement: async (widgetId: string) => {
      await apiDelete(`/api/org/${orgId}/dashboards/widgets/${widgetId}`);
    },
    downloadCanvasPdf: async (canvasId: string, canvasName: string) => {
      const blob = await apiGetBlob(withPdfTimezone(`${base}/${canvasId}/pdf`));
      downloadBlob(blob, pdfFileName(canvasName, "canvas"));
    },
    listCanvasNotifications: (canvasId: string) =>
      apiGet<CostCanvasNotification[]>(`${base}/${canvasId}/notifications`),
    listCanvasDeliveryTargets: (canvasId: string) =>
      apiGet<ReportDeliveryTargets>(`${base}/${canvasId}/notifications/targets`),
    createCanvasNotification: (canvasId: string, input: CostCanvasNotificationInput) =>
      apiPost<CostCanvasNotification>(`${base}/${canvasId}/notifications`, input),
    updateCanvasNotification: (
      canvasId: string,
      notificationId: string,
      input: CostCanvasNotificationInput,
    ) =>
      apiPut<CostCanvasNotification>(`${base}/${canvasId}/notifications/${notificationId}`, input),
    deleteCanvasNotification: async (canvasId: string, notificationId: string) => {
      await apiDelete(`${base}/${canvasId}/notifications/${notificationId}`);
    },
    sendCanvasNotificationNow: (canvasId: string, notificationId: string) =>
      apiPost<CostCanvasNotificationSendResult>(
        `${base}/${canvasId}/notifications/${notificationId}/send`,
        {},
      ),
  };
}

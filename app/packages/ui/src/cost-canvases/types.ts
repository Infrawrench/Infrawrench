import type {
  CostCanvas,
  CostCanvasDraftInput,
  CostCanvasInput,
  CostCanvasNotification,
  CostCanvasNotificationInput,
  CostCanvasNotificationSendResult,
  CostCanvasRunResult,
  CostCanvasSpec,
  ReportDeliveryTargets,
} from "@infrawrench/client-core";
import type { ChatClient } from "../chat/types.js";
import type { SharingClient } from "../sharing/ShareDialog.js";
import type { CostApi, CostsPanelDashboard } from "../cost/types.js";

/**
 * Host-injected data access for the canvas components: web wraps `apiFetch`,
 * desktop its cloud IPC. Charts on a canvas draw through the base
 * {@link CostApi} exactly like dashboard cost cards, so a host spreads its
 * one `CostApi` factory into this client.
 *
 * Everything past the reads is optional and the panel renders only what the
 * host wires: a viewer without `costs:write` gets no editing, a host without
 * a chat client gets no "Edit with AI", and so on.
 */
export interface CostCanvasesClient extends CostApi {
  listCanvases(): Promise<CostCanvas[]>;
  getCanvas(canvasId: string): Promise<CostCanvas>;
  /** Re-run every block's query. The live view passes `includeChartData: false`. */
  runCanvas(canvasId: string, opts?: { includeChartData?: boolean }): Promise<CostCanvasRunResult>;
  /** Run an unsaved spec: previews a proposed edit before it is approved. */
  previewCanvas?(spec: CostCanvasSpec, name: string): Promise<CostCanvasRunResult>;
  /** Start a canvas from a description (creates its conversation too). */
  draftCanvas?(input: CostCanvasDraftInput): Promise<CostCanvas>;
  updateCanvas?(canvasId: string, input: CostCanvasInput): Promise<CostCanvas>;
  deleteCanvas?(canvasId: string): Promise<void>;
  /** The caller's editing conversation for a canvas, created when missing. */
  ensureConversation?(canvasId: string, opts?: { fresh?: boolean }): Promise<string>;
  /** The chat transport the side conversation runs on. */
  chat?: ChatClient;
  sharing?: SharingClient;
  listDashboards?(): Promise<CostsPanelDashboard[]>;
  addCanvasToDashboard?(dashboardId: string, canvasId: string, title: string): Promise<void>;
  removeCanvasPlacement?(widgetId: string): Promise<void>;
  downloadCanvasPdf?(canvasId: string, canvasName: string): Promise<void>;
  listCanvasNotifications?(canvasId: string): Promise<CostCanvasNotification[]>;
  listCanvasDeliveryTargets?(canvasId: string): Promise<ReportDeliveryTargets>;
  createCanvasNotification?(
    canvasId: string,
    input: CostCanvasNotificationInput,
  ): Promise<CostCanvasNotification>;
  updateCanvasNotification?(
    canvasId: string,
    notificationId: string,
    input: CostCanvasNotificationInput,
  ): Promise<CostCanvasNotification>;
  deleteCanvasNotification?(canvasId: string, notificationId: string): Promise<void>;
  sendCanvasNotificationNow?(
    canvasId: string,
    notificationId: string,
  ): Promise<CostCanvasNotificationSendResult>;
}

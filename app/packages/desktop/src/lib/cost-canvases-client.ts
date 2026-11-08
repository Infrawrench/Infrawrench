/**
 * The desktop Canvases client (cloud mode): the shared cost reads from
 * {@link createDesktopCostApi}, canvas calls typed from the contract's
 * `costCanvases` domain over the cloud transport (the PDF as bytes), sharing
 * over the allowlisted settings channel, and the desktop chat client for the side
 * conversation. Built per org (the viewport keys the panel by org), because
 * the chat client binds its org at construction.
 */
import {
  pdfFileName,
  type CostCanvas,
  type CostCanvasBlock,
  type CostGraphConfig,
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
import { Effect } from "effect";
import { cloudClient } from "./cloud-client";
import { definedFields, pdfTimezoneQuery } from "./cloud-payload";
import { runRpc } from "./rpc/client";
import { createCloudWidget, deleteCloudWidget } from "./cloud-costs";
import { listCloudDashboards } from "./cloud-dashboards";
import { createDesktopCostApi } from "./cost-api";
import { createDesktopChatClient } from "./cloud-chat";
import { createDesktopSharingClient } from "./cost-reports-client";

const canvases = () => cloudClient("costCanvases").costCanvases;

type WireCanvas = Effect.Success<ReturnType<ReturnType<typeof canvases>["get"]>>;
type WireBlock = WireCanvas["spec"]["blocks"][number];
type WireGraphConfig = Extract<WireBlock, { kind: "chart" }>["config"];

/**
 * A chart block's graph config with the fields the server always sends
 * filled in. The contract's answer reuses the request schema, whose encoded
 * side leaves the defaulted fields optional (the server fills an absent one
 * on the way in, so a stored config carries them all); one that did arrive
 * without them reads as the server's default.
 */
function graphConfigFromWire(config: WireGraphConfig): CostGraphConfig {
  return {
    ...config,
    filters: config.filters ?? [],
    topN: config.topN ?? 5,
    comparePreviousPeriod: config.comparePreviousPeriod ?? false,
    showForecast: config.showForecast ?? false,
  };
}

/** One block with its defaulted fields filled in, as {@link graphConfigFromWire} does. */
function blockFromWire(block: WireBlock): CostCanvasBlock {
  switch (block.kind) {
    case "kpi": {
      const { metric } = block;
      return {
        ...block,
        metric:
          metric.type === "budget" || metric.type === "anomaly_count"
            ? metric
            : { ...metric, filters: metric.filters ?? [] },
      };
    }
    case "chart":
      return { ...block, config: graphConfigFromWire(block.config) };
    case "table":
      return {
        ...block,
        query: { ...block.query, filters: block.query.filters ?? [], topN: block.query.topN ?? 10 },
      };
    case "anomalies":
      return { ...block, days: block.days ?? 30, limit: block.limit ?? 10 };
    default:
      return block;
  }
}

function canvasFromWire(canvas: WireCanvas): CostCanvas {
  return { ...canvas, spec: { ...canvas.spec, blocks: canvas.spec.blocks.map(blockFromWire) } };
}

export function createDesktopCostCanvasesClient(orgId: string): CostCanvasesClient {
  return {
    ...createDesktopCostApi(),
    chat: createDesktopChatClient(orgId),
    sharing: createDesktopSharingClient(),
    listCanvases: (): Promise<CostCanvas[]> =>
      runRpc(
        canvases()
          .list({ params: { orgId } })
          .pipe(Effect.map((rows) => rows.map(canvasFromWire))),
      ),
    getCanvas: (canvasId: string): Promise<CostCanvas> =>
      runRpc(
        canvases()
          .get({ params: { orgId, id: canvasId } })
          .pipe(Effect.map(canvasFromWire)),
      ),
    runCanvas: (
      canvasId: string,
      opts?: { includeChartData?: boolean },
    ): Promise<CostCanvasRunResult> =>
      runRpc(
        canvases().run({
          params: { orgId, id: canvasId },
          payload: { includeChartData: opts?.includeChartData !== false },
        }),
      ),
    previewCanvas: (spec: CostCanvasSpec, name: string): Promise<CostCanvasRunResult> =>
      runRpc(
        canvases().preview({
          params: { orgId },
          payload: { spec: definedFields(spec), name, includeChartData: false },
        }),
      ),
    draftCanvas: (input: CostCanvasDraftInput): Promise<CostCanvas> =>
      runRpc(
        canvases()
          .draft({ params: { orgId }, payload: definedFields(input) })
          .pipe(Effect.map(canvasFromWire)),
      ),
    updateCanvas: (canvasId: string, input: CostCanvasInput): Promise<CostCanvas> =>
      runRpc(
        canvases()
          .update({ params: { orgId, id: canvasId }, payload: definedFields(input) })
          .pipe(Effect.map(canvasFromWire)),
      ),
    deleteCanvas: async (canvasId: string) => {
      await runRpc(canvases().delete({ params: { orgId, id: canvasId } }));
    },
    ensureConversation: async (canvasId: string, opts?: { fresh?: boolean }) => {
      const res = await runRpc(
        canvases().conversation({
          params: { orgId, id: canvasId },
          payload: opts?.fresh ? { fresh: true } : {},
        }),
      );
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
      const bytes = await runRpc(
        canvases().pdf({ params: { orgId, id: canvasId }, query: pdfTimezoneQuery() }),
      );
      downloadPdfBytes(bytes, pdfFileName(canvasName, "canvas"));
    },
    listCanvasNotifications: (canvasId: string): Promise<CostCanvasNotification[]> =>
      runRpc(canvases().listNotifications({ params: { orgId, id: canvasId } })),
    listCanvasDeliveryTargets: (canvasId: string): Promise<ReportDeliveryTargets> =>
      runRpc(canvases().notificationTargets({ params: { orgId, id: canvasId } })),
    createCanvasNotification: (
      canvasId: string,
      input: CostCanvasNotificationInput,
    ): Promise<CostCanvasNotification> =>
      runRpc(
        canvases().createNotification({
          params: { orgId, id: canvasId },
          payload: definedFields(input),
        }),
      ),
    updateCanvasNotification: (
      canvasId: string,
      notificationId: string,
      input: CostCanvasNotificationInput,
    ): Promise<CostCanvasNotification> =>
      runRpc(
        canvases().updateNotification({
          params: { orgId, id: canvasId, notificationId },
          payload: definedFields(input),
        }),
      ),
    deleteCanvasNotification: async (canvasId: string, notificationId: string) => {
      await runRpc(
        canvases().deleteNotification({ params: { orgId, id: canvasId, notificationId } }),
      );
    },
    sendCanvasNotificationNow: (
      canvasId: string,
      notificationId: string,
    ): Promise<CostCanvasNotificationSendResult> =>
      runRpc(canvases().sendNotification({ params: { orgId, id: canvasId, notificationId } })),
  };
}

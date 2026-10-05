import { useQuery } from "@tanstack/react-query";
import {
  getCostCanvas,
  listCostCanvases,
  runCostCanvas,
  type CostCanvasNotification,
} from "@infrawrench/client-core";
import { useOrgApi } from "@/lib/auth/AuthProvider";

/** The org's cost canvases (read-only on mobile). */
export function useCostCanvases() {
  const { api, orgId } = useOrgApi();
  return useQuery({
    queryKey: ["cost-canvases", orgId],
    queryFn: () => listCostCanvases(api, orgId),
  });
}

/** One canvas's definition. */
export function useCostCanvas(canvasId: string | undefined) {
  const { api, orgId } = useOrgApi();
  return useQuery({
    queryKey: ["cost-canvas", orgId, canvasId],
    enabled: !!canvasId,
    queryFn: () => getCostCanvas(api, orgId, canvasId!),
  });
}

/**
 * Run (refresh) a canvas: every block re-queried server-side, no model call.
 * Chart data is left out because the chart blocks draw through the same
 * `CostGraphCard` a dashboard uses, which queries for itself.
 */
export function useCostCanvasRun(canvasId: string | undefined, updatedAt: string | undefined) {
  const { api, orgId } = useOrgApi();
  return useQuery({
    queryKey: ["cost-canvas-run", orgId, canvasId, updatedAt],
    enabled: !!canvasId,
    queryFn: () => runCostCanvas(api, orgId, canvasId!, { includeChartData: false }),
  });
}

/** Delivery schedules, read-only: managed on web and desktop, like report schedules. */
export function useCanvasNotifications(canvasId: string | undefined) {
  const { api, orgId } = useOrgApi();
  return useQuery({
    queryKey: ["cost-canvas-notifications", orgId, canvasId],
    enabled: !!canvasId,
    queryFn: async () =>
      (await api.org<CostCanvasNotification[]>(
        orgId,
        `/cost-canvases/${encodeURIComponent(canvasId!)}/notifications`,
      )) ?? [],
  });
}

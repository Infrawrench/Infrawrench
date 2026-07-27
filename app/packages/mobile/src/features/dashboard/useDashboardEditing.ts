import { useCallback, useMemo, useState } from "react";
import { Alert } from "react-native";
import { useQueryClient } from "@tanstack/react-query";
import {
  cardOrderIndex,
  dashboardCardId,
  type BudgetInput,
  type BudgetWidgetConfig,
  type CostGraphConfig,
  type DashboardCardRef,
} from "@infrawrench/client-core";
import { useOrgApi } from "@/lib/auth/AuthProvider";
import { invalidateDashboardQueries, type DashboardData } from "./DashboardBody";

/**
 * Every write a dashboard screen makes, against the endpoints web already
 * uses — no server surface is added for mobile.
 *
 * Two things are worth knowing about the shape here. Failures are reported once,
 * as an `Alert`, and then re-thrown: the sheets show the same message inline and
 * stay open, and a caller that has nothing to add (a row that pins on tap) just
 * swallows it. And a reorder is applied to the cached dashboard before the
 * request goes out — the arrows are the one control whose whole point is that
 * the card moves *now*, and a round trip to see it move reads as a dropped tap.
 */
export function useDashboardEditing(dashboardId: string) {
  const { api, orgId } = useOrgApi();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);

  const dashboardKey = useMemo(() => ["dashboard", orgId, dashboardId], [orgId, dashboardId]);

  const refresh = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: dashboardKey });
    invalidateDashboardQueries(queryClient);
  }, [queryClient, dashboardKey]);

  const run = useCallback(async <T>(what: string, fn: () => Promise<T>): Promise<T> => {
    setBusy(true);
    try {
      return await fn();
    } catch (e) {
      Alert.alert(what, e instanceof Error ? e.message : "Unknown error");
      throw e;
    } finally {
      setBusy(false);
    }
  }, []);

  const post = useCallback(
    <T>(path: string, body: unknown, method = "POST") =>
      api.org<T>(orgId, path, { method, body: JSON.stringify(body) }),
    [api, orgId],
  );

  return {
    busy,

    /** Persist a new card order, showing it immediately. */
    reorder: useCallback(
      async (order: DashboardCardRef[]) => {
        const index = cardOrderIndex(order);
        const at = (kind: DashboardCardRef["kind"], id: string, fallback: number) =>
          index.get(dashboardCardId(kind, id)) ?? fallback;
        queryClient.setQueryData<DashboardData>(dashboardKey, (prev) =>
          prev
            ? {
                ...prev,
                pins: prev.pins.map((p) => ({
                  ...p,
                  gridX: at("resource", p.resourceId, p.gridX),
                })),
                workflowPins: prev.workflowPins.map((w) => ({
                  ...w,
                  gridX: at("workflow", w.workflowId, w.gridX),
                })),
                widgets: prev.widgets.map((w) => ({ ...w, gridX: at("widget", w.id, w.gridX) })),
              }
            : prev,
        );
        try {
          await run("Couldn't reorder", () =>
            post(`/dashboards/${encodeURIComponent(dashboardId)}/reorder`, {
              cards: order.map((c) => ({ kind: c.kind, id: c.id })),
            }),
          );
        } finally {
          // Whether it landed or not, the server is the authority on gridX.
          void queryClient.invalidateQueries({ queryKey: dashboardKey });
        }
      },
      [queryClient, dashboardKey, dashboardId, post, run],
    ),

    pinResource: useCallback(
      async (resourceId: string) => {
        await run("Couldn't pin", () => post("/dashboards/pin", { dashboardId, resourceId }));
        refresh();
      },
      [dashboardId, post, run, refresh],
    ),

    unpinResource: useCallback(
      async (resourceId: string) => {
        await run("Couldn't remove", () => post("/dashboards/unpin", { dashboardId, resourceId }));
        refresh();
      },
      [dashboardId, post, run, refresh],
    ),

    unpinWorkflow: useCallback(
      async (workflowId: string) => {
        await run("Couldn't remove", () =>
          post("/dashboards/workflow-unpin", { dashboardId, workflowId }),
        );
        refresh();
      },
      [dashboardId, post, run, refresh],
    ),

    addCostGraph: useCallback(
      async (title: string, config: CostGraphConfig) => {
        await run("Couldn't add the graph", () =>
          post("/dashboards/widgets", { dashboardId, kind: "cost_graph", title, config }),
        );
        refresh();
      },
      [dashboardId, post, run, refresh],
    ),

    updateWidget: useCallback(
      async (widgetId: string, patch: { title?: string; config?: CostGraphConfig }) => {
        await run("Couldn't save the widget", () =>
          post(`/dashboards/widgets/${encodeURIComponent(widgetId)}`, patch, "PATCH"),
        );
        refresh();
      },
      [post, run, refresh],
    ),

    removeWidget: useCallback(
      async (widgetId: string) => {
        await run("Couldn't remove", () =>
          api.org(orgId, `/dashboards/widgets/${encodeURIComponent(widgetId)}`, {
            method: "DELETE",
          }),
        );
        refresh();
      },
      [api, orgId, run, refresh],
    ),

    /** Create the budget row, then the card that points at it — as web does. */
    createBudget: useCallback(
      async (input: BudgetInput) => {
        await run("Couldn't create the budget", async () => {
          const budget = await post<{ id: string }>("/budgets", input);
          if (!budget?.id) throw new Error("The budget was created without an id");
          const config: BudgetWidgetConfig = { version: 1, budgetId: budget.id };
          await post("/dashboards/widgets", {
            dashboardId,
            kind: "budget",
            title: input.name,
            config,
          });
        });
        refresh();
      },
      [dashboardId, post, run, refresh],
    ),

    updateBudget: useCallback(
      async (budgetId: string, input: BudgetInput) => {
        await run("Couldn't save the budget", () =>
          post(`/budgets/${encodeURIComponent(budgetId)}`, input, "PUT"),
        );
        refresh();
      },
      [post, run, refresh],
    ),

    addBudgetCard: useCallback(
      async (budgetId: string, title: string) => {
        const config: BudgetWidgetConfig = { version: 1, budgetId };
        await run("Couldn't add the budget", () =>
          post("/dashboards/widgets", { dashboardId, kind: "budget", title, config }),
        );
        refresh();
      },
      [dashboardId, post, run, refresh],
    ),
  };
}

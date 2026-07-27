import { Text, View } from "react-native";
import { useRouter } from "expo-router";
import { useQuery, type QueryClient } from "@tanstack/react-query";
import {
  orderDashboardCards,
  type BudgetWidgetConfig,
  type CostGraphConfig,
  type DashboardWidget,
} from "@infrawrench/client-core";
import { CostCollectionNotice } from "@/components/CostCollectionNotice";
import { Card, EmptyView, LoadingView, Row, Separator } from "@/components/ui";
import { useOrgApi } from "@/lib/auth/AuthProvider";
import { colors } from "@/lib/theme";
import { BudgetCard } from "./BudgetCard";
import { CostGraphCard } from "./CostGraphCard";
import { useBudgets } from "./useBudgets";
import { useCostStatus } from "./useCostStatus";

/** Shapes from GET /api/org/:orgId/dashboards/:id (web api/routes/dashboards.ts). */
export interface DashboardData {
  dashboard: { id: string; name: string; isDefault: boolean };
  pins: Array<{
    pinId: string;
    resourceId: string;
    gridX: number;
    gridY: number;
    gridW: number;
    gridH: number;
  }>;
  workflowPins: Array<{
    pinId: string;
    workflowId: string;
    gridX: number;
    name: string;
    lastRunAt: string | null;
    lastStatus: string | null;
    metrics: Array<{ key: string; label: string; unit: string | null; value: unknown }>;
  }>;
  widgets: DashboardWidget[];
}

/** Shape of GET /api/org/:orgId/dashboards/pin/:pinId — enriched resource pin. */
interface PinDetail {
  pinId: string;
  resourceId: string;
  displayName: string;
  pluginId: string;
  resourceTypeId: string;
  accountId: string;
  pluginDisplayName: string;
  status: {
    phase: "ok" | "error";
    resourceCounts?: Array<{ typeLabel: string; count: number }>;
    stats?: Array<{ label: string; value: string; variant?: string }>;
    error?: string;
  };
}

function failedPinDetail(pinId: string, error: unknown): PinDetail {
  return {
    pinId,
    resourceId: pinId,
    displayName: "Unavailable",
    pluginId: "",
    resourceTypeId: "",
    accountId: "",
    pluginDisplayName: "Couldn't load this pin",
    status: { phase: "error", error: error instanceof Error ? error.message : String(error) },
  };
}

/**
 * Refresh what the cards fetch for themselves. A screen's pull-to-refresh
 * refetches its own dashboard query and calls this for everything hanging off
 * it — pin probes, budget rows, collection status, and the cost queries.
 */
export function invalidateDashboardQueries(client: QueryClient): void {
  for (const key of ["dashboard-pin-details", "budgets", "cost-status", "cost-query"]) {
    void client.invalidateQueries({ queryKey: [key] });
  }
}

function formatMetricValue(value: unknown, unit: string | null): string {
  if (value === null || value === undefined) return "—";
  const text = typeof value === "object" ? JSON.stringify(value) : String(value);
  return unit ? `${text} ${unit}` : text;
}

/**
 * One dashboard's cards, in the order web and desktop render them — the home
 * tab shows the org's default dashboard with this, exactly as the web app's
 * home route does, and the dashboard route shows any other one.
 *
 * Cost graphs and budgets render for real here rather than pointing at the web
 * app: a budget alert arrives as a push, and the thing it is about has to be
 * on the screen the notification opens.
 */
export function DashboardBody({ data }: { data: DashboardData }) {
  const router = useRouter();
  const { api, orgId } = useOrgApi();
  const { pins, workflowPins, widgets } = data;

  const pinIds = pins.map((p) => p.pinId);
  const pinDetails = useQuery({
    queryKey: ["dashboard-pin-details", orgId, data.dashboard.id, pinIds],
    enabled: pinIds.length > 0,
    queryFn: async () =>
      // One unreachable pin must not blank the whole dashboard, but it must
      // not silently vanish either — a failed fetch becomes an error card.
      Promise.all(
        pinIds.map((id) =>
          api
            .org<PinDetail>(orgId, `/dashboards/pin/${encodeURIComponent(id)}`)
            .then((d) => d ?? failedPinDetail(id, new Error("The pin endpoint returned no body")))
            .catch((e: unknown) => failedPinDetail(id, e)),
        ),
      ),
  });

  // Budget widgets reference a budgets row; the rows load once for all of them.
  const budgets = useBudgets(widgets.some((w) => w.kind === "budget"));

  // Both widget kinds read collected spend, so any widget at all is reason
  // enough to pull the per-account state and let the notice decide.
  const costStatus = useCostStatus(widgets.length > 0);

  const cards = orderDashboardCards([
    ...pins.map((pin) => ({
      kind: "resource" as const,
      id: pin.resourceId,
      gridX: pin.gridX,
      pin,
    })),
    ...workflowPins.map((workflowPin) => ({
      kind: "workflow" as const,
      id: workflowPin.workflowId,
      gridX: workflowPin.gridX,
      workflowPin,
    })),
    ...widgets.map((widget) => ({
      kind: "widget" as const,
      id: widget.id,
      gridX: widget.gridX,
      widget,
    })),
  ]);

  if (cards.length === 0) {
    return (
      <EmptyView message="Nothing pinned to this dashboard yet. Pin resources and add cost widgets from the web or desktop app." />
    );
  }

  const detailFor = (pinId: string) => (pinDetails.data ?? []).find((d) => d.pinId === pinId);

  return (
    <>
      <CostCollectionNotice statuses={costStatus.data ?? []} />
      {cards.map((card) => {
        if (card.kind === "resource") {
          const pin = detailFor(card.pin.pinId);
          if (!pin) {
            return pinDetails.isLoading ? <LoadingView key={card.pin.pinId} /> : null;
          }
          return (
            <Card key={card.pin.pinId}>
              <Row
                title={pin.displayName}
                subtitle={pin.pluginDisplayName}
                {...(pin.pluginId && pin.resourceTypeId !== "__account__"
                  ? {
                      onPress: () =>
                        router.push(
                          `/org/${orgId}/resources/${encodeURIComponent(pin.pluginId)}/${encodeURIComponent(pin.resourceTypeId)}/${encodeURIComponent(pin.resourceId)}`,
                        ),
                    }
                  : {})}
              />
              <Separator />
              {pin.status.phase === "error" && pin.status.error ? (
                <Text style={{ color: colors.danger, fontSize: 12 }}>{pin.status.error}</Text>
              ) : null}
              {(pin.status.stats ?? []).map((s) => (
                <StatRow key={s.label} label={s.label} value={s.value} />
              ))}
              {(pin.status.resourceCounts ?? []).map((rc) => (
                <StatRow key={rc.typeLabel} label={rc.typeLabel} value={String(rc.count)} />
              ))}
            </Card>
          );
        }

        if (card.kind === "workflow") {
          const wp = card.workflowPin;
          return (
            <Card key={wp.pinId}>
              <Row
                title={wp.name}
                subtitle={
                  wp.lastRunAt
                    ? `${wp.lastStatus ?? "unknown"} · last run ${new Date(wp.lastRunAt).toLocaleString()}`
                    : "Never run"
                }
              />
              <Separator />
              {wp.metrics.map((m) => (
                <StatRow key={m.key} label={m.label} value={formatMetricValue(m.value, m.unit)} />
              ))}
            </Card>
          );
        }

        const widget = card.widget;
        if (widget.kind === "cost_graph") {
          return (
            <CostGraphCard
              key={widget.id}
              title={widget.title}
              config={widget.config as CostGraphConfig}
            />
          );
        }

        const budget = budgets.data?.get((widget.config as BudgetWidgetConfig).budgetId);
        if (!budget) {
          return (
            <Card key={widget.id}>
              <Text style={{ color: colors.textFaint, fontSize: 13 }}>
                {budgets.isLoading ? "Loading budget…" : `${widget.title} — budget unavailable`}
              </Text>
            </Card>
          );
        }
        return <BudgetCard key={widget.id} budget={budget} />;
      })}
    </>
  );
}

function StatRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
      <Text style={{ color: colors.textMuted, fontSize: 13 }}>{label}</Text>
      <Text style={{ color: colors.text, fontSize: 13 }}>{value}</Text>
    </View>
  );
}

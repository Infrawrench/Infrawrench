import type { ReactNode } from "react";
import { Text, View } from "react-native";
import { useRouter } from "expo-router";
import { useQuery, type QueryClient } from "@tanstack/react-query";
import {
  orderDashboardCards,
  type BudgetWidgetConfig,
  type CostGraphConfig,
  type CustomGraphWidgetConfig,
  type DashboardCardRef,
  type DashboardWidget,
} from "@infrawrench/client-core";
import { CostCollectionNotice } from "@/components/CostCollectionNotice";
import { Button, Card, EmptyView, LoadingView, Row, Separator } from "@/components/ui";
import { useOrgApi } from "@/lib/auth/AuthProvider";
import { colors, spacing } from "@/lib/theme";
import { BudgetCard } from "./BudgetCard";
import { CostGraphCard } from "./CostGraphCard";
import { CustomGraphCard } from "./CustomGraphCard";
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
  for (const key of [
    "dashboard-pin-details",
    "budgets",
    "cost-status",
    "cost-query",
    "custom-graph-render",
  ]) {
    void client.invalidateQueries({ queryKey: [key] });
  }
}

/**
 * What the screen hands down to turn the read-only body into an editable one.
 * `null` (the default) renders exactly what it always did.
 */
export interface DashboardEditing {
  /** The whole grid in its new order — resource, workflow, and widget cards. */
  onReorder: (order: DashboardCardRef[]) => void;
  onRemove: (card: DashboardCardRef) => void;
  /** Only widgets are configurable; a pin has nothing to edit. */
  onEditWidget: (widget: DashboardWidget) => void;
  busy: boolean;
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
export function DashboardBody({
  data,
  editing = null,
}: {
  data: DashboardData;
  editing?: DashboardEditing | null;
}) {
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
      <EmptyView
        message={
          editing
            ? "Nothing on this dashboard yet. Add a card to get started."
            : "Nothing pinned to this dashboard yet. Tap Edit to pin a resource or add a cost card."
        }
      />
    );
  }

  const detailFor = (pinId: string) => (pinDetails.data ?? []).find((d) => d.pinId === pinId);

  /**
   * Wrap a card in its edit strip. The order the strip moves cards through is
   * the rendered order, so an arrow always swaps with the neighbour above or
   * below on screen — the three tables' own `gridX` values never surface here.
   */
  const withControls = (index: number, ref: DashboardCardRef, node: ReactNode): ReactNode => {
    if (!editing) return node;
    const move = (delta: -1 | 1) => {
      const next: DashboardCardRef[] = cards.map((c) => ({ kind: c.kind, id: c.id }));
      const [moved] = next.splice(index, 1);
      next.splice(index + delta, 0, moved!);
      editing.onReorder(next);
    };
    return (
      <View key={`${ref.kind}:${ref.id}`} style={{ gap: spacing.sm }}>
        {node}
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.sm }}>
          <Button
            label="Move up"
            variant="secondary"
            disabled={index === 0 || editing.busy}
            onPress={() => move(-1)}
          />
          <Button
            label="Move down"
            variant="secondary"
            disabled={index === cards.length - 1 || editing.busy}
            onPress={() => move(1)}
          />
          {/* Custom graphs have no phone-side config — their script is edited
              on web/desktop, and the card's controls live on the card. */}
          {ref.kind === "widget" &&
          widgets.find((w) => w.id === ref.id)?.kind !== "custom_graph" ? (
            <Button
              label="Configure"
              variant="secondary"
              disabled={editing.busy}
              onPress={() => {
                const target = widgets.find((w) => w.id === ref.id);
                if (target) editing.onEditWidget(target);
              }}
            />
          ) : null}
          <Button
            label="Remove"
            variant="danger"
            disabled={editing.busy}
            onPress={() => editing.onRemove(ref)}
          />
        </View>
      </View>
    );
  };

  return (
    <>
      <CostCollectionNotice statuses={costStatus.data ?? []} />
      {cards.map((card, index) => {
        if (card.kind === "resource") {
          const pin = detailFor(card.pin.pinId);
          if (!pin) {
            return pinDetails.isLoading ? <LoadingView key={card.pin.pinId} /> : null;
          }
          return withControls(
            index,
            { kind: "resource", id: card.pin.resourceId },
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
            </Card>,
          );
        }

        if (card.kind === "workflow") {
          const wp = card.workflowPin;
          return withControls(
            index,
            { kind: "workflow", id: wp.workflowId },
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
            </Card>,
          );
        }

        const widget = card.widget;
        const widgetRef: DashboardCardRef = { kind: "widget", id: widget.id };
        if (widget.kind === "cost_graph") {
          return withControls(
            index,
            widgetRef,
            <CostGraphCard
              key={widget.id}
              title={widget.title}
              config={widget.config as CostGraphConfig}
            />,
          );
        }

        if (widget.kind === "custom_graph") {
          return withControls(
            index,
            widgetRef,
            <CustomGraphCard
              key={widget.id}
              title={widget.title}
              config={widget.config as CustomGraphWidgetConfig}
            />,
          );
        }

        const budget = budgets.data?.get((widget.config as BudgetWidgetConfig).budgetId);
        if (!budget) {
          return withControls(
            index,
            widgetRef,
            <Card key={widget.id}>
              <Text style={{ color: colors.textFaint, fontSize: 13 }}>
                {budgets.isLoading ? "Loading budget…" : `${widget.title} — budget unavailable`}
              </Text>
            </Card>,
          );
        }
        return withControls(index, widgetRef, <BudgetCard key={widget.id} budget={budget} />);
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

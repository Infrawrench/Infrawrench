import { Text, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import { useOrgApi } from "@/lib/auth/AuthProvider";
import {
  Card,
  EmptyView,
  ErrorView,
  LoadingView,
  Row,
  Screen,
  SectionTitle,
} from "@/components/ui";
import { colors } from "@/lib/theme";

/** Shapes from GET /api/org/:orgId/dashboards/:id (web api/routes/dashboards.ts). */
interface DashboardDetail {
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
  widgets: Array<{ id: string; kind: string; title: string }>;
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

function formatMetricValue(value: unknown, unit: string | null): string {
  if (value === null || value === undefined) return "—";
  const text = typeof value === "object" ? JSON.stringify(value) : String(value);
  return unit ? `${text} ${unit}` : text;
}

export default function DashboardScreen() {
  const router = useRouter();
  const { dashboardId } = useLocalSearchParams<{ dashboardId: string }>();
  const { api, orgId } = useOrgApi();

  const detail = useQuery({
    queryKey: ["dashboard", orgId, dashboardId],
    queryFn: () =>
      api.org<DashboardDetail>(orgId, `/dashboards/${encodeURIComponent(dashboardId)}`),
  });

  const pinIds = (detail.data?.pins ?? []).map((p) => p.pinId);

  const pinDetails = useQuery({
    queryKey: ["dashboard-pin-details", orgId, dashboardId, pinIds],
    enabled: pinIds.length > 0,
    queryFn: async () => {
      const results = await Promise.all(
        pinIds.map((id) =>
          api.org<PinDetail>(orgId, `/dashboards/pin/${encodeURIComponent(id)}`).catch(() => null),
        ),
      );
      return results.filter((r): r is PinDetail => r !== null);
    },
  });

  if (detail.isLoading) return <LoadingView />;
  if (detail.isError) {
    return (
      <ErrorView
        message={detail.error instanceof Error ? detail.error.message : "Failed to load"}
        onRetry={() => void detail.refetch()}
      />
    );
  }
  if (!detail.data) return <EmptyView message="Dashboard not found." />;

  const { dashboard, pins, workflowPins, widgets } = detail.data;
  const enrichedPins = pinDetails.data ?? [];
  const isEmpty = pins.length === 0 && workflowPins.length === 0 && widgets.length === 0;

  return (
    <Screen
      onRefresh={() => {
        void detail.refetch();
        void pinDetails.refetch();
      }}
      refreshing={detail.isRefetching}
    >
      <Text style={{ color: colors.text, fontSize: 20, fontWeight: "700" }}>{dashboard.name}</Text>

      {isEmpty && <EmptyView message="Nothing pinned to this dashboard yet." />}

      {pins.length > 0 && (
        <>
          <SectionTitle>Pinned resources</SectionTitle>
          {pins.length > 0 && enrichedPins.length === 0 && pinDetails.isLoading ? (
            <LoadingView />
          ) : (
            enrichedPins.map((pin) => (
              <Card key={pin.pinId}>
                <Row
                  title={pin.displayName}
                  subtitle={pin.pluginDisplayName}
                  {...(pin.resourceTypeId !== "__account__"
                    ? {
                        onPress: () =>
                          router.push(
                            `/org/${orgId}/resources/${encodeURIComponent(pin.pluginId)}/${encodeURIComponent(pin.resourceTypeId)}/${encodeURIComponent(pin.resourceId)}`,
                          ),
                      }
                    : {})}
                />
                {pin.status.phase === "error" && pin.status.error ? (
                  <Text style={{ color: colors.danger, fontSize: 12 }}>{pin.status.error}</Text>
                ) : null}
                {(pin.status.stats ?? []).map((s) => (
                  <View
                    key={s.label}
                    style={{ flexDirection: "row", justifyContent: "space-between" }}
                  >
                    <Text style={{ color: colors.textMuted, fontSize: 13 }}>{s.label}</Text>
                    <Text style={{ color: colors.text, fontSize: 13 }}>{s.value}</Text>
                  </View>
                ))}
                {(pin.status.resourceCounts ?? []).map((rc) => (
                  <View
                    key={rc.typeLabel}
                    style={{ flexDirection: "row", justifyContent: "space-between" }}
                  >
                    <Text style={{ color: colors.textMuted, fontSize: 13 }}>{rc.typeLabel}</Text>
                    <Text style={{ color: colors.text, fontSize: 13 }}>{rc.count}</Text>
                  </View>
                ))}
              </Card>
            ))
          )}
        </>
      )}

      {workflowPins.length > 0 && (
        <>
          <SectionTitle>Workflows</SectionTitle>
          {workflowPins.map((wp) => (
            <Card key={wp.pinId}>
              <Row
                title={wp.name}
                subtitle={
                  wp.lastRunAt
                    ? `${wp.lastStatus ?? "unknown"} · last run ${new Date(wp.lastRunAt).toLocaleString()}`
                    : "Never run"
                }
              />
              {wp.metrics.map((m) => (
                <View key={m.key} style={{ flexDirection: "row", justifyContent: "space-between" }}>
                  <Text style={{ color: colors.textMuted, fontSize: 13 }}>{m.label}</Text>
                  <Text style={{ color: colors.text, fontSize: 13 }}>
                    {formatMetricValue(m.value, m.unit)}
                  </Text>
                </View>
              ))}
            </Card>
          ))}
        </>
      )}

      {widgets.length > 0 && (
        <>
          <SectionTitle>Widgets</SectionTitle>
          <Card>
            {widgets.map((w) => (
              <Row
                key={w.id}
                title={w.title || w.kind}
                subtitle={`${w.kind} · view on the web or desktop app`}
              />
            ))}
          </Card>
        </>
      )}
    </Screen>
  );
}

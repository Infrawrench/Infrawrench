import { Text, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Button, Card, ErrorView, LoadingView, Row, Screen, SectionTitle } from "@/components/ui";
import { CanvasBlocks } from "@/features/cost-canvases/CanvasBlocks";
import {
  useCanvasNotifications,
  useCostCanvas,
  useCostCanvasRun,
} from "@/features/cost-canvases/useCostCanvases";
import { NotificationRow } from "@/features/delivery/NotificationRow";
import { useSharePdf } from "@/features/pdf/sharePdf";
import { useOrgApi } from "@/lib/auth/AuthProvider";
import { colors, spacing } from "@/lib/theme";

/**
 * One cost canvas, read-only. Pull to refresh re-runs every query (no model
 * call). Editing, the conversation that builds the canvas, and delivery
 * schedules stay on web and desktop, the same line report editing draws.
 */
export default function CostCanvasDetailRoute() {
  const router = useRouter();
  const { orgId } = useOrgApi();
  const { canvasId } = useLocalSearchParams<{ canvasId: string }>();
  const canvas = useCostCanvas(canvasId);
  const run = useCostCanvasRun(canvasId, canvas.data?.updatedAt);
  const notifications = useCanvasNotifications(canvasId);
  const pdf = useSharePdf();

  if (canvas.isLoading) return <LoadingView />;
  if (canvas.isError || !canvas.data) {
    return (
      <ErrorView
        message={
          canvas.error instanceof Error
            ? canvas.error.message
            : "This canvas no longer exists or is not shared with you."
        }
        onRetry={() => void canvas.refetch()}
      />
    );
  }
  const c = canvas.data;

  return (
    <Screen
      onRefresh={() => {
        void canvas.refetch();
        void run.refetch();
      }}
      refreshing={canvas.isRefetching || run.isRefetching}
    >
      <View style={{ gap: spacing.xs }}>
        <Text style={{ color: colors.text, fontSize: 17, fontWeight: "600" }}>{c.name}</Text>
        {c.description ? (
          <Text style={{ color: colors.textMuted, fontSize: 13 }}>{c.description}</Text>
        ) : null}
        {run.data ? (
          <Text style={{ color: colors.textFaint, fontSize: 12 }}>
            Refreshed {new Date(run.data.ranAt).toLocaleString()}
          </Text>
        ) : null}
      </View>

      <View style={{ flexDirection: "row" }}>
        <Button
          label={pdf.busy ? "Preparing PDF…" : "Share PDF"}
          variant="secondary"
          disabled={pdf.busy}
          onPress={() => void pdf.share(`/cost-canvases/${encodeURIComponent(c.id)}/pdf`, c.name)}
        />
      </View>

      {run.isError ? (
        <Text style={{ color: colors.danger, fontSize: 13 }}>
          {run.error instanceof Error ? run.error.message : "Couldn't run this canvas."}
        </Text>
      ) : null}

      <CanvasBlocks spec={c.spec} result={run.data} />

      {c.placements.length > 0 ? (
        <>
          <SectionTitle>On dashboards</SectionTitle>
          <Card list>
            {c.placements.map((p) => (
              <Row
                key={p.widgetId}
                title={p.dashboardName}
                onPress={() => router.push(`/org/${orgId}/dashboard/${p.dashboardId}`)}
              />
            ))}
          </Card>
        </>
      ) : null}

      <SectionTitle>Delivery</SectionTitle>
      {(notifications.data ?? []).length === 0 ? (
        <Text style={{ color: colors.textMuted, fontSize: 13 }}>
          {notifications.isLoading
            ? "Loading schedules…"
            : "No scheduled delivery. Schedules are managed on web or desktop."}
        </Text>
      ) : (
        <Card list>
          {(notifications.data ?? []).map((n) => (
            <NotificationRow key={n.id} notification={n} />
          ))}
        </Card>
      )}
    </Screen>
  );
}

import { Text } from "react-native";
import { useRouter } from "expo-router";
import { useOrgApi } from "@/lib/auth/AuthProvider";
import { Card, EmptyView, ErrorView, LoadingView, Row, Screen } from "@/components/ui";
import { useCostCanvases } from "@/features/cost-canvases/useCostCanvases";
import { colors } from "@/lib/theme";

/**
 * The org's cost canvases, read-only. A canvas is built by describing it to
 * the chat agent on web or desktop; on a phone it is read and refreshed.
 */
export default function CostCanvasesRoute() {
  const router = useRouter();
  const { orgId } = useOrgApi();
  const canvases = useCostCanvases();

  if (canvases.isLoading) return <LoadingView />;
  if (canvases.isError) {
    return (
      <ErrorView
        message={canvases.error instanceof Error ? canvases.error.message : "Failed to load"}
        onRetry={() => void canvases.refetch()}
      />
    );
  }
  const rows = canvases.data ?? [];
  if (rows.length === 0) {
    return (
      <EmptyView message="No canvases yet. Describe a report on the Canvases page on web or desktop and the assistant builds it." />
    );
  }
  return (
    <Screen onRefresh={() => void canvases.refetch()} refreshing={canvases.isRefetching}>
      <Text style={{ color: colors.textMuted, fontSize: 13 }}>
        Reports built from a description. They save their queries, not their numbers, so every open
        is current.
      </Text>
      <Card list>
        {rows.map((canvas) => (
          <Row
            key={canvas.id}
            title={canvas.name}
            subtitle={
              canvas.description ??
              `${canvas.spec.blocks.length} block${canvas.spec.blocks.length === 1 ? "" : "s"}`
            }
            onPress={() => router.push(`/org/${orgId}/cost-canvases/${canvas.id}`)}
          />
        ))}
      </Card>
    </Screen>
  );
}

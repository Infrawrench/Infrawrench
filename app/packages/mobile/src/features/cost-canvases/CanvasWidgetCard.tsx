import { Text, View } from "react-native";
import { useRouter } from "expo-router";
import type { CostCanvasWidgetConfig } from "@infrawrench/client-core";
import { Button, Card } from "@/components/ui";
import { useOrgApi } from "@/lib/auth/AuthProvider";
import { colors, spacing } from "@/lib/theme";
import { CanvasBlocks } from "./CanvasBlocks";
import { useCostCanvas, useCostCanvasRun } from "./useCostCanvases";

/** A `cost_canvas` dashboard card: the canvas, compact, with a link to its page. */
export function CanvasWidgetCard({ config }: { config: CostCanvasWidgetConfig }) {
  const router = useRouter();
  const { orgId } = useOrgApi();
  const canvas = useCostCanvas(config.canvasId);
  const run = useCostCanvasRun(config.canvasId, canvas.data?.updatedAt);

  if (!canvas.data) {
    return (
      <Card>
        <Text style={{ color: colors.textFaint, fontSize: 13 }}>
          {canvas.isLoading ? "Loading canvas…" : "Canvas unavailable"}
        </Text>
      </Card>
    );
  }
  return (
    <View style={{ gap: spacing.sm }}>
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
        <Text
          style={{ color: colors.text, fontSize: 15, fontWeight: "600", flex: 1 }}
          numberOfLines={1}
        >
          {canvas.data.name}
        </Text>
        <Button
          label="Open"
          variant="secondary"
          onPress={() => router.push(`/org/${orgId}/cost-canvases/${config.canvasId}`)}
        />
      </View>
      <CanvasBlocks spec={canvas.data.spec} result={run.data} compact />
    </View>
  );
}

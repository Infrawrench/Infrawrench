import { Text, View } from "react-native";
import { useRouter } from "expo-router";
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

/**
 * Read-only workflows list (GET /api/org/:orgId/workflows — see
 * app/packages/web/src/api/routes/workflows.ts). Editing stays on web/desktop.
 */

interface WorkflowSummary {
  id: string;
  name: string;
  description: string | null;
  enabled: boolean;
  trigger: { kind?: string } | null;
  updatedAt: string;
}

function triggerLabel(trigger: WorkflowSummary["trigger"]): string {
  switch (trigger?.kind) {
    case "cron":
      return "Cron";
    case "git":
      return "Git";
    case "manual":
      return "Manual";
    default:
      return trigger?.kind ?? "Manual";
  }
}

export default function WorkflowsScreen() {
  const router = useRouter();
  const { api, orgId } = useOrgApi();

  const list = useQuery({
    queryKey: ["workflows", orgId],
    queryFn: () => api.org<WorkflowSummary[]>(orgId, "/workflows"),
  });

  if (list.isLoading) return <LoadingView />;
  if (list.isError) {
    return (
      <ErrorView
        message={list.error instanceof Error ? list.error.message : "Failed to load workflows"}
        onRetry={() => void list.refetch()}
      />
    );
  }

  const workflows = list.data ?? [];
  if (workflows.length === 0) {
    return <EmptyView message="No workflows yet. Create one from the web or desktop app." />;
  }

  return (
    <Screen onRefresh={() => void list.refetch()} refreshing={list.isRefetching}>
      <Card>
        <SectionTitle>Workflows</SectionTitle>
        {workflows.map((wf) => (
          <Row
            key={wf.id}
            title={wf.name}
            subtitle={`${triggerLabel(wf.trigger)} trigger${wf.description ? ` · ${wf.description}` : ""}`}
            right={
              <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                <View
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: 4,
                    backgroundColor: wf.enabled ? colors.success : colors.textFaint,
                  }}
                />
                <Text style={{ color: colors.textMuted, fontSize: 12 }}>
                  {wf.enabled ? "Enabled" : "Disabled"}
                </Text>
              </View>
            }
            onPress={() => router.push(`/org/${orgId}/workflows/${wf.id}`)}
          />
        ))}
      </Card>
      <Text style={{ color: colors.textFaint, fontSize: 12 }}>
        Workflows are read-only on mobile. Edit them from the web or desktop app.
      </Text>
    </Screen>
  );
}

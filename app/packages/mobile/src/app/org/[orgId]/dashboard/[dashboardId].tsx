import { Text } from "react-native";
import { useLocalSearchParams } from "expo-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useOrgApi } from "@/lib/auth/AuthProvider";
import {
  DashboardBody,
  invalidateDashboardQueries,
  type DashboardData,
} from "@/features/dashboard/DashboardBody";
import { EmptyView, ErrorView, LoadingView, Screen } from "@/components/ui";
import { colors } from "@/lib/theme";

export default function DashboardScreen() {
  const { dashboardId } = useLocalSearchParams<{ dashboardId: string }>();
  const { api, orgId } = useOrgApi();
  const queryClient = useQueryClient();

  const detail = useQuery({
    queryKey: ["dashboard", orgId, dashboardId],
    queryFn: () => api.org<DashboardData>(orgId, `/dashboards/${encodeURIComponent(dashboardId)}`),
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

  return (
    <Screen
      onRefresh={() => {
        void detail.refetch();
        invalidateDashboardQueries(queryClient);
      }}
      refreshing={detail.isRefetching}
    >
      <Text style={{ color: colors.text, fontSize: 20, fontWeight: "700" }}>
        {detail.data.dashboard.name}
      </Text>
      <DashboardBody data={detail.data} />
    </Screen>
  );
}

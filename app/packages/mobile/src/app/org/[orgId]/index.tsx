import { useRouter } from "expo-router";
import { Text } from "react-native";
import { useQuery } from "@tanstack/react-query";
import type { Dashboard } from "@infrawrench/client-core";
import { useOrgApi } from "@/lib/auth/AuthProvider";
import { Card, EmptyView, ErrorView, LoadingView, Row, Screen } from "@/components/ui";
import { colors } from "@/lib/theme";

/**
 * The Dashboards tab: every dashboard in the org, default first. Tapping one
 * opens it on its own screen, which carries the dashboard's name in the header
 * and a back button to this list.
 *
 * This used to render the default dashboard inline with the others listed
 * underneath, which made the default the only one that felt like a place —
 * you saw its cards before you saw that alternatives existed.
 */
export default function OrgDashboards() {
  const router = useRouter();
  const { api, orgId } = useOrgApi();

  const dashboards = useQuery({
    queryKey: ["dashboards", orgId],
    queryFn: () => api.org<Dashboard[]>(orgId, "/dashboards"),
  });

  if (dashboards.isLoading) return <LoadingView />;
  if (dashboards.isError) {
    return (
      <ErrorView
        message={dashboards.error instanceof Error ? dashboards.error.message : "Failed to load"}
        onRetry={() => void dashboards.refetch()}
      />
    );
  }

  // Default first, then alphabetical — the order the sidebar uses on web.
  const list = [...(dashboards.data ?? [])].sort((a, b) => {
    if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  if (list.length === 0) {
    return <EmptyView message="No dashboards in this organization yet." />;
  }

  return (
    <Screen onRefresh={() => void dashboards.refetch()} refreshing={dashboards.isRefetching}>
      <Card list>
        {list.map((dashboard) => (
          <Row
            key={dashboard.id}
            title={dashboard.name}
            {...(dashboard.isDefault ? { subtitle: "Default" } : {})}
            onPress={() => router.push(`/org/${orgId}/dashboard/${dashboard.id}`)}
          />
        ))}
      </Card>
      <Text style={{ color: colors.textMuted, fontSize: 12 }}>
        Dashboards are arranged and configured on the web or desktop app.
      </Text>
    </Screen>
  );
}

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

interface DashboardSummary {
  id: string;
  name: string;
  isDefault: boolean;
}

interface Budget {
  id: string;
  name: string;
  amountCents: number;
  currency: string;
  status?: { month: string; actualCents: number; forecastCents: number | null };
}

function formatCents(cents: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      maximumFractionDigits: 0,
    }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(0)} ${currency}`;
  }
}

export default function OrgHome() {
  const router = useRouter();
  const { api, orgId } = useOrgApi();

  const dashboards = useQuery({
    queryKey: ["dashboards", orgId],
    queryFn: () => api.org<DashboardSummary[]>(orgId, "/dashboards"),
  });
  const budgets = useQuery({
    queryKey: ["budgets", orgId],
    queryFn: () => api.org<Budget[]>(orgId, "/budgets"),
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

  const dashboardList = dashboards.data ?? [];
  const budgetList = budgets.data ?? [];

  return (
    <Screen
      onRefresh={() => {
        void dashboards.refetch();
        void budgets.refetch();
      }}
      refreshing={dashboards.isRefetching}
    >
      <SectionTitle>Dashboards</SectionTitle>
      <Card>
        {dashboardList.length === 0 ? (
          <EmptyView message="No dashboards yet. Create one on the web or desktop app." />
        ) : (
          dashboardList.map((d) => (
            <Row
              key={d.id}
              title={d.name}
              subtitle={d.isDefault ? "Default" : undefined}
              onPress={() => router.push(`/org/${orgId}/dashboard/${d.id}`)}
            />
          ))
        )}
      </Card>

      <SectionTitle>Budgets</SectionTitle>
      <Card>
        {budgetList.length === 0 ? (
          <Text style={{ color: colors.textMuted, fontSize: 13 }}>
            No budgets configured. Budgets alert by push when a threshold is crossed.
          </Text>
        ) : (
          budgetList.map((b) => {
            const actual = b.status?.actualCents ?? 0;
            const pct = b.amountCents > 0 ? Math.round((actual / b.amountCents) * 100) : 0;
            return (
              <View key={b.id} style={{ paddingVertical: 8, gap: 4 }}>
                <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
                  <Text style={{ color: colors.text, fontSize: 14, fontWeight: "500" }}>
                    {b.name}
                  </Text>
                  <Text
                    style={{
                      color: pct >= 100 ? colors.danger : colors.textSecondary,
                      fontSize: 13,
                    }}
                  >
                    {formatCents(actual, b.currency)} / {formatCents(b.amountCents, b.currency)}
                  </Text>
                </View>
                <View
                  style={{ height: 6, backgroundColor: colors.surfaceOverlay, borderRadius: 3 }}
                >
                  <View
                    style={{
                      height: 6,
                      width: `${Math.min(100, pct)}%`,
                      backgroundColor:
                        pct >= 100 ? colors.danger : pct >= 80 ? colors.warning : colors.accent,
                      borderRadius: 3,
                    }}
                  />
                </View>
              </View>
            );
          })
        )}
      </Card>
    </Screen>
  );
}

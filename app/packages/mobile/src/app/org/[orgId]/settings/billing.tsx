import { Text } from "react-native";
import { useQuery } from "@tanstack/react-query";
import { useOrgApi } from "@/lib/auth/AuthProvider";
import { Card, ErrorView, LoadingView, Row, Screen, SectionTitle } from "@/components/ui";
import { colors } from "@/lib/theme";

/** Shape of GET /api/org/:orgId/billing/status (web api/routes/billing.ts); null when unsubscribed. */
interface BillingStatus {
  status: string;
  seatCount: number;
  currentPeriodEnd: string | null;
  stripeCustomerId: string;
}

export default function BillingScreen() {
  const { api, orgId } = useOrgApi();

  const billing = useQuery({
    queryKey: ["billing-status", orgId],
    queryFn: () => api.org<BillingStatus | null>(orgId, "/billing/status"),
  });

  if (billing.isLoading) return <LoadingView />;
  if (billing.isError) {
    return (
      <ErrorView
        message={billing.error instanceof Error ? billing.error.message : "Failed to load"}
        onRetry={() => void billing.refetch()}
      />
    );
  }

  const sub = billing.data ?? null;

  return (
    <Screen onRefresh={() => void billing.refetch()} refreshing={billing.isRefetching}>
      <SectionTitle>Current plan</SectionTitle>
      <Card>
        {sub ? (
          <>
            <Row title="Status" right={<Text style={{ color: colors.text }}>{sub.status}</Text>} />
            <Row
              title="Seats"
              right={<Text style={{ color: colors.text }}>{sub.seatCount}</Text>}
            />
            {sub.currentPeriodEnd ? (
              <Row
                title="Current period ends"
                right={
                  <Text style={{ color: colors.text }}>
                    {new Date(sub.currentPeriodEnd).toLocaleDateString()}
                  </Text>
                }
              />
            ) : null}
          </>
        ) : (
          <Text style={{ color: colors.textMuted, fontSize: 13 }}>
            This organization has no subscription.
          </Text>
        )}
      </Card>
      <Text style={{ color: colors.textMuted, fontSize: 12 }}>Manage billing on the web app.</Text>
    </Screen>
  );
}

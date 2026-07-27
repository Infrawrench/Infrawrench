import { Text } from "react-native";
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
import type { BillingStatus } from "@infrawrench/client-core";

export default function BillingScreen() {
  const { api, orgId } = useOrgApi();

  const billing = useQuery({
    queryKey: ["billing-status", orgId],
    queryFn: () => api.org<BillingStatus>(orgId, "/billing/status"),
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

  // The response is an envelope: a complimentary org has every paid perk with
  // no Stripe subscription at all, so the flag has to be read separately.
  const sub = billing.data?.subscription ?? null;
  const complimentary = billing.data?.complimentary ?? false;

  return (
    <Screen onRefresh={() => void billing.refetch()} refreshing={billing.isRefetching}>
      <SectionTitle>Current plan</SectionTitle>
      <Card list>
        {complimentary ? (
          <Row
            title="Plan"
            right={<Text style={{ color: colors.text }}>Complimentary</Text>}
            subtitle="All paid features, never billed."
          />
        ) : sub ? (
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
          <EmptyView message="This organization has no subscription." />
        )}
      </Card>
      <Text style={{ color: colors.textMuted, fontSize: 12 }}>Manage billing on the web app.</Text>
    </Screen>
  );
}

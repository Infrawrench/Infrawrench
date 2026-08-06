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
  // no Stripe subscription at all, so the flag has to be read separately — and
  // so does prepaid capacity, which is a paid plan with no subscription either.
  const sub = billing.data?.subscription ?? null;
  const complimentary = billing.data?.complimentary ?? false;
  const capacity = billing.data?.capacity ?? null;
  const prepaidSeats = capacity?.seats ?? 0;

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
        ) : sub || prepaidSeats > 0 ? (
          <>
            {sub ? (
              <>
                <Row
                  title="Status"
                  right={<Text style={{ color: colors.text }}>{sub.status}</Text>}
                />
                <Row
                  title="Monthly seats"
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
            ) : null}
            {prepaidSeats > 0 ? (
              <Row
                title="Prepaid seats"
                right={<Text style={{ color: colors.text }}>{prepaidSeats}</Text>}
                subtitle="Capacity slots bought outright, on top of any monthly seats."
              />
            ) : null}
          </>
        ) : (
          <EmptyView message="This organization has no subscription." />
        )}
      </Card>

      {capacity && capacity.slots.length > 0 ? (
        <>
          <SectionTitle>Capacity slots</SectionTitle>
          <Card list>
            {capacity.slots.map((slot) => {
              const live =
                slot.status === "active" && new Date(slot.expiresAt).getTime() > Date.now();
              return (
                <Row
                  key={slot.id}
                  title={`${slot.quantity} seat${slot.quantity !== 1 ? "s" : ""}`}
                  subtitle={`Bought ${new Date(slot.startsAt).toLocaleDateString()}`}
                  right={
                    <Text style={{ color: live ? colors.text : colors.textMuted }}>
                      {slot.status === "refunded"
                        ? "Refunded"
                        : `${live ? "Expires" : "Expired"} ${new Date(slot.expiresAt).toLocaleDateString()}`}
                    </Text>
                  }
                />
              );
            })}
          </Card>
        </>
      ) : null}

      <Text style={{ color: colors.textMuted, fontSize: 12 }}>Manage billing on the web app.</Text>
    </Screen>
  );
}

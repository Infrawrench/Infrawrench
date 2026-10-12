import { Text, View } from "react-native";
import { useQuery } from "@tanstack/react-query";
import { getEventType, type EventSubscription } from "@infrawrench/client-core";
import { useOrgApi } from "@/lib/auth/AuthProvider";
import { Card, EmptyView, ErrorView, LoadingView, Row, Screen } from "@/components/ui";
import { colors, spacing } from "@/lib/theme";

/**
 * Event subscriptions: **read-only on mobile, deliberately**, the cost-exports
 * stance. What belongs on a phone is "is the feed to our event bus still
 * working": each subscription's destination, filters and failure streak, and
 * the reason it was turned off if it was. Creating one means typing a URL and
 * storing a signing secret that is shown once, an org data-egress decision
 * gated on `org:settings:write`; that stays on web and desktop.
 */
export default function EventSubscriptionsScreen() {
  const { api, orgId } = useOrgApi();

  const subs = useQuery({
    queryKey: ["event-subscriptions", orgId],
    queryFn: async () =>
      (await api.org<{ subscriptions: EventSubscription[] }>(orgId, "/event-subscriptions"))
        ?.subscriptions ?? [],
  });

  if (subs.isLoading) return <LoadingView />;
  if (subs.isError) {
    return (
      <ErrorView
        message={subs.error instanceof Error ? subs.error.message : "Failed to load"}
        onRetry={() => void subs.refetch()}
      />
    );
  }

  const rows = subs.data ?? [];
  if (rows.length === 0) {
    return (
      <EmptyView message="No event subscriptions. Add one from Settings → Notifications → Event subscriptions on the web or desktop app." />
    );
  }

  return (
    <Screen onRefresh={() => void subs.refetch()} refreshing={subs.isRefetching}>
      {rows.map((sub) => (
        <Card key={sub.id} list>
          <Row
            title={sub.name}
            subtitle={
              sub.destination.kind === "webhook" ? sub.destination.url : sub.destinationLabel
            }
            right={<StatusBadge sub={sub} />}
          />
          <Row
            title={
              sub.eventTypes.length === 0
                ? "Every event"
                : sub.eventTypes.map((t) => getEventType(t)?.label ?? t).join(", ")
            }
            subtitle={[
              sub.minSeverity ? `${sub.minSeverity} and above` : null,
              sub.accountIds.length > 0 ? `${sub.accountIds.length} account(s)` : null,
              sub.environments.length > 0 ? sub.environments.join(", ") : null,
              sub.lastSuccessAt
                ? `Last delivered ${new Date(sub.lastSuccessAt).toLocaleString()}`
                : "Nothing delivered yet",
            ]
              .filter(Boolean)
              .join(" · ")}
          />
          {sub.disabledReason || sub.consecutiveFailures > 0 ? (
            <View style={{ padding: spacing.md }}>
              <Text
                style={{ color: sub.disabledReason ? colors.danger : colors.warning, fontSize: 13 }}
              >
                {sub.disabledReason ?? `${sub.consecutiveFailures} failed deliveries in a row`}
              </Text>
            </View>
          ) : null}
        </Card>
      ))}
    </Screen>
  );
}

function StatusBadge({ sub }: { sub: EventSubscription }) {
  const [label, color] = !sub.enabled
    ? (["off", colors.textMuted] as const)
    : sub.consecutiveFailures > 0
      ? (["failing", colors.danger] as const)
      : (["on", colors.success] as const);
  return <Text style={{ color, fontSize: 13 }}>{label}</Text>;
}

import { Pressable, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import type { Service } from "@infrawrench/client-core";
import { Card, EmptyView, ErrorView, LoadingView, Row, Screen } from "@/components/ui";
import { useOrgApi } from "@/lib/auth/AuthProvider";
import { colors, radii, spacing } from "@/lib/theme";
import { levelColor, scoreLine, serviceTierLabel } from "./format";
import { useServices } from "./useServices";

/**
 * Services; the native counterpart of the web/desktop Services tab and the
 * `infrawrench services` CLI: every service with its tier, owning team,
 * member count and scorecard standing, most critical tier first.
 *
 * Read-only by design (the SLOs stance): services and scorecards are written
 * on web/desktop, where the resource and rule pickers live. This screen and
 * the detail behind it answer the `scorecard_level_drop` push's question:
 * which check failed.
 */
export function ServicesScreen() {
  const router = useRouter();
  const { orgId } = useOrgApi();
  const services = useServices();

  if (services.isLoading) return <LoadingView />;
  if (services.isError) {
    return (
      <ErrorView
        message={
          services.error instanceof Error ? services.error.message : "Couldn't load services."
        }
        onRetry={() => void services.refetch()}
      />
    );
  }

  const list = [...(services.data?.services ?? [])].sort(
    (a, b) => (a.tier ?? 9) - (b.tier ?? 9) || a.name.localeCompare(b.name),
  );
  if (list.length === 0) {
    return (
      <EmptyView message="No services yet. Group resources into services on the web or desktop app." />
    );
  }

  return (
    <Screen onRefresh={() => void services.refetch()} refreshing={services.isRefetching}>
      <Card list>
        <Row
          title="Scorecards"
          subtitle="Every service's score and level, per scorecard"
          onPress={() => router.push(`/org/${orgId}/services/scorecards`)}
        />
      </Card>
      <Card list>
        {list.map((service) => (
          <ServiceRow key={service.id} service={service} />
        ))}
      </Card>
      <Text style={styles.footnote}>
        Services and scorecards are managed on the web or desktop app.
      </Text>
    </Screen>
  );
}

function ServiceRow({ service }: { service: Service }) {
  const router = useRouter();
  const { orgId } = useOrgApi();
  const meta = [
    serviceTierLabel(service.tier),
    service.ownerTeam,
    `${service.memberCount} ${service.memberCount === 1 ? "resource" : "resources"}`,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${service.name}, ${meta}`}
      onPress={() => router.push(`/org/${orgId}/services/${service.id}`)}
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
    >
      <Text style={styles.title} numberOfLines={1}>
        {service.name}
      </Text>
      <Text style={styles.subtitle} numberOfLines={1}>
        {meta}
      </Text>
      {service.scores.length > 0 && (
        <View style={styles.badges}>
          {service.scores.map((badge) => (
            <View key={badge.scorecardId} style={styles.badge}>
              <Text style={styles.badgeName} numberOfLines={1}>
                {badge.scorecardName}
              </Text>
              <Text style={[styles.badgeValue, { color: levelColor(badge.level, undefined) }]}>
                {scoreLine(badge.score, badge.levelName)}
              </Text>
            </View>
          ))}
        </View>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: { gap: 2, paddingVertical: 10 },
  rowPressed: { backgroundColor: colors.surfaceOverlay },
  title: { color: colors.text, fontSize: 15, fontWeight: "500" },
  subtitle: { color: colors.textMuted, fontSize: 12 },
  badges: { flexDirection: "row", flexWrap: "wrap", gap: spacing.xs, marginTop: spacing.xs },
  badge: {
    flexDirection: "row",
    gap: spacing.xs,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderStrong,
    borderRadius: radii.sm,
    paddingHorizontal: 6,
    paddingVertical: 2,
    maxWidth: "100%",
  },
  badgeName: { color: colors.textFaint, fontSize: 11, flexShrink: 1 },
  badgeValue: { fontSize: 11, fontWeight: "600" },
  footnote: { color: colors.textFaint, fontSize: 11 },
});

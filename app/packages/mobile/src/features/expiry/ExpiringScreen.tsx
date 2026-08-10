import { Pressable, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import {
  EXPIRY_KIND_LABELS,
  EXPIRY_SEVERITIES,
  type ExpiryItem,
  type ExpiryKind,
  type ExpirySeverity,
} from "@infrawrench/client-core";
import { Card, EmptyView, ErrorView, LoadingView, Screen, SectionTitle } from "@/components/ui";
import { useOrgApi } from "@/lib/auth/AuthProvider";
import { colors, radii, spacing } from "@/lib/theme";
import { useExpiring } from "./useExpiring";

/**
 * Expiry radar — the native counterpart of the web/desktop Expiring screens
 * and the `infrawrench expiring` CLI: one cross-provider countdown of
 * everything with a clock on it, grouped by what kind of clock it is.
 *
 * The severity chips answer the pageable question ("is anything red?") before
 * the first scroll; the sections then read soonest-first because the feed
 * itself is sorted that way and grouping preserves first-seen order. Tapping a
 * row opens the resource, which is where the fix (renew, rotate, reroll)
 * actually lives.
 */
export function ExpiringScreen() {
  const router = useRouter();
  const { orgId } = useOrgApi();
  const expiring = useExpiring();

  if (expiring.isLoading) return <LoadingView />;
  if (expiring.isError) {
    return (
      <ErrorView
        message={
          expiring.error instanceof Error ? expiring.error.message : "Couldn't load expiring items."
        }
        onRetry={() => void expiring.refetch()}
      />
    );
  }

  const data = expiring.data;
  if (!data || data.totalCount === 0) {
    return (
      <EmptyView message="Nothing tracked here has a deadline. Items appear when a synced resource carries an expiry a plugin declares — TLS certificates, domain registrations, API tokens, key ages." />
    );
  }

  // Group by kind. Items arrive soonest-first, so first-seen insertion order
  // puts the section with the most urgent deadline at the top for free.
  const groups = new Map<ExpiryKind, ExpiryItem[]>();
  for (const item of data.items) {
    const list = groups.get(item.kind);
    if (list) list.push(item);
    else groups.set(item.kind, [item]);
  }

  const open = (item: ExpiryItem) =>
    router.push(
      `/org/${orgId}/resources/${encodeURIComponent(item.pluginId)}/${encodeURIComponent(
        item.resourceTypeId,
      )}/${encodeURIComponent(item.resourceId)}?accountId=${encodeURIComponent(item.accountId)}`,
    );

  return (
    <Screen onRefresh={() => void expiring.refetch()} refreshing={expiring.isRefetching}>
      <View style={styles.chips}>
        {EXPIRY_SEVERITIES.map(
          (sev) =>
            data.counts[sev] > 0 && (
              <View key={sev} style={styles.chip}>
                <Text style={[styles.chipCount, { color: SEVERITY_COLORS[sev] }]}>
                  {data.counts[sev]}
                </Text>
                <Text style={styles.chipLabel}>{SEVERITY_LABELS[sev]}</Text>
              </View>
            ),
        )}
      </View>

      {Array.from(groups.entries()).map(([kind, items]) => (
        <View key={kind} style={{ gap: spacing.sm }}>
          <SectionTitle>{EXPIRY_KIND_LABELS[kind]}</SectionTitle>
          <Card list>
            {items.map((item) => (
              <ExpiryRow
                key={`${item.resourceId}:${item.fieldKey}`}
                item={item}
                onPress={() => open(item)}
              />
            ))}
          </Card>
        </View>
      ))}

      <Text style={styles.footnote}>
        Computed from fields the org has already synced — no provider calls. &quot;Upcoming&quot;
        means due within the org&apos;s {data.leadDays}-day lead time; key ages are counted against
        their rotation budget.
      </Text>
    </Screen>
  );
}

const SEVERITY_LABELS: Record<ExpirySeverity, string> = {
  expired: "Expired",
  critical: "Critical",
  warning: "Warning",
  upcoming: "Upcoming",
  ok: "OK",
};

/**
 * Expired and critical share the danger red — both mean "act now" and the
 * palette has one red. Beyond that the urgency ramp is amber → accent → green.
 */
const SEVERITY_COLORS: Record<ExpirySeverity, string> = {
  expired: colors.danger,
  critical: colors.danger,
  warning: colors.warning,
  upcoming: colors.accent,
  ok: colors.success,
};

function dueText(daysRemaining: number): string {
  if (daysRemaining < 0) return `expired ${-daysRemaining}d ago`;
  if (daysRemaining === 0) return "today";
  return `in ${daysRemaining}d`;
}

function ExpiryRow({ item, onPress }: { item: ExpiryItem; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${item.displayName}, ${item.label}, ${dueText(item.daysRemaining)}`}
      onPress={onPress}
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
    >
      <View style={styles.rowMain}>
        <Text style={styles.title} numberOfLines={1}>
          {item.displayName}
        </Text>
        <Text style={styles.subtitle} numberOfLines={2}>
          {item.resourceTypeName} · {item.accountName} · {item.label}
        </Text>
      </View>
      <View style={styles.dueCell}>
        <Text style={[styles.due, { color: SEVERITY_COLORS[item.severity] }]}>
          {dueText(item.daysRemaining)}
        </Text>
        <Text style={styles.dueDate}>{new Date(item.dueAt).toLocaleDateString()}</Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  chips: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
  chip: {
    flexDirection: "row",
    alignItems: "baseline",
    gap: spacing.xs,
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radii.lg,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs + 2,
  },
  chipCount: { fontSize: 14, fontWeight: "700" },
  chipLabel: { color: colors.textMuted, fontSize: 12 },
  row: { flexDirection: "row", alignItems: "center", gap: spacing.md, paddingVertical: 10 },
  rowPressed: { backgroundColor: colors.surfaceOverlay },
  rowMain: { flex: 1, gap: 2 },
  title: { color: colors.text, fontSize: 15, fontWeight: "500" },
  subtitle: { color: colors.textMuted, fontSize: 12 },
  dueCell: { alignItems: "flex-end", gap: 1 },
  due: { fontSize: 14, fontWeight: "600" },
  dueDate: { color: colors.textFaint, fontSize: 11 },
  footnote: { color: colors.textFaint, fontSize: 11 },
});

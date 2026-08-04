import { Pressable, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import {
  POSTURE_SEVERITIES,
  POSTURE_SEVERITY_LABELS,
  type PostureFinding,
  type PostureSeverity,
} from "@infrawrench/client-core";
import { Card, EmptyView, ErrorView, LoadingView, Screen, SectionTitle } from "@/components/ui";
import { useOrgApi } from "@/lib/auth/AuthProvider";
import { colors, radii, spacing } from "@/lib/theme";
import { usePosture } from "./usePosture";

/**
 * Posture checks — the native counterpart of the web/desktop Posture screens
 * and the `infrawrench posture` CLI: plugin-declared security rules evaluated
 * over already-synced fields, grouped by severity.
 *
 * The severity chips answer the pageable question ("is anything critical?")
 * before the first scroll; the sections then read worst-first because the
 * feed itself is sorted that way and grouping preserves first-seen order.
 * Tapping a row opens the resource, which is where the fix actually lives.
 */
export function PostureScreen() {
  const router = useRouter();
  const { orgId } = useOrgApi();
  const posture = usePosture();

  if (posture.isLoading) return <LoadingView />;
  if (posture.isError) {
    return (
      <ErrorView
        message={
          posture.error instanceof Error ? posture.error.message : "Couldn't load posture findings."
        }
        onRetry={() => void posture.refetch()}
      />
    );
  }

  const data = posture.data;
  if (!data || data.totalCount === 0) {
    return (
      <EmptyView message="No findings. Checks appear when a plugin declares posture rules over synced fields — a bucket's public-access setting, a firewall's source ranges, a disk's encryption flag." />
    );
  }

  // Group by severity. Findings arrive worst-first, so first-seen insertion
  // order puts the critical section at the top for free.
  const groups = new Map<PostureSeverity, PostureFinding[]>();
  for (const finding of data.findings) {
    const list = groups.get(finding.severity);
    if (list) list.push(finding);
    else groups.set(finding.severity, [finding]);
  }

  const open = (finding: PostureFinding) =>
    router.push(
      `/org/${orgId}/resources/${encodeURIComponent(finding.pluginId)}/${encodeURIComponent(
        finding.resourceTypeId,
      )}/${encodeURIComponent(finding.resourceId)}?accountId=${encodeURIComponent(
        finding.accountId,
      )}`,
    );

  return (
    <Screen onRefresh={() => void posture.refetch()} refreshing={posture.isRefetching}>
      <View style={styles.chips}>
        {POSTURE_SEVERITIES.map(
          (sev) =>
            data.counts[sev] > 0 && (
              <View key={sev} style={styles.chip}>
                <Text style={[styles.chipCount, { color: SEVERITY_COLORS[sev] }]}>
                  {data.counts[sev]}
                </Text>
                <Text style={styles.chipLabel}>{POSTURE_SEVERITY_LABELS[sev]}</Text>
              </View>
            ),
        )}
      </View>

      {Array.from(groups.entries()).map(([severity, findings]) => (
        <View key={severity} style={{ gap: spacing.sm }}>
          <SectionTitle>{POSTURE_SEVERITY_LABELS[severity]}</SectionTitle>
          <Card list>
            {findings.map((finding) => (
              <PostureRow
                key={`${finding.resourceId}:${finding.ruleId}`}
                finding={finding}
                onPress={() => open(finding)}
              />
            ))}
          </Card>
        </View>
      ))}

      <Text style={styles.footnote}>
        Computed from fields the org has already synced — no provider calls. Rules are declared by
        each plugin; critical and high findings feed the daily posture alerts.
      </Text>
    </Screen>
  );
}

/**
 * Critical shares the danger red with "act now"; the ramp then descends
 * amber → accent → muted, matching the expiry screen's urgency palette.
 */
const SEVERITY_COLORS: Record<PostureSeverity, string> = {
  critical: colors.danger,
  high: colors.warning,
  medium: colors.accent,
  low: colors.textMuted,
};

function PostureRow({ finding, onPress }: { finding: PostureFinding; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${finding.displayName}, ${finding.title}, ${finding.severity}`}
      onPress={onPress}
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
    >
      <View style={styles.rowMain}>
        <Text style={styles.title} numberOfLines={1}>
          {finding.displayName}
        </Text>
        <Text style={styles.subtitle} numberOfLines={2}>
          {finding.resourceTypeName} · {finding.accountName} · {finding.title}
        </Text>
        <Text style={styles.reason} numberOfLines={3}>
          {finding.reason}
        </Text>
      </View>
      <Text style={[styles.severity, { color: SEVERITY_COLORS[finding.severity] }]}>
        {POSTURE_SEVERITY_LABELS[finding.severity]}
      </Text>
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
  reason: { color: colors.textFaint, fontSize: 11 },
  severity: { fontSize: 13, fontWeight: "600" },
  footnote: { color: colors.textFaint, fontSize: 11 },
});

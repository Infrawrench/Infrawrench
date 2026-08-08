import { Alert, Pressable, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import {
  POSTURE_SEVERITIES,
  POSTURE_SEVERITY_LABELS,
  postureFindingKey,
  type DismissedPostureFinding,
  type PostureFinding,
  type PostureSeverity,
} from "@infrawrench/client-core";
import { Card, EmptyView, ErrorView, LoadingView, Screen, SectionTitle } from "@/components/ui";
import { useOrgApi } from "@/lib/auth/AuthProvider";
import { colors, radii, spacing } from "@/lib/theme";
import { usePosture, usePostureDismissal } from "./usePosture";

/**
 * Posture checks — the native counterpart of the web/desktop Posture screens
 * and the `infrawrench posture` CLI: plugin-declared security rules evaluated
 * over already-synced fields, grouped by severity.
 *
 * The severity chips answer the pageable question ("is anything critical?")
 * before the first scroll; the sections then read worst-first because the
 * feed itself is sorted that way and grouping preserves first-seen order.
 * Tapping a row opens the resource, which is where the fix actually lives.
 *
 * A finding can be accepted from here too, behind a confirm — but without a
 * note: typing a justification on a phone is a job for the desktop, and a
 * blank reason is better than a thumbed-in one. The dismissed list at the
 * bottom shows the notes left elsewhere and undoes any of them.
 */
export function PostureScreen() {
  const router = useRouter();
  const { orgId } = useOrgApi();
  const posture = usePosture();
  const { dismiss, restore } = usePostureDismissal();

  const confirmDismiss = (finding: PostureFinding) =>
    Alert.alert(
      "Dismiss this finding?",
      `${finding.displayName} — ${finding.title}\n\nIt leaves the list and stops feeding the daily posture alerts until it is restored.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Dismiss",
          style: "destructive",
          onPress: () =>
            dismiss.mutate(
              { finding },
              {
                onError: (e) =>
                  Alert.alert("Couldn't dismiss", e instanceof Error ? e.message : String(e)),
              },
            ),
        },
      ],
    );

  const undoDismiss = (finding: PostureFinding) =>
    restore.mutate(finding, {
      onError: (e) => Alert.alert("Couldn't restore", e instanceof Error ? e.message : String(e)),
    });

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
  if (!data || (data.totalCount === 0 && data.dismissedCount === 0)) {
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

      {data.totalCount === 0 && data.dismissedCount > 0 && (
        <Text style={styles.footnote}>
          No open findings — everything currently flagged has been dismissed as an accepted risk.
        </Text>
      )}

      {Array.from(groups.entries()).map(([severity, findings]) => (
        <View key={severity} style={{ gap: spacing.sm }}>
          <SectionTitle>{POSTURE_SEVERITY_LABELS[severity]}</SectionTitle>
          <Card list>
            {findings.map((finding) => (
              <PostureRow
                key={postureFindingKey(finding)}
                finding={finding}
                onPress={() => open(finding)}
                actionLabel="Dismiss"
                onAction={() => confirmDismiss(finding)}
                busy={dismiss.isPending}
              />
            ))}
          </Card>
        </View>
      ))}

      {data.dismissed.length > 0 && (
        <View style={{ gap: spacing.sm }}>
          <SectionTitle>Dismissed ({data.dismissed.length})</SectionTitle>
          <Card list>
            {data.dismissed.map((finding) => (
              <PostureRow
                key={postureFindingKey(finding)}
                finding={finding}
                muted
                detail={dismissalLine(finding)}
                onPress={() => open(finding)}
                actionLabel="Restore"
                onAction={() => undoDismiss(finding)}
                busy={restore.isPending}
              />
            ))}
          </Card>
        </View>
      )}

      <Text style={styles.footnote}>
        Computed from fields the org has already synced — no provider calls. Rules are declared by
        each plugin; critical and high findings feed the daily posture alerts. Dismissed findings
        are still evaluated — they are kept off the list and out of the alerts until restored.
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

/** "Dismissed 2 Mar 2026 by Ada — known exception, ticket INF-402". */
function dismissalLine(finding: DismissedPostureFinding): string {
  const when = Number.isNaN(Date.parse(finding.dismissal.dismissedAt))
    ? finding.dismissal.dismissedAt
    : new Date(finding.dismissal.dismissedAt).toLocaleDateString();
  const by = finding.dismissal.dismissedBy ? ` by ${finding.dismissal.dismissedBy}` : "";
  const why = finding.dismissal.reason ? ` — ${finding.dismissal.reason}` : "";
  return `Dismissed ${when}${by}${why}`;
}

function PostureRow({
  finding,
  onPress,
  actionLabel,
  onAction,
  busy,
  muted,
  detail,
}: {
  finding: PostureFinding;
  onPress: () => void;
  /** Right-hand action, e.g. "Dismiss". Omitted, the row is read-only. */
  actionLabel?: string;
  onAction?: () => void;
  busy?: boolean;
  /** Dismissed rows read as settled, not as alarms. */
  muted?: boolean;
  /** Replaces the rule's explanation, e.g. who accepted it and why. */
  detail?: string;
}) {
  // VoiceOver treats an accessible Pressable as one element and will not focus
  // an interactive child of it, so the right-hand action is offered as a
  // custom action on the row rather than as a nested target a screen reader
  // can never reach. The child stays touchable (and stays hidden from
  // assistive tech) so a sighted tap still hits the smaller region.
  const action =
    actionLabel && onAction && !busy ? { name: actionLabel, label: actionLabel } : null;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${finding.displayName}, ${finding.title}, ${finding.severity}`}
      {...(action
        ? {
            accessibilityActions: [action],
            onAccessibilityAction: (e: { nativeEvent: { actionName: string } }) => {
              if (e.nativeEvent.actionName === action.name) onAction?.();
            },
          }
        : {})}
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
          {detail ?? finding.reason}
        </Text>
      </View>
      <View style={styles.rowEnd}>
        <Text
          style={[
            styles.severity,
            { color: muted ? colors.textMuted : SEVERITY_COLORS[finding.severity] },
          ]}
        >
          {POSTURE_SEVERITY_LABELS[finding.severity]}
        </Text>
        {actionLabel && onAction && (
          <Pressable
            // Reached through the row's custom action instead, so it must not
            // also appear as a (VoiceOver-unfocusable) element of its own.
            accessible={false}
            importantForAccessibility="no-hide-descendants"
            disabled={busy}
            // The row itself opens the resource; the action must not.
            onPress={(e) => {
              e.stopPropagation();
              onAction();
            }}
            hitSlop={8}
          >
            <Text style={[styles.action, busy && styles.actionBusy]}>{actionLabel}</Text>
          </Pressable>
        )}
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
  reason: { color: colors.textFaint, fontSize: 11 },
  rowEnd: { alignItems: "flex-end", gap: 4 },
  severity: { fontSize: 13, fontWeight: "600" },
  action: { color: colors.textMuted, fontSize: 12 },
  actionBusy: { opacity: 0.5 },
  footnote: { color: colors.textFaint, fontSize: 11 },
});

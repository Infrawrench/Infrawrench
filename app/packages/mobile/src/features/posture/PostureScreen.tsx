import { Alert, Pressable, StyleSheet, Text, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import {
  leakLocationLabel,
  leakSeverity,
  POSTURE_SEVERITIES,
  POSTURE_SEVERITY_LABELS,
  postureFindingKey,
  type DismissedPostureFinding,
  type LeakedSecret,
  type PostureFinding,
  type PostureSeverity,
} from "@infrawrench/client-core";
import { Card, EmptyView, ErrorView, LoadingView, Screen, SectionTitle } from "@/components/ui";
import { useOrgApi } from "@/lib/auth/AuthProvider";
import { colors, radii, spacing } from "@/lib/theme";
import { useLeakedSecrets, usePosture, usePostureDismissal } from "./usePosture";

/**
 * Posture checks; the native counterpart of the web/desktop Posture screens
 * and the `infrawrench posture` CLI: plugin-declared security rules evaluated
 * over already-synced fields, grouped by severity.
 *
 * The severity chips answer the pageable question ("is anything critical?")
 * before the first scroll; the sections then read worst-first because the
 * feed itself is sorted that way and grouping preserves first-seen order.
 * Tapping a row opens the resource, which is where the fix actually lives.
 *
 * A finding can be accepted from here too, behind a confirm, but without a
 * note: typing a justification on a phone is a job for the desktop, and a
 * blank reason is better than a thumbed-in one. The dismissed list at the
 * bottom shows the notes left elsewhere and undoes any of them.
 *
 * Leaked credentials sit above the findings, read-only: rotating one is the
 * secret-reroll flow, which stays on web and desktop. They come from their own
 * request and render their own loading and error states, so either half of the
 * screen can fail without taking the other with it.
 */
export function PostureScreen() {
  const router = useRouter();
  const { orgId } = useOrgApi();
  const posture = usePosture();
  const leaks = useLeakedSecrets();
  // A `leaked_secret` push about exactly one leak deep-links with its id.
  const { leakId } = useLocalSearchParams<{ leakId?: string }>();
  const { dismiss, restore } = usePostureDismissal();

  const confirmDismiss = (finding: PostureFinding) =>
    Alert.alert(
      "Dismiss this finding?",
      `${finding.displayName}: ${finding.title}\n\nIt leaves the list and the daily alerts until restored.`,
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

  const refresh = () => {
    void posture.refetch();
    void leaks.refetch();
  };

  return (
    <Screen onRefresh={refresh} refreshing={posture.isRefetching || leaks.isRefetching}>
      <LeakedCredentialsSection
        loading={leaks.isLoading}
        error={
          leaks.isError
            ? leaks.error instanceof Error
              ? leaks.error.message
              : "Couldn't load leaked credentials."
            : null
        }
        onRetry={() => void leaks.refetch()}
        leaks={leaks.data?.leaks ?? []}
        scannerCount={leaks.data?.scanners.length ?? 0}
        focusedId={leakId}
      />
      <SectionTitle>Findings</SectionTitle>
      <PostureFindings
        posture={posture}
        onDismiss={confirmDismiss}
        dismissBusy={dismiss.isPending}
        onRestore={undoDismiss}
        restoreBusy={restore.isPending}
        onOpen={(finding) =>
          router.push(
            `/org/${orgId}/resources/${encodeURIComponent(finding.pluginId)}/${encodeURIComponent(
              finding.resourceTypeId,
            )}/${encodeURIComponent(finding.resourceId)}?accountId=${encodeURIComponent(
              finding.accountId,
            )}`,
          )
        }
      />
      <Pressable
        accessibilityRole="link"
        onPress={() => router.push(`/org/${orgId}/vulnerabilities`)}
        hitSlop={8}
      >
        <Text style={styles.link}>Vulnerabilities in running images →</Text>
      </Pressable>
    </Screen>
  );
}

/** The severity-grouped findings feed, with its own loading, error and empty states. */
function PostureFindings({
  posture,
  onDismiss,
  dismissBusy,
  onRestore,
  restoreBusy,
  onOpen,
}: {
  posture: ReturnType<typeof usePosture>;
  onDismiss: (finding: PostureFinding) => void;
  dismissBusy: boolean;
  onRestore: (finding: PostureFinding) => void;
  restoreBusy: boolean;
  onOpen: (finding: PostureFinding) => void;
}) {
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
      <EmptyView message="No findings. Checks appear when a plugin declares posture rules over synced fields, such as bucket access or disk encryption." />
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

  return (
    <>
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
          No open findings. Everything flagged has been dismissed as an accepted risk.
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
                onPress={() => onOpen(finding)}
                actionLabel="Dismiss"
                onAction={() => onDismiss(finding)}
                busy={dismissBusy}
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
                onPress={() => onOpen(finding)}
                actionLabel="Restore"
                onAction={() => onRestore(finding)}
                busy={restoreBusy}
              />
            ))}
          </Card>
        </View>
      )}

      <Text style={styles.footnote}>
        Computed from synced fields. Critical and high findings feed the daily posture alerts.
        Dismissed findings stay off the list and out of alerts until restored.
      </Text>
    </>
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

/**
 * Open leaked credentials, worst first, the notification's leak (if any) at
 * the top. Read-only: each row says what leaked, where, and what it belongs
 * to, and the footnote says where the fix lives.
 */
function LeakedCredentialsSection({
  loading,
  error,
  onRetry,
  leaks,
  scannerCount,
  focusedId,
}: {
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  leaks: LeakedSecret[];
  scannerCount: number;
  focusedId: string | undefined;
}) {
  if (loading) {
    return (
      <View style={{ gap: spacing.sm }}>
        <SectionTitle>Leaked credentials</SectionTitle>
        <Card>
          <Text style={styles.subtitle}>Loading leaked credentials...</Text>
        </Card>
      </View>
    );
  }
  if (error) {
    return (
      <View style={{ gap: spacing.sm }}>
        <SectionTitle>Leaked credentials</SectionTitle>
        <Card>
          <Text style={styles.error}>{error}</Text>
          <Pressable accessibilityRole="button" onPress={onRetry} hitSlop={8}>
            <Text style={styles.retry}>Retry</Text>
          </Pressable>
        </Card>
      </View>
    );
  }
  if (scannerCount === 0) {
    return (
      <View style={{ gap: spacing.sm }}>
        <SectionTitle>Leaked credentials</SectionTitle>
        <Card>
          <Text style={styles.subtitle}>
            Connect a GitHub organization or a GitLab account to scan your code for leaked
            credentials.
          </Text>
        </Card>
      </View>
    );
  }

  // Critical before high, newest first within each (the feed's own order),
  // and the leak a notification pointed at ahead of everything.
  const ordered = [...leaks].sort((a, b) => {
    if (a.id === focusedId) return -1;
    if (b.id === focusedId) return 1;
    const sev = (l: LeakedSecret) => (leakSeverity(l) === "critical" ? 0 : 1);
    return sev(a) - sev(b);
  });
  const focusedMissing = Boolean(focusedId) && !leaks.some((l) => l.id === focusedId);

  return (
    <View style={{ gap: spacing.sm }}>
      <SectionTitle>
        {leaks.length > 0 ? `Leaked credentials (${leaks.length})` : "Leaked credentials"}
      </SectionTitle>
      {focusedMissing && (
        <Text style={styles.footnote}>
          The leak from your notification is no longer open: it was rotated, dismissed or resolved.
        </Text>
      )}
      {ordered.length === 0 ? (
        <Card>
          <Text style={styles.subtitle}>
            No open leaks across {scannerCount === 1 ? "1 scanner" : `${scannerCount} scanners`}.
          </Text>
        </Card>
      ) : (
        <Card list>
          {ordered.map((leak) => (
            <LeakRow key={leak.id} leak={leak} highlighted={leak.id === focusedId} />
          ))}
        </Card>
      )}
      {ordered.length > 0 && (
        <Text style={styles.footnote}>
          Rotate, dismiss or rescan leaked credentials from Infrawrench on web or desktop.
        </Text>
      )}
    </View>
  );
}

/** What a leak was matched to, in a phrase. */
function leakMatchLine(leak: LeakedSecret): string {
  // A token-type match only knows the provider, not the exact credential.
  const hedge = leak.matchConfidence === "token-type" ? " (likely)" : "";
  switch (leak.matchKind) {
    case "account":
      return `Account ${leak.matchedAccountName ?? "unknown"}${hedge}`;
    case "secret-field":
    case "output":
      return `Resource ${leak.matchedResourceName ?? "unknown"}${hedge}`;
    case "none":
      return "Not a credential Infrawrench holds";
  }
}

function LeakRow({ leak, highlighted }: { leak: LeakedSecret; highlighted: boolean }) {
  const severity = leakSeverity(leak);
  const location = leakLocationLabel(leak);
  const detected = Number.isNaN(Date.parse(leak.detectedAt))
    ? leak.detectedAt
    : new Date(leak.detectedAt).toLocaleDateString();
  const flags = [
    leak.validity === "active" ? "Still valid" : null,
    leak.publiclyLeaked ? "Also found publicly" : null,
  ].filter((f): f is string => f !== null);
  return (
    <View
      accessible
      accessibilityLabel={`${leak.tokenTypeLabel}, ${severity}, ${leakMatchLine(leak)}`}
      style={[styles.row, highlighted && styles.rowHighlighted]}
    >
      <View style={styles.rowMain}>
        {highlighted && <Text style={styles.fromNotification}>From your notification</Text>}
        <Text style={styles.title} numberOfLines={1}>
          {leak.tokenTypeLabel}
          {leak.secretHint ? ` · ${leak.secretHint}` : ""}
        </Text>
        <Text style={styles.subtitle} numberOfLines={2}>
          {leakMatchLine(leak)}
          {location ? ` · ${location}` : ""}
        </Text>
        <Text style={styles.reason} numberOfLines={2}>
          Detected {detected} by {leak.scannerAccountName}
          {flags.length > 0 ? ` · ${flags.join(" · ")}` : ""}
        </Text>
      </View>
      <View style={styles.rowEnd}>
        <Text style={[styles.severity, { color: SEVERITY_COLORS[severity] }]}>
          {POSTURE_SEVERITY_LABELS[severity]}
        </Text>
      </View>
    </View>
  );
}

/** "Dismissed 2 Mar 2026 by Ada: known exception, ticket INF-402". */
function dismissalLine(finding: DismissedPostureFinding): string {
  const when = Number.isNaN(Date.parse(finding.dismissal.dismissedAt))
    ? finding.dismissal.dismissedAt
    : new Date(finding.dismissal.dismissedAt).toLocaleDateString();
  const by = finding.dismissal.dismissedBy ? ` by ${finding.dismissal.dismissedBy}` : "";
  const why = finding.dismissal.reason ? `: ${finding.dismissal.reason}` : "";
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
  rowHighlighted: {
    backgroundColor: colors.surfaceOverlay,
    borderLeftColor: colors.warning,
    borderLeftWidth: 2,
    paddingLeft: spacing.sm,
  },
  fromNotification: { color: colors.warning, fontSize: 11, fontWeight: "600" },
  error: { color: colors.danger, fontSize: 13 },
  retry: { color: colors.accent, fontSize: 13, fontWeight: "500", marginTop: spacing.sm },
  rowMain: { flex: 1, gap: 2 },
  title: { color: colors.text, fontSize: 15, fontWeight: "500" },
  subtitle: { color: colors.textMuted, fontSize: 12 },
  reason: { color: colors.textFaint, fontSize: 11 },
  rowEnd: { alignItems: "flex-end", gap: 4 },
  severity: { fontSize: 13, fontWeight: "600" },
  action: { color: colors.textMuted, fontSize: 12 },
  actionBusy: { opacity: 0.5 },
  footnote: { color: colors.textFaint, fontSize: 11 },
  link: { color: colors.accent, fontSize: 12 },
});

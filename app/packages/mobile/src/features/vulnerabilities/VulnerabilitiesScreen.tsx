import { useMemo, useState } from "react";
import { Alert, Linking, Pressable, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import {
  VULNERABILITY_SEVERITY_LABELS,
  VULNERABILITY_SEVERITY_ORDER,
  filterVulnerabilityFindings,
  groupRunningByType,
  vulnerabilityFindingKey,
  type DismissedVulnerabilityFinding,
  type VulnerabilityFindingRow,
  type VulnerabilityRunningRef,
  type VulnerabilitySeverity,
  type VulnerabilitySource,
} from "@infrawrench/client-core";
import { Card, EmptyView, ErrorView, LoadingView, Screen, SectionTitle } from "@/components/ui";
import { useOrgApi } from "@/lib/auth/AuthProvider";
import { colors, radii, spacing } from "@/lib/theme";
import { useVulnerabilities, useVulnerabilityDismissal } from "./useVulnerabilities";

/** Rows rendered before "Show more": the feed can run to thousands on a busy registry. */
const PAGE = 100;

/**
 * Vulnerabilities; the native counterpart of the web/desktop Vulnerabilities
 * screens and the CLI: what the connected scanners found,
 * joined to the synced resources running the affected image.
 *
 * "Running only" starts on because a finding in an image nothing runs is a
 * backlog item, not a page; the summary chips still count both so the toggle
 * never hides the size of the backlog. Tapping a row expands it to the
 * resources running it (each opens the resource screen), the advisory link
 * and the dismiss action.
 *
 * Dismissing is behind a confirm and takes no note, the posture stance: a
 * justification is a desktop job. The confirm offers the two scopes the API
 * has, this artifact or the advisory everywhere. Alert settings are
 * deliberately not here; they are an org setting edited on web or desktop.
 */
export function VulnerabilitiesScreen() {
  const router = useRouter();
  const { orgId } = useOrgApi();
  const feed = useVulnerabilities();
  const { dismiss, restore } = useVulnerabilityDismissal();

  const [severities, setSeverities] = useState<VulnerabilitySeverity[]>([]);
  const [runningOnly, setRunningOnly] = useState(true);
  const [fixOnly, setFixOnly] = useState(false);
  const [kevOnly, setKevOnly] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [limit, setLimit] = useState(PAGE);
  const [showDismissed, setShowDismissed] = useState(false);

  const data = feed.data;
  const kevKnown = Boolean(data?.kevUpdatedAt);

  const visible = useMemo(
    () =>
      data
        ? filterVulnerabilityFindings(data.findings, {
            severities,
            running: runningOnly ? true : undefined,
            fixAvailable: fixOnly || undefined,
            kev: (kevKnown && kevOnly) || undefined,
          })
        : [],
    [data, severities, runningOnly, fixOnly, kevOnly, kevKnown],
  );

  const toggleSeverity = (sev: VulnerabilitySeverity) => {
    setLimit(PAGE);
    setSeverities((prev) => (prev.includes(sev) ? prev.filter((s) => s !== sev) : [...prev, sev]));
  };

  const confirmDismiss = (finding: VulnerabilityFindingRow) => {
    const send = (artifactKey: string) =>
      dismiss.mutate(
        { advisoryId: finding.advisoryId, artifactKey },
        {
          onError: (e) =>
            Alert.alert("Couldn't dismiss", e instanceof Error ? e.message : String(e)),
        },
      );
    Alert.alert(
      `Dismiss ${finding.advisoryId}?`,
      `${finding.artifact.name}\n\nIt leaves the list and the alerts until restored. Dismiss it for this artifact only, or for every artifact in the organization?`,
      [
        { text: "Cancel", style: "cancel" },
        { text: "This artifact", onPress: () => send(finding.artifact.key) },
        { text: "Everywhere", style: "destructive", onPress: () => send("*") },
      ],
    );
  };

  const undoDismiss = (finding: DismissedVulnerabilityFinding) =>
    restore.mutate(
      { advisoryId: finding.dismissal.advisoryId, artifactKey: finding.dismissal.artifactKey },
      {
        onError: (e) => Alert.alert("Couldn't restore", e instanceof Error ? e.message : String(e)),
      },
    );

  const openResource = (r: VulnerabilityRunningRef) =>
    router.push(
      `/org/${orgId}/resources/${encodeURIComponent(r.pluginId)}/${encodeURIComponent(
        r.resourceTypeId,
      )}/${encodeURIComponent(r.resourceId)}?accountId=${encodeURIComponent(r.accountId)}`,
    );

  if (feed.isLoading) return <LoadingView />;
  if (feed.isError) {
    return (
      <ErrorView
        message={
          feed.error instanceof Error ? feed.error.message : "Couldn't load vulnerability findings."
        }
        onRetry={() => void feed.refetch()}
      />
    );
  }

  if (!data || (data.sources.length === 0 && data.totalCount === 0 && data.dismissedCount === 0)) {
    return (
      <EmptyView message="No connected account can report vulnerability findings. Connect an account whose provider runs an image or dependency scanner, and its findings appear here joined to what is running." />
    );
  }

  const runningTotal = VULNERABILITY_SEVERITY_ORDER.reduce(
    (sum, sev) => sum + data.runningCounts[sev],
    0,
  );

  return (
    <Screen onRefresh={() => void feed.refetch()} refreshing={feed.isRefetching}>
      <Text style={styles.summary}>
        {data.totalCount} open {data.totalCount === 1 ? "finding" : "findings"}, {runningTotal}{" "}
        running
      </Text>
      <View style={styles.chips}>
        {VULNERABILITY_SEVERITY_ORDER.map(
          (sev) =>
            data.counts[sev] > 0 && (
              <View key={sev} style={styles.chip}>
                <Text style={[styles.chipCount, { color: SEVERITY_COLORS[sev] }]}>
                  {data.counts[sev]}
                </Text>
                <Text style={styles.chipLabel}>
                  {VULNERABILITY_SEVERITY_LABELS[sev]} · {data.runningCounts[sev]} running
                </Text>
              </View>
            ),
        )}
      </View>

      <View style={styles.chips}>
        {VULNERABILITY_SEVERITY_ORDER.map((sev) => (
          <FilterChip
            key={sev}
            label={VULNERABILITY_SEVERITY_LABELS[sev]}
            selected={severities.includes(sev)}
            onPress={() => toggleSeverity(sev)}
          />
        ))}
        <FilterChip
          label="Running only"
          selected={runningOnly}
          onPress={() => {
            setLimit(PAGE);
            setRunningOnly((v) => !v);
          }}
        />
        <FilterChip
          label="Fix available"
          selected={fixOnly}
          onPress={() => {
            setLimit(PAGE);
            setFixOnly((v) => !v);
          }}
        />
        {kevKnown && (
          <FilterChip
            label="Known exploited"
            selected={kevOnly}
            onPress={() => {
              setLimit(PAGE);
              setKevOnly((v) => !v);
            }}
          />
        )}
      </View>

      {visible.length === 0 ? (
        <Text style={styles.footnote}>
          {data.totalCount === 0
            ? data.dismissedCount > 0
              ? "No open findings. Everything reported has been dismissed as an accepted risk."
              : "No findings reported."
            : "No findings match these filters."}
        </Text>
      ) : (
        <Card list>
          {visible.slice(0, limit).map((finding) => {
            const key = vulnerabilityFindingKey(finding);
            return (
              <FindingRow
                key={key}
                finding={finding}
                expanded={expanded === key}
                onToggle={() => setExpanded((cur) => (cur === key ? null : key))}
                onOpenResource={openResource}
                actionLabel="Dismiss"
                onAction={() => confirmDismiss(finding)}
                busy={dismiss.isPending}
              />
            );
          })}
        </Card>
      )}
      {visible.length > limit && (
        <Pressable
          accessibilityRole="button"
          onPress={() => setLimit((l) => l + PAGE)}
          style={styles.more}
        >
          <Text style={styles.link}>Show more ({visible.length - limit} left)</Text>
        </Pressable>
      )}

      {data.dismissed.length > 0 && (
        <View style={{ gap: spacing.sm }}>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ expanded: showDismissed }}
            onPress={() => setShowDismissed((v) => !v)}
          >
            <SectionTitle>
              {showDismissed ? "▾" : "▸"} Dismissed ({data.dismissed.length})
            </SectionTitle>
          </Pressable>
          {showDismissed && (
            <Card list>
              {data.dismissed.map((finding) => {
                const key = `dismissed:${vulnerabilityFindingKey(finding)}`;
                return (
                  <FindingRow
                    key={key}
                    finding={finding}
                    muted
                    detail={dismissalLine(finding)}
                    expanded={expanded === key}
                    onToggle={() => setExpanded((cur) => (cur === key ? null : key))}
                    onOpenResource={openResource}
                    actionLabel="Restore"
                    onAction={() => undoDismiss(finding)}
                    busy={restore.isPending}
                  />
                );
              })}
            </Card>
          )}
        </View>
      )}

      {data.sources.length > 0 && (
        <View style={{ gap: spacing.sm }}>
          <SectionTitle>Sources</SectionTitle>
          <Card list>
            {data.sources.map((source) => (
              <SourceRow key={`${source.accountId}:${source.scanner}`} source={source} />
            ))}
          </Card>
        </View>
      )}

      <Text style={styles.footnote}>
        Collected from each provider's scanner and matched to synced resources by image digest,
        resource id or tag.
        {data.kevUpdatedAt
          ? ` Known-exploited flags come from the CISA KEV catalog, updated ${formatDate(
              data.kevUpdatedAt,
            )}.`
          : ""}{" "}
        Dismissed findings stay off the list and out of alerts until restored.
      </Text>
    </Screen>
  );
}

const SEVERITY_COLORS: Record<VulnerabilitySeverity, string> = {
  critical: colors.danger,
  high: colors.warning,
  medium: colors.accent,
  low: colors.textMuted,
  unknown: colors.textFaint,
};

function formatDate(iso: string): string {
  return Number.isNaN(Date.parse(iso)) ? iso : new Date(iso).toLocaleDateString();
}

/** "Running in 3 Pods and 1 Lambda Function", plural-aware per type. */
function runningLine(running: readonly VulnerabilityRunningRef[]): string {
  const parts = groupRunningByType(running).map(
    (g) => `${g.count} ${g.count === 1 ? g.resourceTypeName : g.resourceTypePluralName}`,
  );
  if (parts.length === 0) return "Not running anywhere synced";
  const joined =
    parts.length === 1
      ? parts[0]!
      : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]!}`;
  return `Running in ${joined}`;
}

/** "lodash 4.17.20 → 4.17.21"; a scanner that does not say whether a fix exists reads "Unknown". */
function packageLine(f: VulnerabilityFindingRow): string {
  const fixed =
    f.fixedVersion ??
    (f.fixAvailable === null ? "Unknown" : f.fixAvailable ? "fix available" : "no fix");
  const pkg = [f.packageName, f.installedVersion].filter(Boolean).join(" ");
  return `${pkg || "Package not reported"} → ${fixed}`;
}

/** "Dismissed everywhere 2 Mar 2026 by Ada: base image pinned upstream". */
function dismissalLine(finding: DismissedVulnerabilityFinding): string {
  const scope = finding.dismissal.artifactKey === "*" ? " everywhere" : "";
  const by = finding.dismissal.dismissedBy ? ` by ${finding.dismissal.dismissedBy}` : "";
  const why = finding.dismissal.reason ? `: ${finding.dismissal.reason}` : "";
  return `Dismissed${scope} ${formatDate(finding.dismissal.dismissedAt)}${by}${why}`;
}

function FilterChip({
  label,
  selected,
  onPress,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityState={{ checked: selected }}
      onPress={onPress}
      style={[styles.filter, selected && styles.filterSelected]}
    >
      <Text style={selected ? styles.filterTextSelected : styles.filterText}>{label}</Text>
    </Pressable>
  );
}

function FindingRow({
  finding,
  expanded,
  onToggle,
  onOpenResource,
  actionLabel,
  onAction,
  busy,
  muted,
  detail,
}: {
  finding: VulnerabilityFindingRow;
  expanded: boolean;
  onToggle: () => void;
  onOpenResource: (r: VulnerabilityRunningRef) => void;
  actionLabel: string;
  onAction: () => void;
  busy: boolean;
  /** Dismissed rows read as settled, not as alarms. */
  muted?: boolean;
  /** Extra line, e.g. who dismissed it and why. */
  detail?: string;
}) {
  const severityColor = muted ? colors.textMuted : SEVERITY_COLORS[finding.severity];
  const url = finding.url;
  return (
    <View>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        accessibilityLabel={`${finding.advisoryId}, ${
          VULNERABILITY_SEVERITY_LABELS[finding.severity]
        }${finding.kev ? ", known exploited" : ""}, ${finding.artifact.name}`}
        onPress={onToggle}
        style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
      >
        <View style={styles.rowMain}>
          <View style={styles.titleLine}>
            <Text style={styles.title} numberOfLines={1}>
              {finding.advisoryId}
            </Text>
            {finding.kev && (
              <Text style={[styles.kev, muted && { color: colors.textMuted }]}>KEV</Text>
            )}
          </View>
          <Text style={styles.subtitle} numberOfLines={1}>
            {packageLine(finding)}
          </Text>
          <Text style={styles.subtitle} numberOfLines={1}>
            {finding.artifact.name}
          </Text>
          <Text style={styles.reason} numberOfLines={2}>
            {detail ?? runningLine(finding.running)}
          </Text>
        </View>
        <View style={styles.rowEnd}>
          <Text style={[styles.severity, { color: severityColor }]}>
            {VULNERABILITY_SEVERITY_LABELS[finding.severity]}
          </Text>
          {finding.cvssScore !== null && (
            <Text style={styles.cvss}>CVSS {finding.cvssScore.toFixed(1)}</Text>
          )}
        </View>
      </Pressable>

      {expanded && (
        <View style={styles.expanded}>
          {finding.title ? <Text style={styles.body}>{finding.title}</Text> : null}
          <Text style={styles.reason}>
            {finding.pluginName} · {finding.accountName} · {finding.scanner}
            {finding.kev?.dueDate ? ` · CISA due ${finding.kev.dueDate}` : ""}
            {finding.kev?.knownRansomware ? " · used in ransomware" : ""}
          </Text>
          {detail ? <Text style={styles.reason}>{runningLine(finding.running)}</Text> : null}
          {finding.running.map((r) => (
            <Pressable
              key={r.resourceId}
              accessibilityRole="link"
              accessibilityLabel={`${r.displayName}, ${r.resourceTypeName}, ${r.accountName}`}
              onPress={() => onOpenResource(r)}
              style={({ pressed }) => [styles.resource, pressed && styles.rowPressed]}
            >
              <Text style={styles.resourceName} numberOfLines={1}>
                {r.displayName}
              </Text>
              <Text style={styles.reason} numberOfLines={1}>
                {r.resourceTypeName} · {r.accountName}
                {r.matchedBy === "tag" ? " · matched by tag" : ""}
              </Text>
            </Pressable>
          ))}
          <View style={styles.actions}>
            {url && (
              <Pressable
                accessibilityRole="link"
                onPress={() => void Linking.openURL(url)}
                hitSlop={8}
              >
                <Text style={styles.link}>Open advisory</Text>
              </Pressable>
            )}
            <Pressable accessibilityRole="button" disabled={busy} onPress={onAction} hitSlop={8}>
              <Text style={[styles.action, busy && styles.actionBusy]}>{actionLabel}</Text>
            </Pressable>
          </View>
        </View>
      )}
    </View>
  );
}

function SourceRow({ source }: { source: VulnerabilitySource }) {
  const help = source.helpUrl;
  const status = source.error
    ? null
    : source.lastCollectedAt
      ? `${source.findingCount} ${source.findingCount === 1 ? "finding" : "findings"}, collected ${formatDate(source.lastCollectedAt)}${source.partial ? " (partial)" : ""}`
      : "Not collected yet";
  return (
    <View style={styles.source}>
      <Text style={styles.resourceName} numberOfLines={1}>
        {source.accountName}
      </Text>
      <Text style={styles.reason} numberOfLines={1}>
        {source.pluginName} · {source.scanner}
      </Text>
      {status && <Text style={styles.reason}>{status}</Text>}
      {source.error && <Text style={styles.error}>{source.error}</Text>}
      {help && (
        <Pressable accessibilityRole="link" onPress={() => void Linking.openURL(help)} hitSlop={8}>
          <Text style={styles.link}>{source.helpLabel ?? "How to fix this"}</Text>
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  summary: { color: colors.textSecondary, fontSize: 13 },
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
  filter: {
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radii.lg,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs + 2,
  },
  filterSelected: { backgroundColor: colors.accent, borderColor: colors.accent },
  filterText: { color: colors.textMuted, fontSize: 12 },
  filterTextSelected: { color: colors.text, fontSize: 12, fontWeight: "600" },
  row: { flexDirection: "row", alignItems: "center", gap: spacing.md, paddingVertical: 10 },
  rowPressed: { backgroundColor: colors.surfaceOverlay },
  rowMain: { flex: 1, gap: 2 },
  titleLine: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  title: { color: colors.text, fontSize: 15, fontWeight: "500", flexShrink: 1 },
  kev: {
    color: colors.danger,
    borderColor: colors.danger,
    borderWidth: 1,
    borderRadius: radii.sm,
    paddingHorizontal: 4,
    fontSize: 10,
    fontWeight: "700",
  },
  subtitle: { color: colors.textMuted, fontSize: 12 },
  reason: { color: colors.textFaint, fontSize: 11 },
  body: { color: colors.textSecondary, fontSize: 13 },
  rowEnd: { alignItems: "flex-end", gap: 4 },
  severity: { fontSize: 13, fontWeight: "600" },
  cvss: { color: colors.textMuted, fontSize: 11 },
  expanded: { gap: spacing.sm, paddingBottom: spacing.md },
  resource: {
    gap: 2,
    paddingVertical: spacing.xs,
    paddingHorizontal: spacing.sm,
    borderLeftColor: colors.borderStrong,
    borderLeftWidth: 2,
  },
  resourceName: { color: colors.text, fontSize: 13 },
  actions: { flexDirection: "row", justifyContent: "flex-end", gap: spacing.lg },
  link: { color: colors.accent, fontSize: 12 },
  action: { color: colors.textMuted, fontSize: 12 },
  actionBusy: { opacity: 0.5 },
  more: { alignItems: "center", paddingVertical: spacing.sm },
  source: { gap: 2, paddingVertical: 10 },
  error: { color: colors.danger, fontSize: 12 },
  footnote: { color: colors.textFaint, fontSize: 11 },
});

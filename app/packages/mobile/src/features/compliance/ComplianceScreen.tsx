import { useMemo, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import {
  COMPLIANCE_CONTROL_STATUS_LABELS,
  EVIDENCE_STATUS_LABELS,
  getEvidenceSource,
  type ComplianceControlRow,
  type ComplianceControlStatus,
  type CompliancePeriod,
  type EvidenceSourceId,
  type EvidenceSourceResult,
  type EvidenceStatus,
} from "@infrawrench/client-core";
import {
  Card,
  EmptyView,
  ErrorView,
  LoadingView,
  Screen,
  SectionTitle,
  TabStrip,
} from "@/components/ui";
import { colors, radii, spacing } from "@/lib/theme";
import { useComplianceFrameworks, useComplianceStatus } from "./useCompliance";

/** The period chips. 90 is the server's default window and the screen's. */
const PERIOD_OPTIONS = [30, 90] as const;
type PeriodDays = (typeof PERIOD_OPTIONS)[number];

/** The last `days` days ending today (UTC), the same window the server defaults to. */
function periodForDays(days: number, now: Date = new Date()): CompliancePeriod {
  const to = now.toISOString().slice(0, 10);
  const from = new Date(Date.parse(`${to}T00:00:00Z`) - (days - 1) * 86_400_000)
    .toISOString()
    .slice(0, 10);
  return { from, to };
}

/**
 * Compliance; the read-only native counterpart of the web/desktop Compliance
 * screens: pick a framework (SOC 2, ISO 27001), see every control's status
 * over the last 30 or 90 days, tap a control for why it is not green, and
 * read what each evidence source reported.
 *
 * Deliberately read-only. Not here, and done on web or desktop instead:
 * - no control editing (applicability, justification, owner, notes);
 * - no evidence pack download (a zip has nowhere useful to go on a phone);
 * - no pack schedule editing.
 */
export function ComplianceScreen() {
  const frameworks = useComplianceFrameworks();
  const [picked, setPicked] = useState<string | null>(null);
  const [days, setDays] = useState<PeriodDays>(90);
  const [expanded, setExpanded] = useState<string | null>(null);

  const frameworkId = picked ?? frameworks.data?.[0]?.id ?? null;
  const period = useMemo(() => periodForDays(days), [days]);
  const status = useComplianceStatus(frameworkId, period);

  const groups = useMemo(() => {
    const out: { group: string; controls: ComplianceControlRow[] }[] = [];
    for (const control of status.data?.controls ?? []) {
      const existing = out.find((g) => g.group === control.group);
      if (existing) existing.controls.push(control);
      else out.push({ group: control.group, controls: [control] });
    }
    return out;
  }, [status.data]);

  if (frameworks.isLoading) return <LoadingView />;
  if (frameworks.isError) {
    return (
      <ErrorView
        message={
          frameworks.error instanceof Error
            ? frameworks.error.message
            : "Couldn't load compliance frameworks."
        }
        onRetry={() => void frameworks.refetch()}
      />
    );
  }
  if (!frameworks.data || frameworks.data.length === 0 || frameworkId === null) {
    return <EmptyView message="No compliance frameworks are available for this organization." />;
  }

  const refresh = () => {
    void frameworks.refetch();
    void status.refetch();
  };

  const data = status.data;

  return (
    <Screen onRefresh={refresh} refreshing={status.isRefetching || frameworks.isRefetching}>
      <TabStrip
        tabs={frameworks.data.map((f) => ({ id: f.id, label: f.name }))}
        value={frameworkId}
        onChange={(id) => {
          setExpanded(null);
          setPicked(id);
        }}
      />

      <View style={styles.chips}>
        {PERIOD_OPTIONS.map((d) => (
          <FilterChip
            key={d}
            label={`Last ${d} days`}
            selected={days === d}
            onPress={() => setDays(d)}
          />
        ))}
      </View>

      {status.isLoading ? (
        <LoadingView />
      ) : status.isError ? (
        <ErrorView
          message={
            status.error instanceof Error
              ? status.error.message
              : "Couldn't load compliance status."
          }
          onRetry={() => void status.refetch()}
        />
      ) : !data ? (
        <EmptyView message="No compliance status for this framework." />
      ) : (
        <>
          <Text style={styles.summary}>
            {data.framework.name} {data.framework.version} · {data.period.from} to {data.period.to}
          </Text>
          <View style={styles.chips}>
            <CountChip count={data.counts.evidence} label="Evidence" color={colors.success} />
            <CountChip count={data.counts.gaps} label="Gaps" color={colors.danger} />
            <CountChip
              count={data.counts.notApplicable}
              label="Not applicable"
              color={colors.textMuted}
            />
            <CountChip count={data.counts.unowned} label="Unowned" color={colors.warning} />
          </View>

          {groups.map(({ group, controls }) => (
            <View key={group} style={{ gap: spacing.sm }}>
              <SectionTitle>{group}</SectionTitle>
              <Card list>
                {controls.map((control) => (
                  <ControlRow
                    key={control.id}
                    control={control}
                    sources={data.sources}
                    expanded={expanded === control.id}
                    onToggle={() => setExpanded((cur) => (cur === control.id ? null : control.id))}
                  />
                ))}
              </Card>
            </View>
          ))}

          {data.sources.length > 0 && (
            <View style={{ gap: spacing.sm }}>
              <SectionTitle>Evidence sources</SectionTitle>
              <Card list>
                {data.sources.map((source) => (
                  <SourceRow key={source.sourceId} source={source} />
                ))}
              </Card>
            </View>
          )}

          <Text style={styles.footnote}>
            {data.framework.scopeNote} Generated {formatDateTime(data.generatedAt)}. Control owners,
            applicability, evidence packs and pack schedules are edited on web or desktop.
          </Text>
        </>
      )}
    </Screen>
  );
}

const CONTROL_STATUS_COLORS: Record<ComplianceControlStatus, string> = {
  evidence: colors.success,
  gaps: colors.danger,
  "not-applicable": colors.textMuted,
};

const EVIDENCE_STATUS_COLORS: Record<EvidenceStatus, string> = {
  present: colors.success,
  gap: colors.danger,
  "no-data": colors.textMuted,
  unavailable: colors.warning,
};

function formatDateTime(iso: string): string {
  return Number.isNaN(Date.parse(iso)) ? iso : new Date(iso).toLocaleString();
}

function sourceLabel(id: EvidenceSourceId, sources: readonly EvidenceSourceResult[]): string {
  return sources.find((s) => s.sourceId === id)?.label ?? getEvidenceSource(id)?.label ?? id;
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
      accessibilityRole="radio"
      accessibilityState={{ checked: selected }}
      onPress={onPress}
      style={[styles.filter, selected && styles.filterSelected]}
    >
      <Text style={selected ? styles.filterTextSelected : styles.filterText}>{label}</Text>
    </Pressable>
  );
}

function CountChip({ count, label, color }: { count: number; label: string; color: string }) {
  return (
    <View style={styles.chip}>
      <Text style={[styles.chipCount, { color }]}>{count}</Text>
      <Text style={styles.chipLabel}>{label}</Text>
    </View>
  );
}

function ControlRow({
  control,
  sources,
  expanded,
  onToggle,
}: {
  control: ComplianceControlRow;
  sources: readonly EvidenceSourceResult[];
  expanded: boolean;
  onToggle: () => void;
}) {
  const statusLabel = COMPLIANCE_CONTROL_STATUS_LABELS[control.status];
  const owner = control.owner?.displayName ?? (control.applicable ? "Unowned" : null);
  const mapped = control.sources
    .map((id) => sources.find((s) => s.sourceId === id))
    .filter((s): s is EvidenceSourceResult => Boolean(s));
  return (
    <View>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        accessibilityLabel={`${control.id}, ${control.title}, ${statusLabel}`}
        onPress={onToggle}
        style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
      >
        <View style={styles.rowMain}>
          <Text style={styles.title} numberOfLines={2}>
            <Text style={styles.controlId}>{control.id}</Text> {control.title}
          </Text>
          {owner && (
            <Text
              style={[styles.subtitle, !control.owner && { color: colors.warning }]}
              numberOfLines={1}
            >
              {control.owner ? `Owner: ${owner}` : owner}
            </Text>
          )}
        </View>
        <Text style={[styles.status, { color: CONTROL_STATUS_COLORS[control.status] }]}>
          {statusLabel}
        </Text>
      </Pressable>

      {expanded && (
        <View style={styles.expanded}>
          {!control.applicable && control.justification ? (
            <Text style={styles.body}>Not applicable: {control.justification}</Text>
          ) : null}
          {control.reasons.map((reason, i) => (
            <Text key={i} style={styles.reasonLine}>
              • {reason}
            </Text>
          ))}
          {control.missingSources.length > 0 && (
            <Text style={styles.reason}>
              No evidence from{" "}
              {control.missingSources.map((id) => sourceLabel(id, sources)).join(", ")}
            </Text>
          )}
          {control.notes ? <Text style={styles.reason}>Notes: {control.notes}</Text> : null}
          {mapped.map((source) => (
            <View key={source.sourceId} style={styles.mapped}>
              <View style={styles.titleLine}>
                <Text style={styles.sourceName} numberOfLines={1}>
                  {source.label}
                </Text>
                <Text style={[styles.badge, { color: EVIDENCE_STATUS_COLORS[source.status] }]}>
                  {EVIDENCE_STATUS_LABELS[source.status]}
                </Text>
              </View>
              <Text style={styles.reason}>{source.summary}</Text>
              {source.gaps.map((gap, i) => (
                <Text key={i} style={styles.gap}>
                  • {gap}
                </Text>
              ))}
            </View>
          ))}
        </View>
      )}
    </View>
  );
}

function SourceRow({ source }: { source: EvidenceSourceResult }) {
  return (
    <View style={styles.source}>
      <View style={styles.titleLine}>
        <Text style={styles.sourceName} numberOfLines={1}>
          {source.label}
        </Text>
        <Text style={[styles.badge, { color: EVIDENCE_STATUS_COLORS[source.status] }]}>
          {EVIDENCE_STATUS_LABELS[source.status]}
        </Text>
      </View>
      <Text style={styles.reason}>{source.summary}</Text>
      {source.metrics.length > 0 && (
        <Text style={styles.reason}>
          {source.metrics.map((m) => `${m.label}: ${m.value ?? "unknown"}`).join(" · ")}
        </Text>
      )}
      {source.gaps.map((gap, i) => (
        <Text key={i} style={styles.gap}>
          • {gap}
        </Text>
      ))}
      {source.error && <Text style={styles.error}>{source.error}</Text>}
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
  title: { color: colors.text, fontSize: 14, fontWeight: "500" },
  controlId: { color: colors.textMuted, fontWeight: "600" },
  subtitle: { color: colors.textMuted, fontSize: 12 },
  status: { fontSize: 12, fontWeight: "600" },
  expanded: { gap: spacing.sm, paddingBottom: spacing.md },
  body: { color: colors.textSecondary, fontSize: 13 },
  reasonLine: { color: colors.textSecondary, fontSize: 12 },
  reason: { color: colors.textFaint, fontSize: 11 },
  gap: { color: colors.danger, fontSize: 11 },
  mapped: {
    gap: 2,
    paddingVertical: spacing.xs,
    paddingHorizontal: spacing.sm,
    borderLeftColor: colors.borderStrong,
    borderLeftWidth: 2,
  },
  sourceName: { color: colors.text, fontSize: 13, flexShrink: 1 },
  badge: { fontSize: 11, fontWeight: "600" },
  source: { gap: 2, paddingVertical: 10 },
  error: { color: colors.danger, fontSize: 12 },
  footnote: { color: colors.textFaint, fontSize: 11 },
});

import { useMemo, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import {
  applySavingsFindingView,
  fetchSavingsFindings,
  fetchSavingsViews,
  formatMoney,
  SAVINGS_FINDING_KIND_LABELS,
  SAVINGS_FINDING_STATUS_LABELS,
  type SavingsFinding,
  type SavingsFindingMoney,
  type SavingsFindingStatusFilter,
} from "@infrawrench/client-core";
import { Card, SectionTitle, TabStrip } from "@/components/ui";
import { useOrgApi } from "@/lib/auth/AuthProvider";
import { colors, spacing } from "@/lib/theme";

/** At most this many rows on a phone; the rest are a count. */
const MAX_ROWS = 50;

const TABS: { id: SavingsFindingStatusFilter; label: string }[] = [
  { id: "open", label: "Open" },
  { id: "ready", label: "Ready" },
  { id: "in_progress", label: "In progress" },
  { id: "completed", label: "Completed" },
  { id: "archived", label: "Archived" },
];

function money(list: readonly SavingsFindingMoney[] | null | undefined): string {
  const first = list?.[0];
  return first ? formatMoney(first.amount, first.currency) : "None";
}

/**
 * The savings findings workflow, read-only: the native counterpart to
 * `SavingsFindingsSection` on web and desktop. Summary tiles, status tabs,
 * saved views (opened, never edited) and each finding's status, detected date
 * and note. Changing a status is an org-wide decision, so it stays on the
 * surfaces with the full list and its filters, the anomaly-tuning precedent.
 */
export function FindingsSection() {
  const router = useRouter();
  const { api, orgId } = useOrgApi();
  const [tab, setTab] = useState<SavingsFindingStatusFilter>("open");
  const [viewId, setViewId] = useState<string | null>(null);
  const findings = useQuery({
    queryKey: ["savings-findings", orgId],
    queryFn: () => fetchSavingsFindings(api, orgId),
  });
  const views = useQuery({
    queryKey: ["savings-views", orgId],
    queryFn: () => fetchSavingsViews(api, orgId),
  });
  const view = views.data?.find((v) => v.id === viewId) ?? null;

  const rows = useMemo(
    () =>
      applySavingsFindingView(findings.data?.findings ?? [], {
        status: view ? view.status : tab,
        filter: view?.filter ?? {},
        sort: view?.sort ?? { field: "savings", direction: "desc" },
      }),
    [findings.data, view, tab],
  );

  function open(f: SavingsFinding) {
    if (!f.resourceId || !f.pluginId || !f.resourceTypeId || !f.present) return;
    router.push(
      `/org/${orgId}/resources/${encodeURIComponent(f.pluginId)}/${encodeURIComponent(
        f.resourceTypeId,
      )}/${encodeURIComponent(f.resourceId)}`,
    );
  }

  const summary = findings.data?.summary;
  const rate = summary?.savingsRate?.[0];

  return (
    <>
      <SectionTitle>Findings</SectionTitle>
      {findings.isError ? (
        <Card>
          <Text style={styles.error}>
            Couldn&apos;t load savings findings:{" "}
            {findings.error instanceof Error ? findings.error.message : "request failed"}
          </Text>
        </Card>
      ) : findings.isLoading || !summary ? (
        <Card>
          <Text style={styles.muted}>Loading savings findings…</Text>
        </Card>
      ) : (
        <>
          <View style={styles.tiles}>
            <Tile label="Potential / mo" value={money(summary.potentialMonthly)} />
            <Tile
              label={`Realized, ${summary.realizedWindowDays}d`}
              value={summary.realized ? money(summary.realized) : "No access"}
            />
            <Tile label="Savings rate" value={rate ? `${Math.round(rate.rate * 100)}%` : "-"} />
            <Tile label="Open" value={String(summary.counts.ready + summary.counts.in_progress)} />
          </View>

          {(views.data?.length ?? 0) > 0 && (
            <TabStrip
              tabs={[
                { id: "", label: "All findings" },
                ...(views.data ?? []).map((v) => ({ id: v.id, label: v.name })),
              ]}
              value={viewId ?? ""}
              onChange={(id) => setViewId(id === "" ? null : id)}
            />
          )}
          {!view && <TabStrip tabs={TABS} value={tab} onChange={setTab} />}

          {rows.length === 0 ? (
            <Card>
              <Text style={styles.muted}>No findings here.</Text>
            </Card>
          ) : (
            <Card list>
              {rows.slice(0, MAX_ROWS).map((f) => (
                <Pressable
                  key={f.key}
                  accessibilityRole="button"
                  onPress={() => open(f)}
                  style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
                >
                  <View style={styles.rowMain}>
                    <Text style={styles.title} numberOfLines={2}>
                      {f.title}
                    </Text>
                    <Text style={styles.subtitle} numberOfLines={1}>
                      {[SAVINGS_FINDING_KIND_LABELS[f.kind], f.accountName, f.region]
                        .filter(Boolean)
                        .join(" · ")}
                    </Text>
                    <Text style={styles.status} numberOfLines={2}>
                      {SAVINGS_FINDING_STATUS_LABELS[f.status]}
                      {f.resolution === "resolved" ? " (automatic)" : ""}
                      {f.statusChangedBy?.name ? ` · ${f.statusChangedBy.name}` : ""}
                      {f.statusNote ? ` · ${f.statusNote}` : ""}
                    </Text>
                    <Text style={styles.detected}>Detected {f.detectedAt.slice(0, 10)}</Text>
                  </View>
                  {f.monthlySavings && (
                    <View style={styles.costCell}>
                      <Text style={styles.cost}>
                        {formatMoney(f.monthlySavings.amount, f.monthlySavings.currency)}
                      </Text>
                      <Text style={styles.costWindow}>/ mo</Text>
                    </View>
                  )}
                </Pressable>
              ))}
            </Card>
          )}
          {rows.length > MAX_ROWS && (
            <Text style={styles.footnote}>
              {rows.length - MAX_ROWS} more; open Costs on the web or desktop app for the full list.
            </Text>
          )}
        </>
      )}
    </>
  );
}

function Tile({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.tile}>
      <Text style={styles.tileLabel}>{label}</Text>
      <Text style={styles.tileValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  tiles: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
  tile: {
    flexGrow: 1,
    flexBasis: "45%",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    borderRadius: 10,
    padding: spacing.md,
    backgroundColor: colors.surface,
  },
  tileLabel: { color: colors.textMuted, fontSize: 12 },
  tileValue: { color: colors.text, fontSize: 17, fontWeight: "600", marginTop: 2 },
  row: { flexDirection: "row", alignItems: "center", gap: spacing.md, paddingVertical: 10 },
  rowPressed: { backgroundColor: colors.surfaceOverlay },
  rowMain: { flex: 1, gap: 2 },
  title: { color: colors.text, fontSize: 15, fontWeight: "500" },
  subtitle: { color: colors.textMuted, fontSize: 12 },
  status: { color: colors.textMuted, fontSize: 12 },
  detected: { color: colors.textFaint, fontSize: 11 },
  costCell: { alignItems: "flex-end" },
  cost: { color: colors.text, fontSize: 14, fontWeight: "500" },
  costWindow: { color: colors.textFaint, fontSize: 11 },
  muted: { color: colors.textMuted, fontSize: 13 },
  error: { color: colors.danger, fontSize: 13 },
  footnote: { color: colors.textFaint, fontSize: 11 },
});

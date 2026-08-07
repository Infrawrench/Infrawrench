import { Pressable, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import type { DnsRecordEntry, DnsTargetClassification } from "@infrawrench/client-core";
import { Card, EmptyView, ErrorView, LoadingView, Screen, SectionTitle } from "@/components/ui";
import { useOrgApi } from "@/lib/auth/AuthProvider";
import { colors, radii, spacing } from "@/lib/theme";
import { useDns } from "./useDns";

/**
 * Domains — the native counterpart of the web/desktop Domains screens and the
 * `infrawrench dns` CLI: every zone and record across every provider, with
 * each record's target judged against the rest of the workspace.
 *
 * Records lead and zones follow, because the actionable thing is a record with
 * a dangling target and the feed is already sorted worst-first. Tapping a row
 * opens the resource, which is where the fix actually lives.
 */
export function DnsScreen() {
  const router = useRouter();
  const { orgId } = useOrgApi();
  const dns = useDns();

  if (dns.isLoading) return <LoadingView />;
  if (dns.isError) {
    return (
      <ErrorView
        message={
          dns.error instanceof Error ? dns.error.message : "Couldn't load the DNS inventory."
        }
        onRetry={() => void dns.refetch()}
      />
    );
  }

  const data = dns.data;
  if (!data || (data.counts.zones === 0 && data.counts.records === 0)) {
    return (
      <EmptyView message="No DNS zones synced. Connect an account on a provider that manages DNS — Cloudflare, Route 53, Cloud DNS, DigitalOcean, Netlify, Azure DNS or Vercel." />
    );
  }

  const openResource = (
    pluginId: string,
    resourceTypeId: string,
    resourceId: string,
    accountId: string,
  ) =>
    router.push(
      `/org/${orgId}/resources/${encodeURIComponent(pluginId)}/${encodeURIComponent(
        resourceTypeId,
      )}/${encodeURIComponent(resourceId)}?accountId=${encodeURIComponent(accountId)}`,
    );

  return (
    <Screen onRefresh={() => void dns.refetch()} refreshing={dns.isRefetching}>
      <View style={styles.chips}>
        <Chip count={data.counts.zones} label="Zones" color={colors.textMuted} />
        <Chip count={data.counts.records} label="Records" color={colors.textMuted} />
        {data.counts.dangling > 0 && (
          <Chip count={data.counts.dangling} label="Dangling" color={colors.danger} />
        )}
      </View>

      {data.records.length > 0 && (
        <View style={{ gap: spacing.sm }}>
          <SectionTitle>Records</SectionTitle>
          <Card list>
            {data.records.map((record) => (
              <DnsRow
                key={record.resourceId}
                record={record}
                onPress={() =>
                  openResource(
                    record.pluginId,
                    record.resourceTypeId,
                    record.resourceId,
                    record.accountId,
                  )
                }
              />
            ))}
          </Card>
        </View>
      )}

      {data.zones.length > 0 && (
        <View style={{ gap: spacing.sm }}>
          <SectionTitle>Zones</SectionTitle>
          <Card list>
            {data.zones.map((zone) => (
              <Pressable
                key={zone.resourceId}
                accessibilityRole="button"
                accessibilityLabel={`${zone.domain}, ${zone.recordCount} records`}
                onPress={() =>
                  openResource(zone.pluginId, zone.resourceTypeId, zone.resourceId, zone.accountId)
                }
                style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
              >
                <View style={styles.rowMain}>
                  <Text style={styles.title} numberOfLines={1}>
                    {zone.domain}
                    {zone.isPrivate ? " · private" : ""}
                  </Text>
                  <Text style={styles.subtitle} numberOfLines={1}>
                    {zone.pluginName} · {zone.accountName} · {zone.recordCount} record
                    {zone.recordCount === 1 ? "" : "s"}
                  </Text>
                </View>
                {zone.danglingCount > 0 && (
                  <Text style={[styles.status, { color: colors.danger }]}>
                    {zone.danglingCount} dangling
                  </Text>
                )}
              </Pressable>
            ))}
          </Card>
        </View>
      )}

      {data.skippedNamespaces.length > 0 && (
        <View style={{ gap: spacing.sm }}>
          <SectionTitle>Not checked</SectionTitle>
          {data.skippedNamespaces.map((entry) => (
            <Text key={`${entry.pluginId}:${entry.label}`} style={styles.reason}>
              {entry.label} — {entry.reason}
            </Text>
          ))}
        </View>
      )}

      <Text style={styles.footnote}>
        Computed from state the org has already synced — no provider calls and no DNS resolution. A
        dangling record points into a provider namespace nothing synced claims; those also appear on
        Posture and feed the posture alerts.
      </Text>
    </Screen>
  );
}

/** Dangling shares the danger red with "act now"; the rest stay quiet. */
const STATUS_COLORS: Record<DnsTargetClassification, string> = {
  dangling: colors.danger,
  owned: colors.accent,
  external: colors.textMuted,
  "not-analysed": colors.textFaint,
};

const STATUS_LABELS: Record<DnsTargetClassification, string> = {
  dangling: "Dangling",
  owned: "Internal",
  external: "External",
  "not-analysed": "—",
};

function Chip({ count, label, color }: { count: number; label: string; color: string }) {
  return (
    <View style={styles.chip}>
      <Text style={[styles.chipCount, { color }]}>{count}</Text>
      <Text style={styles.chipLabel}>{label}</Text>
    </View>
  );
}

function DnsRow({ record, onPress }: { record: DnsRecordEntry; onPress: () => void }) {
  const dangling = record.targets.find((t) => t.service);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${record.type} ${record.name}, ${STATUS_LABELS[record.status] ?? record.status}`}
      onPress={onPress}
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
    >
      <View style={styles.rowMain}>
        <Text style={styles.title} numberOfLines={1}>
          {record.type} {record.name}
        </Text>
        <Text style={styles.subtitle} numberOfLines={2}>
          {record.targets.map((t) => t.value).join(", ") || "—"}
        </Text>
        {dangling?.service && (
          <Text style={styles.reason} numberOfLines={3}>
            {dangling.service.label} — nothing synced claims &ldquo;{dangling.service.claimLabel}
            &rdquo;. {dangling.service.reason}
          </Text>
        )}
      </View>
      <Text style={[styles.status, { color: STATUS_COLORS[record.status] ?? colors.textMuted }]}>
        {STATUS_LABELS[record.status] ?? record.status}
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
  status: { fontSize: 13, fontWeight: "600" },
  footnote: { color: colors.textFaint, fontSize: 11 },
});

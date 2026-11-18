import { StyleSheet, Text, View } from "react-native";
import { useQuery } from "@tanstack/react-query";
import {
  fetchPriceChanges,
  formatPriceChangeHourly,
  formatPriceChangePercent,
  formatPriceChangeUsd,
  priceChangeDay,
  priceChangePlatformLabel,
  type PriceChange,
} from "@infrawrench/client-core";
import { Card, SectionTitle } from "@/components/ui";
import { useOrgApi } from "@/lib/auth/AuthProvider";
import { colors, spacing } from "@/lib/theme";

/** The org's changes over its thresholds, newest first; a price-change push lands here. */
function usePriceChanges() {
  const { api, orgId } = useOrgApi();
  return useQuery({
    queryKey: ["price-changes", orgId],
    queryFn: () => fetchPriceChanges(api, orgId, { days: 90 }),
  });
}

/**
 * "Price changes"; the native counterpart to the Price catalog tab's Changes
 * view on web and desktop: list-price changes on instance types the org runs,
 * with what each does to the month. Read-only: thresholds, the catalog-wide
 * list and making a scenario model are web and desktop only.
 */
export function PriceChangesSection() {
  const query = usePriceChanges();
  const changes = (query.data?.changes ?? []).filter((c) => !c.belowThreshold);

  return (
    <>
      <SectionTitle>Price changes</SectionTitle>
      {query.isError ? (
        <Card>
          <Text style={styles.error}>
            Couldn&apos;t load price changes:{" "}
            {query.error instanceof Error ? query.error.message : "request failed"}
          </Text>
        </Card>
      ) : query.isLoading ? (
        <Card>
          <Text style={styles.muted}>Loading price changes…</Text>
        </Card>
      ) : changes.length === 0 ? (
        <Card>
          <Text style={styles.muted}>No list-price changes on what you run lately.</Text>
        </Card>
      ) : (
        <>
          <Card list>
            {changes.map((c) => (
              <Row key={c.id} change={c} />
            ))}
          </Card>
          <Text style={styles.footnote}>Published list prices in USD, last 90 days.</Text>
        </>
      )}
    </>
  );
}

function Row({ change: c }: { change: PriceChange }) {
  const where = c.region && c.region !== "global" ? ` · ${c.region}` : "";
  const units = `${c.approximate ? "at least " : ""}${c.units} running`;
  return (
    <View style={styles.row}>
      <View style={styles.rowMain}>
        <Text style={styles.title} numberOfLines={1}>
          {c.instanceType}
        </Text>
        <Text style={styles.subtitle} numberOfLines={2}>
          {priceChangePlatformLabel(c.platform)}
          {where} · {formatPriceChangeHourly(c.oldHourlyUsd)} →{" "}
          {formatPriceChangeHourly(c.newHourlyUsd)} ({formatPriceChangePercent(c.percent)}) ·{" "}
          {c.upcoming ? "from" : "since"} {priceChangeDay(c.effectiveAt)} · {units}
        </Text>
      </View>
      <View style={styles.costCell}>
        <Text style={[styles.cost, c.monthlyImpactUsd > 0 ? styles.up : styles.down]}>
          {formatPriceChangeUsd(c.monthlyImpactUsd, { signed: true })}
        </Text>
        <Text style={styles.costUnit}>/mo list</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: spacing.md, paddingVertical: 10 },
  rowMain: { flex: 1, gap: 2 },
  title: { color: colors.text, fontSize: 15, fontWeight: "500" },
  subtitle: { color: colors.textMuted, fontSize: 12 },
  costCell: { alignItems: "flex-end" },
  cost: { fontSize: 14, fontWeight: "500" },
  up: { color: colors.danger },
  down: { color: colors.success },
  costUnit: { color: colors.textFaint, fontSize: 11 },
  muted: { color: colors.textMuted, fontSize: 13 },
  error: { color: colors.danger, fontSize: 13 },
  footnote: { color: colors.textFaint, fontSize: 11 },
});

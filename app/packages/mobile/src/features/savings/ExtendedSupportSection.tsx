import { Pressable, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import {
  extendedSupportFindingKey,
  fetchExtendedSupport,
  formatMoney,
  type ExtendedSupportFinding,
  type ExtendedSupportStatus,
  type ExtendedSupportTotal,
} from "@infrawrench/client-core";
import { Card, SectionTitle } from "@/components/ui";
import { useOrgApi } from "@/lib/auth/AuthProvider";
import { colors, spacing } from "@/lib/theme";

const STATUS_LABEL: Record<ExtendedSupportStatus, string> = {
  "end-of-life": "Past end of support",
  surcharged: "Paying extended support",
  unsupported: "Out of standard support",
  upcoming: "Surcharge upcoming",
};

function totals(list: ExtendedSupportTotal[]): string {
  return list.map((t) => formatMoney(t.monthly, t.currency)).join(" + ");
}

/** `GET /extended-support`; refetched by the Costs tab's pull-to-refresh. */
function useExtendedSupport() {
  const { api, orgId } = useOrgApi();
  return useQuery({
    queryKey: ["extended-support", orgId],
    queryFn: () => fetchExtendedSupport(api, orgId),
  });
}

/**
 * "Extended support"; the native counterpart to the web/desktop section:
 * resources on versions their provider bills extra to keep supporting (or is
 * about to upgrade), with the monthly surcharge an upgrade removes. Read-only
 * like the rest of mobile's savings sections; rows open the resource.
 */
export function ExtendedSupportSection() {
  const router = useRouter();
  const { orgId } = useOrgApi();
  const query = useExtendedSupport();
  const data = query.data ?? null;

  function open(f: ExtendedSupportFinding) {
    router.push(
      `/org/${orgId}/resources/${encodeURIComponent(f.pluginId)}/${encodeURIComponent(
        f.resourceTypeId,
      )}/${encodeURIComponent(f.resourceId)}`,
    );
  }

  return (
    <>
      <SectionTitle>Extended support</SectionTitle>
      {query.isError ? (
        <Card>
          <Text style={styles.error}>
            Couldn&apos;t check support calendars —{" "}
            {query.error instanceof Error ? query.error.message : "request failed"}
          </Text>
        </Card>
      ) : query.isLoading ? (
        <Card>
          <Text style={styles.muted}>Checking versions against provider support calendars…</Text>
        </Card>
      ) : data && data.findings.length === 0 ? (
        <Card>
          <Text style={styles.muted}>
            Nothing is on an extended-support or end-of-life version.
          </Text>
        </Card>
      ) : data ? (
        <>
          {(data.currentMonthly.length > 0 || data.upcomingMonthly.length > 0) && (
            <Text style={styles.summary}>
              {data.currentMonthly.length > 0 ? `Paying now ${totals(data.currentMonthly)}/mo` : ""}
              {data.currentMonthly.length > 0 && data.upcomingMonthly.length > 0 ? " · " : ""}
              {data.upcomingMonthly.length > 0
                ? `Starting soon ${totals(data.upcomingMonthly)}/mo`
                : ""}
            </Text>
          )}
          <Card list>
            {data.findings.map((f) => (
              <Row key={extendedSupportFindingKey(f)} finding={f} onPress={() => open(f)} />
            ))}
          </Card>
          <Text style={styles.footnote}>
            Billed amounts where the provider&apos;s billing names the charge, list price otherwise.
            Upgrade from the provider&apos;s console or the web and desktop apps.
          </Text>
        </>
      ) : null}
    </>
  );
}

function Row({ finding: f, onPress }: { finding: ExtendedSupportFinding; onPress: () => void }) {
  const when =
    f.status === "upcoming"
      ? `starts ${f.surchargeStartsOn}`
      : f.extendedSupportEnds
        ? `forced upgrade ${f.extendedSupportEnds}`
        : `since ${f.surchargeStartsOn}`;
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
    >
      <View style={styles.rowMain}>
        <Text style={styles.title} numberOfLines={1}>
          {f.displayName}
        </Text>
        <Text style={styles.subtitle} numberOfLines={2}>
          {f.product} {f.currentVersion} → {f.targetVersion} · {STATUS_LABEL[f.status]} · {when}
        </Text>
      </View>
      {/* No figure renders as nothing, never as a zero. */}
      {f.monthlySurcharge !== null && f.currency !== null && (
        <View style={styles.costCell}>
          <Text style={styles.cost}>{formatMoney(f.monthlySurcharge, f.currency)}</Text>
          <Text style={styles.costUnit}>
            /mo {f.costBasis === "list-price" ? "list" : "billed"}
          </Text>
        </View>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: spacing.md, paddingVertical: 10 },
  rowPressed: { backgroundColor: colors.surfaceOverlay },
  rowMain: { flex: 1, gap: 2 },
  title: { color: colors.text, fontSize: 15, fontWeight: "500" },
  subtitle: { color: colors.textMuted, fontSize: 12 },
  costCell: { alignItems: "flex-end" },
  cost: { color: colors.text, fontSize: 14, fontWeight: "500" },
  costUnit: { color: colors.textFaint, fontSize: 11 },
  summary: { color: colors.text, fontSize: 13 },
  muted: { color: colors.textMuted, fontSize: 13 },
  error: { color: colors.danger, fontSize: 13 },
  footnote: { color: colors.textFaint, fontSize: 11 },
});

import { StyleSheet, Text, View } from "react-native";
import { useQuery } from "@tanstack/react-query";
import {
  CARBON_UNESTIMATED_LABELS,
  fetchCarbonEstimate,
  formatCo2e,
} from "@infrawrench/client-core";
import { useOrgApi } from "@/lib/auth/AuthProvider";
import { Card, Row, SectionTitle } from "@/components/ui";
import { colors, spacing } from "@/lib/theme";

/**
 * The carbon estimate, the native counterpart of the web/desktop Costs panel
 * section (`GET /carbon`, permission `costs:read`).
 *
 * The same three rules hold on a phone: "estimated" is in the heading, the
 * count of what could not be estimated sits beside the total, and the
 * assumptions are printed under it rather than behind a tap.
 */
export function CarbonSection() {
  const { api, orgId } = useOrgApi();
  const query = useQuery({
    queryKey: ["carbon", orgId],
    queryFn: () => fetchCarbonEstimate(api, orgId),
    retry: false,
  });
  const data = query.data;

  return (
    <>
      <SectionTitle>Estimated carbon</SectionTitle>
      {query.isError ? (
        <Card>
          <Text style={styles.error}>
            Couldn&apos;t load the carbon estimate:{" "}
            {query.error instanceof Error ? query.error.message : "request failed"}
          </Text>
        </Card>
      ) : query.isLoading ? (
        <Card>
          <Text style={styles.muted}>Estimating…</Text>
        </Card>
      ) : data ? (
        <>
          <Card>
            <View style={styles.totals}>
              <View style={styles.total}>
                <Text style={styles.big}>~{formatCo2e(data.totalKgCo2e)}</Text>
                <Text style={styles.muted}>
                  CO2e over {data.windowDays} days · {Math.round(data.totalKwh)} kWh
                </Text>
              </View>
              <View style={styles.total}>
                <Text style={[styles.big, data.unestimatedCount > 0 && styles.warningText]}>
                  {data.unestimatedCount}
                </Text>
                <Text style={styles.muted}>could not be estimated</Text>
              </View>
            </View>
          </Card>
          {data.byProvider.length > 0 && (
            <Card list>
              {data.byProvider.map((group) => (
                <Row
                  key={group.key}
                  title={group.label}
                  subtitle={`${group.resourceCount} resource${group.resourceCount === 1 ? "" : "s"}`}
                  right={<Text style={styles.value}>{formatCo2e(group.kgCo2e)}</Text>}
                />
              ))}
            </Card>
          )}
          {data.rows.length > 0 && (
            <Card list>
              {data.rows.slice(0, 8).map((row) => (
                <Row
                  key={row.resourceId}
                  title={row.displayName}
                  subtitle={`${row.pluginId} · ${row.region} · ${Math.round(row.gridIntensity)} g/kWh`}
                  right={<Text style={styles.value}>{formatCo2e(row.kgCo2e)}</Text>}
                />
              ))}
            </Card>
          )}
          {data.unestimated.length > 0 && (
            <Card list>
              {data.unestimated.slice(0, 8).map((row) => (
                <Row
                  key={row.resourceId}
                  title={row.displayName}
                  subtitle={CARBON_UNESTIMATED_LABELS[row.reason]}
                />
              ))}
            </Card>
          )}
          <Text style={styles.footnote}>
            Not measured. Assumes {Math.round(data.assumptions.cpuUtilization * 100)}% average CPU
            utilisation; grid figures from {data.assumptions.coefficientSource} (
            {data.assumptions.coefficientVintage}). {data.assumptions.scope}
          </Text>
        </>
      ) : null}
    </>
  );
}

const styles = StyleSheet.create({
  totals: { flexDirection: "row", gap: spacing.md },
  total: { flex: 1, gap: 2 },
  big: { color: colors.text, fontSize: 22, fontWeight: "700" },
  value: { color: colors.text, fontSize: 14 },
  muted: { color: colors.textMuted, fontSize: 12 },
  warningText: { color: colors.warning },
  error: { color: colors.danger, fontSize: 13 },
  footnote: { color: colors.textFaint, fontSize: 11 },
});

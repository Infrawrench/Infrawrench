import { Text, View } from "react-native";
import { useQuery } from "@tanstack/react-query";
import {
  fetchRealizedSavings,
  formatMoney,
  realizedSavingsRows,
  realizedSavingsWidgetRange,
  REALIZED_SAVINGS_GROUPING_LABELS,
  SAVINGS_EVENT_KIND_LABELS,
  type RealizedSavingsWidgetConfig,
  type SavingsEventKind,
} from "@infrawrench/client-core";
import { Card } from "@/components/ui";
import { useOrgApi } from "@/lib/auth/AuthProvider";
import { colors, spacing } from "@/lib/theme";

/**
 * The native `realized_savings` dashboard card: the headline and the card's
 * breakdown as a list (realized / projected), from the same report web and
 * desktop draw. The card's view choice is configured on web or desktop.
 */
export function RealizedSavingsCard({
  title,
  config,
}: {
  title: string;
  config: RealizedSavingsWidgetConfig;
}) {
  const { api, orgId } = useOrgApi();
  const range = realizedSavingsWidgetRange(config);
  const query = useQuery({
    queryKey: ["realized-savings", orgId, range.from, range.to],
    queryFn: () => fetchRealizedSavings(api, orgId, range),
  });
  const report = query.data ?? null;
  const primary = report?.totals[0] ?? null;

  return (
    <Card>
      <Text style={{ color: colors.text, fontSize: 15, fontWeight: "500" }}>
        {title || "Realized savings"}
      </Text>
      <Text style={{ color: colors.textFaint, fontSize: 12 }}>
        Last {config.months} months by{" "}
        {REALIZED_SAVINGS_GROUPING_LABELS[config.grouping].toLowerCase()}
      </Text>
      {query.isError ? (
        <Text style={{ color: colors.danger, fontSize: 13 }}>
          {query.error instanceof Error ? query.error.message : "Failed to load"}
        </Text>
      ) : query.isLoading ? (
        <Text style={{ color: colors.textMuted, fontSize: 13 }}>Loading…</Text>
      ) : !report || !primary ? (
        <Text style={{ color: colors.textMuted, fontSize: 13 }}>
          Nothing realized in this period.
        </Text>
      ) : (
        <View style={{ gap: spacing.xs }}>
          <Text style={{ color: colors.text, fontSize: 22, fontWeight: "600" }}>
            {formatMoney(primary.realized, primary.currency)}
          </Text>
          <Text style={{ color: colors.textMuted, fontSize: 12 }}>
            realized of {formatMoney(primary.projected, primary.currency)} projected
          </Text>
          {realizedSavingsRows(report, config.grouping, primary.currency)
            .slice(0, 8)
            .map((r) => (
              <View
                key={r.key}
                style={{ flexDirection: "row", justifyContent: "space-between", gap: spacing.md }}
              >
                <Text style={{ color: colors.textMuted, fontSize: 13, flex: 1 }} numberOfLines={1}>
                  {config.grouping === "kind"
                    ? (SAVINGS_EVENT_KIND_LABELS[r.key as SavingsEventKind] ?? r.label)
                    : r.label}
                </Text>
                <Text style={{ color: colors.text, fontSize: 13 }}>
                  {formatMoney(r.realized, primary.currency)}
                  <Text style={{ color: colors.textFaint }}>
                    {" "}
                    / {formatMoney(r.projected, primary.currency)}
                  </Text>
                </Text>
              </View>
            ))}
        </View>
      )}
    </Card>
  );
}

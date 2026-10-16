import { Text, View } from "react-native";
import { useQuery } from "@tanstack/react-query";
import {
  fetchDashboardKpi,
  formatDashboardKpiChange,
  formatDashboardKpiChangePercent,
  formatDashboardKpiValue,
  kpiChangeTone,
  kpiMeasureSummaryText,
  type KpiWidgetConfig,
} from "@infrawrench/client-core";
import { Card } from "@/components/ui";
import { useOrgApi } from "@/lib/auth/AuthProvider";
import { colors, spacing } from "@/lib/theme";

/**
 * The native `kpi` dashboard card: the same `POST /dashboards/kpi` web and
 * desktop answer it with, drawn as the big number and the change badge.
 * Read-only: KPIs are configured on web or desktop.
 */
export function KpiCard({ title, config }: { title: string; config: KpiWidgetConfig }) {
  const { api, orgId } = useOrgApi();
  const query = useQuery({
    queryKey: ["dashboard-kpi", orgId, config],
    queryFn: () => fetchDashboardKpi(api, orgId, config),
  });
  const result = query.data ?? null;
  const summary = kpiMeasureSummaryText(config);
  const absolute = result ? formatDashboardKpiChange(result) : null;
  const percent = result ? formatDashboardKpiChangePercent(result.changePercent) : null;
  const tone = result ? kpiChangeTone(result) : "neutral";
  const subtitle = [result?.sourceName, title ? summary : null].filter(Boolean).join(" · ");

  return (
    <Card>
      <Text style={{ color: colors.textMuted, fontSize: 13, fontWeight: "500" }}>
        {title || summary}
      </Text>
      {subtitle ? (
        <Text style={{ color: colors.textFaint, fontSize: 12 }} numberOfLines={1}>
          {subtitle}
        </Text>
      ) : null}
      {query.isError ? (
        <Text style={{ color: colors.danger, fontSize: 13 }}>
          {query.error instanceof Error ? query.error.message : "Failed to load"}
        </Text>
      ) : query.isLoading || !result ? (
        <Text style={{ color: colors.textMuted, fontSize: 13 }}>Loading…</Text>
      ) : (
        <View style={{ gap: spacing.xs }}>
          <Text style={{ color: colors.text, fontSize: 28, fontWeight: "600" }}>
            {formatDashboardKpiValue(result)}
          </Text>
          {result.limit !== undefined && result.limit !== null ? (
            <Text style={{ color: colors.textMuted, fontSize: 12 }}>
              of {formatDashboardKpiValue({ ...result, value: result.limit })} budget
            </Text>
          ) : null}
          {config.comparePreviousPeriod && absolute ? (
            <Text style={{ fontSize: 12, color: colors.textFaint }}>
              <Text
                style={{
                  color:
                    tone === "good"
                      ? colors.success
                      : tone === "bad"
                        ? colors.danger
                        : colors.textFaint,
                  fontWeight: "600",
                }}
              >
                {(result.change ?? 0) > 0 ? "▲ " : (result.change ?? 0) < 0 ? "▼ " : ""}
                {absolute}
                {percent ? ` (${percent})` : ""}
              </Text>{" "}
              vs previous period
            </Text>
          ) : null}
          {result.from && result.to ? (
            <Text style={{ color: colors.textFaint, fontSize: 11 }}>
              {result.from === result.to ? result.from : `${result.from} – ${result.to}`}
            </Text>
          ) : null}
          {result.note ? (
            <Text style={{ color: colors.textFaint, fontSize: 11 }}>{result.note}</Text>
          ) : null}
        </View>
      )}
    </Card>
  );
}

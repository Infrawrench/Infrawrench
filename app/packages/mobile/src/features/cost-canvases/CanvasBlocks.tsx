import { Text, View } from "react-native";
import {
  COST_DIMENSION_LABELS,
  formatBucketLabel,
  formatCostCanvasChange,
  formatCostCanvasKpi,
  formatMoney,
  type CostCanvasBlock,
  type CostCanvasBlockResult,
  type CostCanvasRunResult,
  type CostCanvasSpec,
} from "@infrawrench/client-core";
import { Card } from "@/components/ui";
import { ChatMarkdown } from "@/components/ChatMarkdown";
import { CostGraphCard } from "@/features/dashboard/CostGraphCard";
import { BudgetCard } from "@/features/dashboard/BudgetCard";
import { CustomGraphChart } from "@/features/dashboard/CustomGraphChart";
import { colors, spacing } from "@/lib/theme";

/**
 * Native rendering of a cost canvas, read-only: the counterpart of the
 * web/desktop `CostCanvasView`. Chart blocks draw through the dashboard's own
 * `CostGraphCard` (it queries live); everything else draws from the run
 * result the server computed. KPI tiles sit two to a row; a phone has no
 * room for four.
 */
export function CanvasBlocks({
  spec,
  result,
  compact,
}: {
  spec: CostCanvasSpec;
  result: CostCanvasRunResult | null | undefined;
  compact?: boolean;
}) {
  if (spec.blocks.length === 0) {
    return (
      <Card>
        <Text style={{ color: colors.textMuted, fontSize: 13 }}>
          This canvas has no blocks yet. It is built in the chat on web or desktop.
        </Text>
      </Card>
    );
  }
  const byId = new Map((result?.blocks ?? []).map((b) => [b.id, b]));
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.sm }}>
      {spec.blocks.map((block) => (
        <View key={block.id} style={{ width: block.kind === "kpi" ? "48%" : "100%" }}>
          <Block block={block} result={byId.get(block.id)} compact={!!compact} />
        </View>
      ))}
    </View>
  );
}

function Muted({ children }: { children: React.ReactNode }) {
  return <Text style={{ color: colors.textMuted, fontSize: 12 }}>{children}</Text>;
}

function Title({ children }: { children: React.ReactNode }) {
  return (
    <Text style={{ color: colors.text, fontSize: 14, fontWeight: "600" }} numberOfLines={1}>
      {children}
    </Text>
  );
}

function Block({
  block,
  result,
  compact,
}: {
  block: CostCanvasBlock;
  result: CostCanvasBlockResult | undefined;
  compact: boolean;
}) {
  if (block.kind === "chart") {
    return <CostGraphCard title={block.title} config={block.config} />;
  }
  if (!result) {
    return (
      <Card>
        <Muted>Loading…</Muted>
      </Card>
    );
  }
  if (result.error) {
    return (
      <Card>
        {block.kind !== "text" && block.title ? <Title>{block.title}</Title> : null}
        <Text style={{ color: colors.danger, fontSize: 13 }}>{result.error}</Text>
      </Card>
    );
  }
  switch (result.kind) {
    case "text":
      return <ChatMarkdown text={result.text} />;
    case "kpi": {
      const change = formatCostCanvasChange(result.kpi?.changePercent);
      const up = (result.kpi?.changePercent ?? 0) > 0;
      return (
        <Card>
          <Muted>{block.kind === "kpi" ? block.title : ""}</Muted>
          <Text style={{ color: colors.text, fontSize: 20, fontWeight: "600" }}>
            {formatCostCanvasKpi(result.kpi)}
          </Text>
          {change ? (
            <Text style={{ color: up ? colors.danger : colors.success, fontSize: 12 }}>
              {change} vs previous period
            </Text>
          ) : null}
          {result.kpi?.note ? <Muted>{result.kpi.note}</Muted> : null}
        </Card>
      );
    }
    case "table": {
      if (block.kind !== "table" || !result.table) return null;
      const t = result.table;
      const currency = t.currency ?? "USD";
      // A phone shows the newest buckets; the totals column always survives.
      const cols = t.columns[0] === "total" ? [] : t.columns.slice(compact ? -2 : -3);
      const offset = t.columns.length - cols.length;
      return (
        <Card>
          <Title>{block.title}</Title>
          <Muted>
            {t.from} to {t.to} · by{" "}
            {block.query.groupBy === "tag"
              ? (block.query.groupByTagKey ?? "tag")
              : COST_DIMENSION_LABELS[block.query.groupBy].toLowerCase()}
          </Muted>
          <View style={{ flexDirection: "row", marginTop: spacing.xs }}>
            <Text style={{ flex: 2, color: colors.textFaint, fontSize: 11 }} />
            {cols.map((col) => (
              <Text
                key={col}
                style={{ flex: 1, color: colors.textFaint, fontSize: 11, textAlign: "right" }}
              >
                {formatBucketLabel(
                  col,
                  block.query.binning === "none" ? "monthly" : block.query.binning,
                )}
              </Text>
            ))}
            <Text style={{ flex: 1, color: colors.textFaint, fontSize: 11, textAlign: "right" }}>
              Total
            </Text>
          </View>
          {t.rows.map((row) => (
            <View key={row.key} style={{ flexDirection: "row", paddingVertical: 2 }}>
              <Text style={{ flex: 2, color: colors.text, fontSize: 12 }} numberOfLines={1}>
                {row.key === "__other__" ? "Other" : row.label}
              </Text>
              {cols.map((col, i) => (
                <Text
                  key={col}
                  style={{ flex: 1, color: colors.textMuted, fontSize: 12, textAlign: "right" }}
                >
                  {formatMoney(row.values[i + offset] ?? 0, currency)}
                </Text>
              ))}
              <Text
                style={{
                  flex: 1,
                  color: colors.text,
                  fontSize: 12,
                  textAlign: "right",
                  fontWeight: "600",
                }}
              >
                {formatMoney(row.total, currency)}
              </Text>
            </View>
          ))}
          {t.rows.length === 0 ? <Muted>No spend in this window.</Muted> : null}
        </Card>
      );
    }
    case "budgets":
      return (
        <View style={{ gap: spacing.xs }}>
          <Title>{block.kind === "budgets" ? block.title : ""}</Title>
          {result.budgets.length === 0 ? <Muted>No budgets to show.</Muted> : null}
          {result.budgets.map((b) => (
            <BudgetCard key={b.id} budget={b} />
          ))}
        </View>
      );
    case "anomalies":
      return (
        <Card>
          <Title>{block.kind === "anomalies" ? block.title : ""}</Title>
          {result.withheld ? (
            <Muted>
              Anomalies are detected over all of the organization&rsquo;s spend, so they are not
              shown with a cost visibility scope.
            </Muted>
          ) : result.anomalies.length === 0 ? (
            <Muted>No anomalies in this window.</Muted>
          ) : (
            result.anomalies.map((a) => (
              <View
                key={a.id}
                style={{
                  flexDirection: "row",
                  justifyContent: "space-between",
                  paddingVertical: 2,
                }}
              >
                <Text style={{ color: colors.text, fontSize: 12, flex: 1 }} numberOfLines={1}>
                  {a.day} · {a.dimensionKey}
                </Text>
                <Text style={{ color: colors.text, fontSize: 12 }}>
                  {formatMoney(a.actualCents / 100, a.currency)}
                </Text>
              </View>
            ))
          )}
        </Card>
      );
    case "cost_report":
      return result.report ? (
        <CostGraphCard
          title={(block.kind === "cost_report" && block.title) || result.report.name}
          config={result.report.config}
        />
      ) : null;
    case "custom_graph":
      return (
        <Card>
          <Title>
            {(block.kind === "custom_graph" && block.title) || result.graph?.name || "Custom graph"}
          </Title>
          {result.spec ? <CustomGraphChart spec={result.spec.chart} /> : <Muted>No output.</Muted>}
        </Card>
      );
    case "chart":
      return null;
  }
}

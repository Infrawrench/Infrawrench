import { useState } from "react";
import { Linking, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import Svg, { Polyline, Line as SvgLine, Text as SvgText } from "react-native-svg";
import type {
  ActionNode,
  BadgeNode,
  KeyValueListNode,
  MetricChartNode,
  ResourceStatus,
  SchemaNode,
  SectionNode,
  StatusDotNode,
  TableNode,
  TextNode,
} from "@infrawrench/plugin-base";
import { colors, radii, spacing } from "@/lib/theme";
import { useActionDispatch } from "./ActionDispatchContext";

/**
 * React Native renderer for plugin `SchemaNode` trees — the mobile
 * counterpart of `@infrawrench/ui`'s DOM SchemaRenderer. Schema stays data;
 * every node kind maps to a native view here.
 */

const BADGE_COLORS: Record<BadgeNode["color"], { bg: string; fg: string }> = {
  green: { bg: "#14331f", fg: colors.success },
  yellow: { bg: "#3a2f10", fg: colors.warning },
  red: { bg: "#3a1717", fg: colors.danger },
  blue: { bg: "#152741", fg: "#60a5fa" },
  gray: { bg: colors.surfaceOverlay, fg: colors.textMuted },
};

const STATUS_COLORS: Record<ResourceStatus, string> = {
  healthy: colors.success,
  degraded: colors.warning,
  error: colors.danger,
  unknown: colors.textFaint,
  provisioning: "#60a5fa",
  info: "#60a5fa",
};

export function SchemaNodeView({ node }: { node: SchemaNode }) {
  switch (node.kind) {
    case "text":
      return <TextNodeView node={node} />;
    case "badge":
      return <BadgeView node={node} />;
    case "status-dot":
      return <StatusDotView node={node} />;
    case "key-value-list":
      return <KeyValueListView node={node} />;
    case "action":
      return <ActionView node={node} />;
    case "grid":
      // Phones are narrow: grids collapse to a single column stack.
      return (
        <View style={{ gap: spacing.sm }}>
          {node.items.map((item, i) => (
            <SchemaNodeView key={i} node={item} />
          ))}
        </View>
      );
    case "section":
      return <SectionView node={node} />;
    case "link":
      return (
        <Pressable accessibilityRole="link" onPress={() => void Linking.openURL(node.url)}>
          <Text style={styles.link}>{node.label} ↗</Text>
        </Pressable>
      );
    case "metric-chart":
      return <MetricChartView node={node} />;
    case "table":
      return <TableView node={node} />;
    default:
      return null;
  }
}

function TextNodeView({ node }: { node: TextNode }) {
  const style = [
    styles.text,
    node.variant === "heading" && styles.heading,
    node.variant === "subheading" && styles.subheading,
    node.variant === "mono" && styles.mono,
    node.variant === "muted" && styles.muted,
  ];
  if (!node.copyable) return <Text style={style}>{node.content}</Text>;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Copy ${node.content}`}
      onLongPress={() => void Clipboard.setStringAsync(node.content)}
    >
      <Text style={style}>{node.content}</Text>
    </Pressable>
  );
}

function BadgeView({ node }: { node: BadgeNode }) {
  const c = BADGE_COLORS[node.color] ?? BADGE_COLORS.gray;
  return (
    <View style={[styles.badge, { backgroundColor: c.bg }]}>
      <Text style={{ color: c.fg, fontSize: 12, fontWeight: "600" }}>{node.label}</Text>
    </View>
  );
}

function StatusDotView({ node }: { node: StatusDotNode }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
      <View
        style={{
          width: 8,
          height: 8,
          borderRadius: 4,
          backgroundColor: STATUS_COLORS[node.status] ?? colors.textFaint,
        }}
      />
      {node.label ? <Text style={styles.muted}>{node.label}</Text> : null}
    </View>
  );
}

function KeyValueListView({ node }: { node: KeyValueListNode }) {
  return (
    <View style={{ gap: spacing.xs }}>
      {node.items.map((item, i) => (
        <KeyValueRow key={`${item.key}-${i}`} item={item} />
      ))}
    </View>
  );
}

function KeyValueRow({ item }: { item: KeyValueListNode["items"][number] }) {
  const dispatch = useActionDispatch();
  const secret = typeof item.value === "string" ? null : item.value;
  const display =
    secret === null
      ? (item.value as string)
      : secret.resolution.kind === "output-ref"
        ? `from: ${secret.resolution.sourceResourceId}`
        : "••••••••";

  return (
    <View style={styles.kvRow}>
      <Text style={styles.kvKey} numberOfLines={1}>
        {item.key}
      </Text>
      <Pressable
        style={{ flex: 1 }}
        accessibilityRole={item.copyable || secret ? "button" : "text"}
        // Secrets resolve through the host (resolveFieldValue) and land on
        // the clipboard — the value is never rendered on screen.
        onPress={
          secret
            ? () => dispatch({ type: "copy-to-clipboard", fieldKey: secret.fieldKey })
            : undefined
        }
        onLongPress={
          secret
            ? () => dispatch({ type: "copy-to-clipboard", fieldKey: secret.fieldKey })
            : item.copyable
              ? () => void Clipboard.setStringAsync(item.value as string)
              : undefined
        }
      >
        <Text style={[styles.kvValue, (item.sensitive || secret) && styles.mono]} numberOfLines={2}>
          {display}
        </Text>
        {secret ? <Text style={styles.kvHint}>Tap to copy</Text> : null}
      </Pressable>
    </View>
  );
}

function ActionView({ node }: { node: ActionNode }) {
  const dispatch = useActionDispatch();
  return (
    <Pressable
      accessibilityRole="button"
      onPress={() => dispatch(node.action)}
      style={({ pressed }) => [
        styles.actionButton,
        node.variant === "danger" && styles.actionDanger,
        node.variant === "ghost" && styles.actionGhost,
        pressed && { opacity: 0.7 },
      ]}
    >
      <Text
        style={{
          color: node.variant === "danger" ? "#fff" : colors.textSecondary,
          fontSize: 13,
          fontWeight: "600",
        }}
      >
        {node.label}
      </Text>
    </Pressable>
  );
}

function SectionView({ node }: { node: SectionNode }) {
  const [collapsed, setCollapsed] = useState(false);
  return (
    <View style={styles.section}>
      {node.title ? (
        <Pressable accessibilityRole="button" onPress={() => setCollapsed((c) => !c)}>
          <Text style={styles.sectionTitle}>
            {collapsed ? "▸ " : "▾ "}
            {node.title}
          </Text>
        </Pressable>
      ) : null}
      {!collapsed && (
        <View style={{ gap: spacing.sm }}>
          {node.children.map((child, i) => (
            <SchemaNodeView key={i} node={child} />
          ))}
        </View>
      )}
    </View>
  );
}

const CHART_WIDTH = 320;
const CHART_HEIGHT = 120;
const SERIES_COLORS = ["#60a5fa", "#4ade80", "#fbbf24", "#f87171", "#c084fc"];

function MetricChartView({ node }: { node: MetricChartNode }) {
  const allPoints = node.series.flatMap((s) => s.points);
  if (allPoints.length === 0) {
    return (
      <View style={styles.section}>
        <Text style={styles.subheading}>{node.title}</Text>
        <Text style={styles.muted}>No data</Text>
      </View>
    );
  }
  const minT = Math.min(...allPoints.map((p) => p.timestamp));
  const maxT = Math.max(...allPoints.map((p) => p.timestamp));
  const minV = Math.min(0, ...allPoints.map((p) => p.value));
  const maxV = Math.max(...allPoints.map((p) => p.value)) || 1;
  const x = (t: number) => ((t - minT) / Math.max(1, maxT - minT)) * (CHART_WIDTH - 8) + 4;
  const y = (v: number) =>
    CHART_HEIGHT - 16 - ((v - minV) / Math.max(1e-9, maxV - minV)) * (CHART_HEIGHT - 24);

  return (
    <View style={styles.section}>
      <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
        <Text style={styles.subheading}>{node.title}</Text>
        {node.timeRangeLabel ? <Text style={styles.muted}>{node.timeRangeLabel}</Text> : null}
      </View>
      <Svg width="100%" height={CHART_HEIGHT} viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}>
        <SvgLine
          x1={0}
          y1={CHART_HEIGHT - 16}
          x2={CHART_WIDTH}
          y2={CHART_HEIGHT - 16}
          stroke={colors.border}
          strokeWidth={1}
        />
        {node.series.map((s, i) => (
          <Polyline
            key={s.label}
            points={s.points.map((p) => `${x(p.timestamp)},${y(p.value)}`).join(" ")}
            fill="none"
            stroke={SERIES_COLORS[i % SERIES_COLORS.length] ?? "#60a5fa"}
            strokeWidth={1.5}
          />
        ))}
        <SvgText x={4} y={10} fill={colors.textFaint} fontSize={9}>
          {formatValue(maxV, node.series[0]?.unit)}
        </SvgText>
      </Svg>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.md }}>
        {node.series.map((s, i) => (
          <View key={s.label} style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
            <View
              style={{
                width: 8,
                height: 2,
                backgroundColor: SERIES_COLORS[i % SERIES_COLORS.length],
              }}
            />
            <Text style={styles.muted}>{s.label}</Text>
          </View>
        ))}
      </View>
    </View>
  );
}

function formatValue(v: number, unit?: string): string {
  const rounded = v >= 100 ? Math.round(v).toString() : v.toPrecision(3);
  return unit ? `${rounded} ${unit}` : rounded;
}

function TableView({ node }: { node: TableNode }) {
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator style={{ marginHorizontal: -spacing.sm }}>
      <View>
        <View style={styles.tableHeaderRow}>
          {node.columns.map((col) => (
            <Text key={col.key} style={[styles.tableHeaderCell, columnWidth(col.width)]}>
              {col.label}
            </Text>
          ))}
        </View>
        {node.rows.map((row, ri) => (
          <View key={ri} style={styles.tableRow}>
            {node.columns.map((col, ci) => {
              const cell = row.cells[col.key];
              if (cell && typeof cell !== "string") {
                return (
                  <View key={col.key} style={columnWidth(col.width)}>
                    <ActionView node={cell} />
                  </View>
                );
              }
              return (
                <Text
                  key={col.key}
                  numberOfLines={1}
                  style={[
                    styles.tableCell,
                    columnWidth(col.width),
                    col.mono && styles.mono,
                    ci === 0 &&
                      node.emphasizeFirstColumn && { fontWeight: "600", color: colors.text },
                    ci === 0 && row.depth ? { paddingLeft: 12 * row.depth } : null,
                  ]}
                >
                  {cell ?? ""}
                </Text>
              );
            })}
          </View>
        ))}
      </View>
    </ScrollView>
  );
}

function columnWidth(width?: "auto" | "narrow" | "wide") {
  return { width: width === "narrow" ? 80 : width === "wide" ? 220 : 140 };
}

const styles = StyleSheet.create({
  text: { color: colors.textSecondary, fontSize: 14 },
  heading: { color: colors.text, fontSize: 18, fontWeight: "700" },
  subheading: { color: colors.text, fontSize: 15, fontWeight: "600" },
  mono: { fontFamily: "monospace", fontSize: 12.5 },
  muted: { color: colors.textMuted, fontSize: 12.5 },
  link: { color: colors.accent, fontSize: 14 },
  badge: {
    alignSelf: "flex-start",
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 99,
  },
  kvRow: { flexDirection: "row", gap: spacing.md, alignItems: "flex-start" },
  kvKey: { color: colors.textMuted, fontSize: 13, width: 130 },
  kvValue: { color: colors.textSecondary, fontSize: 13 },
  kvHint: { color: colors.textFaint, fontSize: 11 },
  actionButton: {
    alignSelf: "flex-start",
    borderWidth: 1,
    borderColor: colors.borderStrong,
    borderRadius: radii.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs + 2,
    backgroundColor: colors.surfaceOverlay,
  },
  actionDanger: { backgroundColor: colors.danger, borderColor: colors.danger },
  actionGhost: { backgroundColor: "transparent", borderColor: "transparent" },
  section: {
    gap: spacing.sm,
    paddingVertical: spacing.sm,
  },
  sectionTitle: { color: colors.text, fontSize: 15, fontWeight: "600" },
  tableHeaderRow: {
    flexDirection: "row",
    borderBottomWidth: 1,
    borderBottomColor: colors.borderStrong,
    paddingVertical: 6,
    paddingHorizontal: spacing.sm,
    gap: spacing.sm,
  },
  tableHeaderCell: { color: colors.textMuted, fontSize: 12, fontWeight: "600" },
  tableRow: {
    flexDirection: "row",
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
    paddingVertical: 6,
    paddingHorizontal: spacing.sm,
    gap: spacing.sm,
    alignItems: "center",
  },
  tableCell: { color: colors.textSecondary, fontSize: 12.5 },
});

import { StyleSheet, Text, View } from "react-native";
import { formatUptime, type SyntheticProbe } from "@infrawrench/client-core";
import { Card, EmptyView, ErrorView, LoadingView, Screen } from "@/components/ui";
import { colors, spacing } from "@/lib/theme";
import { useProbes } from "./useProbes";

/**
 * Synthetic probes — the native counterpart of the web/desktop Probes tab and
 * the `infrawrench probes` CLI: every uptime/latency check with its status
 * dot, trailing-24h uptime and last latency.
 *
 * Read-only by design (a deliberate omission, like the billing screens):
 * probes are created and edited on web/desktop, where the endpoint-suggestion
 * picker lives. This screen answers the push notification's question — "is it
 * still down?" — without an editor in the way.
 */
export function ProbesScreen() {
  const probes = useProbes();

  if (probes.isLoading) return <LoadingView />;
  if (probes.isError) {
    return (
      <ErrorView
        message={probes.error instanceof Error ? probes.error.message : "Couldn't load probes."}
        onRetry={() => void probes.refetch()}
      />
    );
  }

  const list = probes.data?.probes ?? [];
  if (list.length === 0) {
    return (
      <EmptyView message="No probes yet. Create one on the web or desktop app — the editor suggests endpoints from your synced resources." />
    );
  }

  return (
    <Screen onRefresh={() => void probes.refetch()} refreshing={probes.isRefetching}>
      <Card list>
        {list.map((probe) => (
          <ProbeRow key={probe.id} probe={probe} />
        ))}
      </Card>
      <Text style={styles.footnote}>
        Checked on an interval from outside your infrastructure, so latency and reachability are
        what your users see. Probes are managed on the web or desktop app.
      </Text>
    </Screen>
  );
}

function statusColor(probe: SyntheticProbe): string {
  if (!probe.enabled) return colors.textFaint;
  switch (probe.status) {
    case "up":
      return colors.success;
    case "down":
      return colors.danger;
    default:
      return colors.warning;
  }
}

function statusLabel(probe: SyntheticProbe): string {
  if (!probe.enabled) return "disabled";
  switch (probe.status) {
    case "up":
      return "up";
    case "down":
      return "down";
    default:
      return "pending";
  }
}

function ProbeRow({ probe }: { probe: SyntheticProbe }) {
  const detail = [
    probe.uptime24h !== null ? `${formatUptime(probe.uptime24h)} uptime (24h)` : null,
    probe.lastLatencyMs !== null ? `${probe.lastLatencyMs}ms` : null,
    probe.status === "down" && probe.lastError ? probe.lastError : null,
  ]
    .filter((part): part is string => part !== null)
    .join(" · ");

  return (
    <View
      accessibilityLabel={`${probe.name}, ${statusLabel(probe)}${detail ? `, ${detail}` : ""}`}
      style={styles.row}
    >
      <View style={[styles.dot, { backgroundColor: statusColor(probe) }]} />
      <View style={styles.rowMain}>
        <Text style={styles.title} numberOfLines={1}>
          {probe.name}
        </Text>
        <Text style={styles.subtitle} numberOfLines={1}>
          {probe.method} {probe.url}
        </Text>
        {detail !== "" && (
          <Text style={styles.detail} numberOfLines={1}>
            {detail}
          </Text>
        )}
      </View>
      <Text style={[styles.status, { color: statusColor(probe) }]}>{statusLabel(probe)}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: spacing.md, paddingVertical: 10 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  rowMain: { flex: 1, gap: 2 },
  title: { color: colors.text, fontSize: 15, fontWeight: "500" },
  subtitle: { color: colors.textMuted, fontSize: 12 },
  detail: { color: colors.textFaint, fontSize: 11 },
  status: { fontSize: 13, fontWeight: "600" },
  footnote: { color: colors.textFaint, fontSize: 11 },
});

import { Linking, Pressable, StyleSheet, Text, View } from "react-native";
import {
  formatUptime,
  statusPagePublicUrl,
  type StatusPage,
  type SyntheticProbe,
} from "@infrawrench/client-core";
import { Card, EmptyView, ErrorView, LoadingView, Screen, SectionTitle } from "@/components/ui";
import { colors, spacing } from "@/lib/theme";
import { CLOUD_URL } from "../../../env";
import { useProbes } from "./useProbes";
import { useStatusPages } from "./useStatusPages";

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
  const statusPages = useStatusPages();

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

  // A status page failing to load must not take the probe list with it: the
  // probes are what the push notification sent you here for.
  const pages = statusPages.data?.pages ?? [];

  return (
    <Screen
      onRefresh={() => {
        void probes.refetch();
        void statusPages.refetch();
      }}
      refreshing={probes.isRefetching}
    >
      <Card list>
        {list.map((probe) => (
          <ProbeRow key={probe.id} probe={probe} />
        ))}
      </Card>
      <Text style={styles.footnote}>
        Checked on an interval from outside your infrastructure, so latency and reachability are
        what your users see. Probes are managed on the web or desktop app.
      </Text>

      {pages.length > 0 && (
        <>
          <SectionTitle>Status pages</SectionTitle>
          <Card list>
            {pages.map((page) => (
              <StatusPageRow key={page.id} page={page} />
            ))}
          </Card>
          <Text style={styles.footnote}>
            A live page is readable by anyone with its link. Pages are created and published on the
            web or desktop app.
          </Text>
        </>
      )}
    </Screen>
  );
}

/**
 * One status page, read-only: what it is called, whether it is live, and a tap
 * to open it in the browser. Publishing stays on web/desktop — the deliberate
 * omission this screen already makes for probes.
 */
function StatusPageRow({ page }: { page: StatusPage }) {
  // Prefer an active vanity hostname; otherwise the secret slug on CLOUD_URL.
  const url = statusPagePublicUrl(CLOUD_URL, page);
  const live = page.published;
  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={`${page.title}, ${live ? "live" : "draft"}`}
      onPress={() => void Linking.openURL(url)}
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
    >
      <View style={[styles.dot, { backgroundColor: live ? colors.success : colors.textFaint }]} />
      <View style={styles.rowMain}>
        <Text style={styles.title} numberOfLines={1}>
          {page.title}
        </Text>
        <Text style={styles.subtitle} numberOfLines={1}>
          {page.components.length} component{page.components.length === 1 ? "" : "s"}
          {page.customHostname && page.customHostnameStatus === "active"
            ? ` · ${page.customHostname}`
            : ""}
        </Text>
      </View>
      <Text style={[styles.status, { color: live ? colors.success : colors.textFaint }]}>
        {live ? "live" : "draft"}
      </Text>
    </Pressable>
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
  rowPressed: { backgroundColor: colors.surfaceOverlay },
  dot: { width: 8, height: 8, borderRadius: 4 },
  rowMain: { flex: 1, gap: 2 },
  title: { color: colors.text, fontSize: 15, fontWeight: "500" },
  subtitle: { color: colors.textMuted, fontSize: 12 },
  detail: { color: colors.textFaint, fontSize: 11 },
  status: { fontSize: 13, fontWeight: "600" },
  footnote: { color: colors.textFaint, fontSize: 11 },
});

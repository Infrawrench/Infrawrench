import { Linking, Pressable, StyleSheet, Text, View } from "react-native";
import {
  describeHeartbeatSchedule,
  formatUptime,
  heartbeatScheduleOf,
  statusPageUrl,
  type Heartbeat,
  type StatusPage,
  type SyntheticProbe,
} from "@infrawrench/client-core";
import { Card, EmptyView, ErrorView, LoadingView, Screen, SectionTitle } from "@/components/ui";
import { colors, spacing } from "@/lib/theme";
import { CLOUD_URL } from "../../../env";
import { IssueIndicator } from "@/components/IssueIndicator";
import { useProbes } from "./useProbes";
import { useStatusPages } from "./useStatusPages";
import { useHeartbeats } from "./useHeartbeats";

/**
 * Synthetic probes; the native counterpart of the web/desktop Probes tab and
 * the `infrawrench probes` CLI: every uptime/latency check with its status
 * dot, trailing-24h uptime and last latency.
 *
 * Read-only by design (a deliberate omission, like the billing screens):
 * probes are created and edited on web/desktop, where the endpoint-suggestion
 * picker lives. This screen answers the push notification's question ("is it
 * still down?") without an editor in the way.
 */
export function ProbesScreen() {
  const probes = useProbes();
  const statusPages = useStatusPages();
  const heartbeats = useHeartbeats();

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
  // Like status pages, heartbeats failing to load must not take the probes
  // with them.
  const beats = heartbeats.data?.heartbeats ?? [];
  if (list.length === 0 && beats.length === 0) {
    return (
      <EmptyView message="No probes or heartbeats yet. Create them on the web or desktop app; the editors suggest endpoints and schedules from your synced resources." />
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
        void heartbeats.refetch();
      }}
      refreshing={probes.isRefetching}
    >
      {list.length > 0 && (
        <>
          <Card list>
            {list.map((probe) => (
              <ProbeRow key={probe.id} probe={probe} />
            ))}
          </Card>
          <Text style={styles.footnote}>
            Checked on an interval from outside your infrastructure, so latency and reachability are
            what your users see. Probes are managed on the web or desktop app.
          </Text>
        </>
      )}

      {beats.length > 0 && (
        <>
          <SectionTitle>Heartbeats</SectionTitle>
          <Card list>
            {beats.map((heartbeat) => (
              <HeartbeatRow key={heartbeat.id} heartbeat={heartbeat} />
            ))}
          </Card>
          <Text style={styles.footnote}>
            Scheduled jobs that ping in when they run. Heartbeats are managed on the web or desktop
            app.
          </Text>
        </>
      )}

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
 * to open it in the browser. Publishing stays on web/desktop: the deliberate
 * omission this screen already makes for probes.
 */
function StatusPageRow({ page }: { page: StatusPage }) {
  // The public page is served by the same app the API is on, which is what
  // CLOUD_URL points at.
  const url = statusPageUrl(CLOUD_URL, page.slug);
  const live = page.published;
  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={`${page.title}, ${live ? "live" : "draft"}`}
      onPress={() => void Linking.openURL(url)}
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
    >
      <View style={styles.rowMain}>
        <Text style={styles.title} numberOfLines={1}>
          {page.title}
        </Text>
        <Text style={styles.subtitle} numberOfLines={1}>
          {page.components.length} component{page.components.length === 1 ? "" : "s"}
        </Text>
      </View>
      <Text style={[styles.status, { color: live ? colors.success : colors.textFaint }]}>
        {live ? "live" : "draft"}
      </Text>
    </Pressable>
  );
}

function heartbeatLabel(heartbeat: Heartbeat): string {
  if (!heartbeat.enabled) return "paused";
  if (heartbeat.status === "down") return heartbeat.downReason === "failed" ? "failed" : "missed";
  return heartbeat.status === "up" ? "up" : "new";
}

function heartbeatColor(heartbeat: Heartbeat): string {
  if (!heartbeat.enabled) return colors.textFaint;
  if (heartbeat.status === "down") return colors.danger;
  return heartbeat.status === "up" ? colors.success : colors.warning;
}

/** One heartbeat, read-only: its schedule, last ping and state. */
function HeartbeatRow({ heartbeat }: { heartbeat: Heartbeat }) {
  const schedule = heartbeatScheduleOf(heartbeat);
  const detail = [
    schedule ? describeHeartbeatSchedule(schedule) : null,
    heartbeat.lastPingAt
      ? `last ping ${new Date(heartbeat.lastPingAt).toLocaleString()}`
      : "never pinged",
  ]
    .filter((part): part is string => part !== null)
    .join(" · ");
  const label = heartbeatLabel(heartbeat);
  return (
    <View accessibilityLabel={`${heartbeat.name}, ${label}, ${detail}`} style={styles.row}>
      {heartbeat.enabled && heartbeat.status === "down" && (
        <IssueIndicator tone="danger" reason={label} />
      )}
      <View style={styles.rowMain}>
        <Text style={styles.title} numberOfLines={1}>
          {heartbeat.name}
        </Text>
        <Text style={styles.subtitle} numberOfLines={1}>
          {detail}
        </Text>
      </View>
      <Text style={[styles.status, { color: heartbeatColor(heartbeat) }]}>{label}</Text>
    </View>
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
      {probe.enabled && probe.status === "down" && (
        <IssueIndicator tone="danger" reason={probe.lastError ?? "Down"} />
      )}
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
  rowMain: { flex: 1, gap: 2 },
  title: { color: colors.text, fontSize: 15, fontWeight: "500" },
  subtitle: { color: colors.textMuted, fontSize: 12 },
  detail: { color: colors.textFaint, fontSize: 11 },
  status: { fontSize: 13, fontWeight: "600" },
  footnote: { color: colors.textFaint, fontSize: 11 },
});

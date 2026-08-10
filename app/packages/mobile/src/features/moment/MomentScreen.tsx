import { useState } from "react";
import { Linking, Pressable, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import {
  buildMomentTimeline,
  describeIncidentBadge,
  DEFAULT_MOMENT_WINDOW_MINUTES,
  MOMENT_FEED_LABELS,
  MOMENT_WINDOW_PRESETS,
  type MomentEvent,
  type MomentIncidentSpan,
  type MomentSeverity,
} from "@infrawrench/client-core";
import { useOrgApi } from "@/lib/auth/AuthProvider";
import { Card, EmptyView, ErrorView, LoadingView, Screen } from "@/components/ui";
import { Chip, ChipRow } from "@/components/form";
import { colors, radii, spacing } from "@/lib/theme";
import { useMoment } from "./useMoment";

/**
 * The moment view — "what changed around 03:14?". The native counterpart of
 * `@infrawrench/ui`'s `MomentPanel` (web and desktop): the wire contract and
 * the merge/badge/grouping logic all come from `@infrawrench/client-core`, so
 * only the markup is written twice.
 *
 * Opened from the Changes screen ("Investigate a moment") for "around now",
 * or deep-linked with `at` + `window` — which is how anomaly, drift and
 * provider-incident pushes land here. There is deliberately no timestamp
 * keyboard on a phone: the timestamp comes from the link (or is "now"), and
 * the window presets do the zooming.
 */

const SEVERITY_COLORS: Record<MomentSeverity, string> = {
  info: colors.textFaint,
  warning: colors.warning,
  critical: colors.danger,
};

export interface MomentScreenProps {
  /** ISO centre timestamp from a deep link; absent = around now. */
  at?: string | undefined;
  /** Half-window in minutes from a deep link. */
  window?: string | undefined;
}

export function MomentScreen({ at: atParam, window: windowParam }: MomentScreenProps) {
  const router = useRouter();
  const { orgId } = useOrgApi();

  const at = atParam && !Number.isNaN(Date.parse(atParam)) ? atParam : undefined;
  const initialWindow = Number.parseInt(windowParam ?? "", 10);
  const [windowMinutes, setWindowMinutes] = useState(
    Number.isFinite(initialWindow) && initialWindow > 0
      ? initialWindow
      : DEFAULT_MOMENT_WINDOW_MINUTES,
  );
  const [expandedBurst, setExpandedBurst] = useState<string | null>(null);

  const moment = useMoment(at, windowMinutes);

  const openEvent = (event: MomentEvent) => {
    const link = event.link;
    if (!link) return;
    if (link.url) {
      void Linking.openURL(link.url);
      return;
    }
    const enc = encodeURIComponent;
    switch (link.kind) {
      case "resource":
        if (event.pluginId && event.resourceTypeId && event.resourceId && event.accountId) {
          router.push(
            `/org/${orgId}/resources/${enc(event.pluginId)}/${enc(event.resourceTypeId)}/${enc(event.resourceId)}?accountId=${enc(event.accountId)}`,
          );
        }
        break;
      case "workflow-run":
        if (link.parentId) router.push(`/org/${orgId}/workflows/${enc(link.parentId)}`);
        break;
      case "deployment":
        router.push(`/org/${orgId}/deployments`);
        break;
      case "costs":
        router.push(`/org/${orgId}/costs`);
        break;
      case "expiring":
        router.push(`/org/${orgId}/expiring`);
        break;
      case "changes":
      case "incident":
        router.push(`/org/${orgId}/changes`);
        break;
      // No audit-log or change-freeze screens on mobile — those events stay
      // in the timeline without navigation.
      default:
        break;
    }
  };

  if (moment.isLoading) return <LoadingView />;
  if (moment.isError || !moment.data) {
    return (
      <ErrorView
        message={moment.error instanceof Error ? moment.error.message : "Couldn't load the moment."}
        onRetry={() => void moment.refetch()}
      />
    );
  }

  const data = moment.data;
  const unhealthyFeeds = data.feeds.filter((feed) => feed.status !== "ok" || feed.truncated);
  const timeline = buildMomentTimeline(data.events, data.incidents);
  const crossesDays = new Date(data.from).toDateString() !== new Date(data.to).toDateString();
  const formatTime = (iso: string) => {
    const date = new Date(iso);
    return crossesDays ? date.toLocaleString() : date.toLocaleTimeString();
  };
  const spansById = (ids: string[]): MomentIncidentSpan[] =>
    data.incidents.filter((span) => ids.includes(span.id));

  return (
    <Screen onRefresh={() => void moment.refetch()} refreshing={moment.isRefetching}>
      <Text style={styles.subtitle}>
        {at
          ? `Around ${new Date(at).toLocaleString()}`
          : "Around now — pull to refresh to recentre"}
      </Text>

      <ChipRow>
        {MOMENT_WINDOW_PRESETS.map((preset) => (
          <Chip
            key={preset.minutes}
            label={preset.label}
            selected={windowMinutes === preset.minutes}
            onPress={() => setWindowMinutes(preset.minutes)}
          />
        ))}
      </ChipRow>

      {unhealthyFeeds.length > 0 && (
        <View style={styles.feedNotices}>
          {unhealthyFeeds.map((feed) => (
            <Text key={feed.feed} style={styles.feedNotice}>
              {MOMENT_FEED_LABELS[feed.feed] ?? feed.feed}{" "}
              {feed.status === "error"
                ? "unavailable"
                : feed.status === "omitted"
                  ? "omitted (no permission)"
                  : "truncated"}
            </Text>
          ))}
        </View>
      )}

      {data.incidents.length > 0 && (
        <View style={styles.incidentBox}>
          <Text style={styles.incidentHeading}>
            Provider incident{data.incidents.length === 1 ? "" : "s"} overlapping this window
          </Text>
          {data.incidents.map((incident) => (
            <Pressable
              key={incident.id}
              disabled={!incident.url}
              onPress={() => incident.url && void Linking.openURL(incident.url)}
            >
              <Text style={styles.incidentLine} numberOfLines={1}>
                {incident.pluginName}: {incident.title}
                {!incident.resolvedAt ? "  (active)" : ""}
              </Text>
            </Pressable>
          ))}
        </View>
      )}

      {timeline.length === 0 ? (
        <EmptyView message="Nothing recorded in this window. Try a wider one." />
      ) : (
        <Card list>
          {timeline.map((item) =>
            item.kind === "event" ? (
              <MomentEventRow
                key={item.key}
                event={item.event}
                badge={describeIncidentBadge(spansById(item.incidentIds))}
                time={formatTime(item.event.timestamp)}
                onPress={item.event.link ? () => openEvent(item.event) : undefined}
              />
            ) : (
              <View key={item.key}>
                <Pressable
                  style={styles.row}
                  onPress={() => setExpandedBurst(expandedBurst === item.key ? null : item.key)}
                >
                  <Text style={styles.time}>{formatTime(item.events[0]?.timestamp ?? "")}</Text>
                  <View style={[styles.dot, { backgroundColor: colors.textFaint }]} />
                  <View style={styles.body}>
                    <Text style={styles.title} numberOfLines={1}>
                      {item.events.length} events on {item.resourceName ?? item.resourceId}
                    </Text>
                    {describeIncidentBadge(spansById(item.incidentIds)) && (
                      <Text style={styles.badge}>
                        {describeIncidentBadge(spansById(item.incidentIds))}
                      </Text>
                    )}
                  </View>
                  <Text style={styles.expand}>{expandedBurst === item.key ? "−" : "+"}</Text>
                </Pressable>
                {expandedBurst === item.key &&
                  item.events.map((event) => (
                    <View key={event.id} style={styles.burstMember}>
                      <MomentEventRow
                        event={event}
                        badge={null}
                        time={formatTime(event.timestamp)}
                        onPress={event.link ? () => openEvent(event) : undefined}
                      />
                    </View>
                  ))}
              </View>
            ),
          )}
        </Card>
      )}

      <Text style={styles.footer}>
        {new Date(data.from).toLocaleString()} — {new Date(data.to).toLocaleString()} ·{" "}
        {data.events.length} event{data.events.length === 1 ? "" : "s"}
      </Text>
    </Screen>
  );
}

function MomentEventRow({
  event,
  badge,
  time,
  onPress,
}: {
  event: MomentEvent;
  badge: string | null;
  time: string;
  onPress?: (() => void) | undefined;
}) {
  return (
    <Pressable style={styles.row} onPress={onPress} disabled={!onPress}>
      <Text style={styles.time}>{time}</Text>
      <View
        style={[
          styles.dot,
          { backgroundColor: SEVERITY_COLORS[event.severity] ?? colors.textFaint },
        ]}
      />
      <View style={styles.body}>
        <Text style={styles.feed}>{MOMENT_FEED_LABELS[event.feed] ?? event.feed}</Text>
        <Text style={styles.title} numberOfLines={2}>
          {event.title}
        </Text>
        {event.detail ? (
          <Text style={styles.detail} numberOfLines={2}>
            {event.detail}
          </Text>
        ) : null}
        {badge ? <Text style={styles.badge}>{badge}</Text> : null}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  subtitle: { color: colors.textSecondary, fontSize: 13 },
  feedNotices: { gap: 2 },
  feedNotice: { color: colors.textMuted, fontSize: 12 },
  incidentBox: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.warning,
    borderRadius: radii.md,
    padding: spacing.md,
    gap: spacing.xs,
  },
  incidentHeading: { color: colors.textMuted, fontSize: 12 },
  incidentLine: { color: colors.text, fontSize: 13 },
  row: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: spacing.sm,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
  },
  burstMember: { paddingLeft: spacing.lg },
  time: { color: colors.textMuted, fontSize: 11, width: 76, textAlign: "right", marginTop: 2 },
  dot: { width: 8, height: 8, borderRadius: 4, marginTop: 4 },
  body: { flex: 1, gap: 1 },
  feed: { color: colors.textFaint, fontSize: 11 },
  title: { color: colors.text, fontSize: 14 },
  detail: { color: colors.textSecondary, fontSize: 12 },
  badge: { color: colors.warning, fontSize: 11 },
  expand: { color: colors.textMuted, fontSize: 16 },
  footer: { color: colors.textFaint, fontSize: 11, textAlign: "center" },
});

import { Alert, StyleSheet, Text, View } from "react-native";
import { formatGameDayDuration, gameDayAbortable } from "@infrawrench/client-core";
import { Button, Card, ErrorView, LoadingView, Screen, SectionTitle } from "@/components/ui";
import { colors, spacing } from "@/lib/theme";
import {
  formatInstant,
  gameDayDetectorLabel,
  gameDayStatusColor,
  gameDayStatusLabel,
  gameDayTargetStateLabel,
} from "./format";
import { useAbortGameDay, useGameDayDetail } from "./useGameDays";

/**
 * One game day: the report (time to detect, page, acknowledge and recover,
 * and which detectors fired), the targets and the alerts sent while it ran.
 * The abort button is always there while the failure may be in effect; it is
 * the one control the phone has, because stopping an experiment only ever
 * puts things back.
 */
export function GameDayDetailScreen({ gameDayId }: { gameDayId: string }) {
  const detail = useGameDayDetail(gameDayId);
  const abort = useAbortGameDay(gameDayId);

  if (detail.isLoading) return <LoadingView />;
  if (detail.isError || !detail.data) {
    return (
      <ErrorView
        message={
          detail.error instanceof Error ? detail.error.message : "Couldn't load the game day."
        }
        onRetry={() => void detail.refetch()}
      />
    );
  }
  const { gameDay: g, report, alerts } = detail.data;

  const confirmAbort = () => {
    Alert.alert(
      "Abort this game day?",
      g.status === "armed"
        ? "It will be cancelled before it starts."
        : "The failure is undone now, before its time limit.",
      [
        { text: "Keep running", style: "cancel" },
        {
          text: "Abort",
          style: "destructive",
          onPress: () => {
            abort.mutate(undefined, {
              onSuccess: () => void detail.refetch(),
              onError: (e) =>
                Alert.alert("Couldn't abort", e instanceof Error ? e.message : String(e)),
            });
          },
        },
      ],
    );
  };

  const tiles: { label: string; value: number | null }[] = [
    { label: "Time to detect", value: report.timeToDetectMs },
    { label: "Time to page", value: report.timeToPageMs },
    { label: "Time to acknowledge", value: report.timeToAcknowledgeMs },
    { label: "Time to recover", value: report.timeToRecoverMs },
  ];

  return (
    <Screen onRefresh={() => void detail.refetch()} refreshing={detail.isRefetching}>
      <View style={styles.header}>
        <Text style={styles.name}>{g.name}</Text>
        <Text style={[styles.status, { color: gameDayStatusColor(g.status) }]}>
          {gameDayStatusLabel(g.status)}
        </Text>
        {g.description ? <Text style={styles.body}>{g.description}</Text> : null}
      </View>

      {gameDayAbortable(g.status) && (
        <View style={styles.abort}>
          <Text style={styles.body}>
            {g.status === "armed"
              ? `Starts ${formatInstant(g.startsAt)}`
              : g.status === "running" && g.endsAt
                ? `Undone automatically at ${formatInstant(g.endsAt)}`
                : gameDayStatusLabel(g.status)}
          </Text>
          <Button
            label={abort.isPending ? "Aborting..." : "Abort"}
            variant="danger"
            disabled={abort.isPending}
            onPress={confirmAbort}
          />
        </View>
      )}
      {g.lastError && <Text style={styles.warning}>{g.lastError}</Text>}

      {report.state !== "not_run" && (
        <>
          <Card>
            {tiles.map((t) => (
              <Stat
                key={t.label}
                label={t.label}
                value={t.value === null ? "Not measured" : formatGameDayDuration(t.value)}
              />
            ))}
          </Card>
          <SectionTitle>Detectors</SectionTitle>
          <Card>
            {report.detectors.map((row) => (
              <View key={row.detector} style={styles.stat}>
                <Text style={styles.statLabel}>{gameDayDetectorLabel(row.detector)}</Text>
                {row.at ? (
                  <Text style={[styles.statValue, { color: colors.success }]}>
                    {row.afterMs === null
                      ? formatInstant(row.at)
                      : formatGameDayDuration(row.afterMs)}
                  </Text>
                ) : row.measurable ? (
                  <Text style={[styles.statValue, { color: colors.danger }]}>Did not fire</Text>
                ) : (
                  <Text style={[styles.statValue, { color: colors.textFaint }]}>Not set up</Text>
                )}
              </View>
            ))}
          </Card>
        </>
      )}

      <SectionTitle>Targets</SectionTitle>
      <Card>
        {g.targets.map((t) => (
          <View key={t.id} style={styles.target}>
            <Text style={styles.statValue}>{t.displayName}</Text>
            <Text style={styles.subtitle}>
              {t.actionLabel} · {gameDayTargetStateLabel(t.state)}
              {t.stateBefore ? ` · was ${t.stateBefore}` : ""}
            </Text>
            {t.lastError ? <Text style={styles.warning}>{t.lastError}</Text> : null}
          </View>
        ))}
      </Card>

      <SectionTitle>Timeline</SectionTitle>
      <Card>
        <Stat label="Scheduled" value={formatInstant(g.startsAt)} />
        <Stat label="Armed" value={formatInstant(g.armedAt)} />
        <Stat label="Injected" value={formatInstant(g.injectedAt)} />
        <Stat label="Undone" value={formatInstant(g.undoneAt)} />
        <Stat label="Recovered" value={formatInstant(g.recoveredAt)} />
      </Card>

      {alerts.length > 0 && (
        <>
          <SectionTitle>Alerts during the game day</SectionTitle>
          <Card>
            {alerts.map((a) => (
              <View key={a.id} style={styles.target}>
                <Text style={a.related ? styles.statValue : styles.faint}>{a.title}</Text>
                <Text style={styles.subtitle}>
                  {formatInstant(a.at)}
                  {a.paged ? " · paged" : ""}
                  {a.unrouted ? " · no rule sent it anywhere" : ""}
                  {a.related ? "" : " · unrelated"}
                </Text>
              </View>
            ))}
          </Card>
        </>
      )}
    </Screen>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.stat}>
      <Text style={styles.statLabel}>{label}</Text>
      <Text style={styles.statValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  header: { gap: 4 },
  name: { color: colors.text, fontSize: 18, fontWeight: "600" },
  subtitle: { color: colors.textMuted, fontSize: 12 },
  status: { fontSize: 13, fontWeight: "600" },
  body: { color: colors.textMuted, fontSize: 13 },
  faint: { color: colors.textFaint, fontSize: 13 },
  warning: { color: colors.warning, fontSize: 13 },
  abort: {
    gap: spacing.sm,
    padding: spacing.md,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.danger,
  },
  stat: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 6 },
  statLabel: { color: colors.textMuted, fontSize: 13 },
  statValue: { color: colors.text, fontSize: 13, fontWeight: "500" },
  target: { paddingVertical: 6, gap: 2 },
});

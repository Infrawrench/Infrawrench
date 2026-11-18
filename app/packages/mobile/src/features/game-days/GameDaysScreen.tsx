import { Pressable, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import {
  computeGameDayReport,
  formatGameDayDuration,
  type GameDay,
} from "@infrawrench/client-core";
import { Card, EmptyView, ErrorView, LoadingView, Screen } from "@/components/ui";
import { IssueIndicator } from "@/components/IssueIndicator";
import { useOrgApi } from "@/lib/auth/AuthProvider";
import { colors, spacing } from "@/lib/theme";
import { formatInstant, gameDayStatusColor, gameDayStatusLabel } from "./format";
import { useGameDays } from "./useGameDays";

/**
 * Game days; the native counterpart of the web/desktop Game days tab and the
 * `infrawrench gamedays` CLI. Read-only apart from the abort button on the
 * detail screen: planning and arming stay on web/desktop, where the target
 * pickers, the dry run and the blast radius are.
 */
export function GameDaysScreen() {
  const gameDays = useGameDays();

  if (gameDays.isLoading) return <LoadingView />;
  if (gameDays.isError) {
    return (
      <ErrorView
        message={
          gameDays.error instanceof Error ? gameDays.error.message : "Couldn't load game days."
        }
        onRetry={() => void gameDays.refetch()}
      />
    );
  }

  const list = gameDays.data?.gameDays ?? [];
  if (list.length === 0) {
    return <EmptyView message="No game days yet. Plan one on the web or desktop app." />;
  }

  return (
    <Screen onRefresh={() => void gameDays.refetch()} refreshing={gameDays.isRefetching}>
      <Card list>
        {list.map((g) => (
          <GameDayRow key={g.id} gameDay={g} />
        ))}
      </Card>
    </Screen>
  );
}

function GameDayRow({ gameDay }: { gameDay: GameDay }) {
  const router = useRouter();
  const { orgId } = useOrgApi();
  const report = computeGameDayReport(gameDay);
  const status = gameDayStatusLabel(gameDay.status);
  const detection =
    report.state === "not_run"
      ? null
      : report.timeToDetectMs === null
        ? "Not detected"
        : `Detected in ${formatGameDayDuration(report.timeToDetectMs)}`;
  const live =
    gameDay.status === "running" ||
    gameDay.status === "injecting" ||
    gameDay.status === "reverting" ||
    gameDay.status === "undo_failed";
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${gameDay.name}, ${status}${detection ? `, ${detection}` : ""}`}
      onPress={() => router.push(`/org/${orgId}/game-days/${gameDay.id}`)}
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
    >
      {live && <IssueIndicator tone="danger" reason={status} />}
      <View style={styles.rowMain}>
        <Text style={styles.title} numberOfLines={1}>
          {gameDay.name}
        </Text>
        <Text style={styles.subtitle} numberOfLines={1}>
          {formatInstant(gameDay.injectedAt ?? gameDay.startsAt)}
          {gameDay.serviceName ? ` · ${gameDay.serviceName}` : ""}
        </Text>
        {detection && (
          <Text style={styles.detail} numberOfLines={1}>
            {detection}
          </Text>
        )}
      </View>
      <Text style={[styles.status, { color: gameDayStatusColor(gameDay.status) }]}>{status}</Text>
    </Pressable>
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
});

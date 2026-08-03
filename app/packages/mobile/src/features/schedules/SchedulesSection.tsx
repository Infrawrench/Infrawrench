import { Pressable, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { formatDaysOfWeek, formatMoney, type SleepSchedule } from "@infrawrench/client-core";
import { Card, SectionTitle } from "@/components/ui";
import { useOrgApi } from "@/lib/auth/AuthProvider";
import { colors, spacing } from "@/lib/theme";
import { useSchedulePause, useSchedules } from "./useSchedules";

/**
 * "Sleep schedules" — the native counterpart to the section on the web and
 * desktop Costs panels, in the same position. Read-mostly by design: the
 * phone shows every schedule with its window, next transition, last outcome
 * and projected saving, and offers only the pause/resume toggle — the
 * "stop touching my resource" control someone reaches for on the move.
 * Creating and editing (day pickers, times, timezones) stays on web/desktop,
 * the anomaly-tuning line.
 */
export function SchedulesSection() {
  const router = useRouter();
  const { orgId } = useOrgApi();
  const schedules = useSchedules();
  const pause = useSchedulePause();
  const rows = schedules.data?.schedules ?? [];

  function openResource(s: SleepSchedule) {
    router.push(
      `/org/${orgId}/resources/${encodeURIComponent(s.pluginId)}/${encodeURIComponent(
        s.resourceTypeId,
      )}/${encodeURIComponent(s.resourceId)}`,
    );
  }

  return (
    <>
      <SectionTitle>Sleep schedules</SectionTitle>

      {schedules.isError ? (
        <Card>
          <Text style={styles.error}>
            Couldn&apos;t load sleep schedules —{" "}
            {schedules.error instanceof Error ? schedules.error.message : "request failed"}
          </Text>
        </Card>
      ) : schedules.isLoading ? (
        <Card>
          <Text style={styles.muted}>Loading schedules…</Text>
        </Card>
      ) : rows.length === 0 ? (
        <Card>
          <Text style={styles.muted}>
            No schedules yet. Create one from a resource&apos;s Schedule tab on web or desktop to
            stop non-prod resources outside working hours.
          </Text>
        </Card>
      ) : (
        <Card list>
          {rows.map((s) => (
            <Pressable
              key={s.id}
              onPress={() => openResource(s)}
              style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
            >
              <View style={styles.rowMain}>
                <Text style={styles.name} numberOfLines={1}>
                  {s.resourceName}
                </Text>
                <Text style={styles.window} numberOfLines={1}>
                  {formatDaysOfWeek(s.daysOfWeek)} · off {s.stopTime} → on {s.startTime} ·{" "}
                  {s.timezone}
                </Text>
                <Text style={styles.meta} numberOfLines={1}>
                  {s.paused
                    ? "Paused"
                    : s.lastRunStatus === "failed"
                      ? `Last run failed${s.lastRunError ? `: ${s.lastRunError}` : ""}`
                      : s.lastRunStatus === "skipped_freeze"
                        ? "Last transition skipped (change freeze)"
                        : s.projectedMonthlySaving != null && s.currency
                          ? `Saves ~${formatMoney(s.projectedMonthlySaving, s.currency)}/mo`
                          : s.accountName}
                </Text>
              </View>
              <Pressable
                onPress={() => pause.mutate({ scheduleId: s.id, paused: !s.paused })}
                disabled={pause.isPending}
                style={({ pressed }) => [styles.pauseButton, pressed && styles.rowPressed]}
                accessibilityRole="button"
                accessibilityLabel={s.paused ? "Resume schedule" : "Pause schedule"}
              >
                <Text style={styles.pauseLabel}>{s.paused ? "Resume" : "Pause"}</Text>
              </Pressable>
            </Pressable>
          ))}
        </Card>
      )}
    </>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  rowPressed: { opacity: 0.6 },
  rowMain: { flex: 1, gap: 2 },
  name: { color: colors.text, fontSize: 14, fontWeight: "600" },
  window: { color: colors.textSecondary, fontSize: 12 },
  meta: { color: colors.textMuted, fontSize: 12 },
  pauseButton: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    borderRadius: 8,
    paddingHorizontal: spacing.sm,
    paddingVertical: 6,
  },
  pauseLabel: { color: colors.text, fontSize: 12 },
  muted: { color: colors.textSecondary, fontSize: 13, lineHeight: 18 },
  error: { color: colors.danger, fontSize: 13 },
});

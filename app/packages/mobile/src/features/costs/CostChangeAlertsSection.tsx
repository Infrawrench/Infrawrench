import { StyleSheet, Text, View } from "react-native";
import {
  COST_CHANGE_CADENCE_DESCRIPTIONS,
  costAlertEventDeltaLabel,
  formatMoney,
  type CostAlertEvent,
} from "@infrawrench/client-core";
import { Card, SectionTitle } from "@/components/ui";
import { colors, spacing } from "@/lib/theme";
import { useCostAlertEvents, useCostAlerts } from "./useCostAlertEvents";

/**
 * Native counterpart to `CostChangeAlertsSection` on web and desktop —
 * read-only, like budgets here: the section lists the org's change-based
 * cost alerts and their recent firings, and a `cost_change` push deep-links
 * to this tab (`pushDataToPath` routes it to `/org/:orgId/costs`), so the
 * event the notification summarised has to be readable here.
 *
 * The third cost-alert family, kept visually adjacent to Anomalies the way
 * web does: anomalies are unconfigured statistical outliers, change alerts
 * are a configured "moved more than X% (or $Y) vs the prior period" on a
 * chosen scope and cadence. Creating and editing alerts stays on
 * web/desktop, like anomaly tuning.
 */
export function CostChangeAlertsSection() {
  const alerts = useCostAlerts();
  const events = useCostAlertEvents();

  const alertRows = alerts.data ?? [];
  const eventRows = events.data ?? [];

  // Nothing configured and nothing fired: stay out of the way entirely —
  // unlike anomalies (always on), change alerts are opt-in, and a phone is
  // not where anyone will set the first one up.
  if (!alerts.isLoading && !alerts.isError && alertRows.length === 0) return null;

  return (
    <>
      <SectionTitle>Change alerts</SectionTitle>

      {alerts.isError ? (
        <Card>
          <Text style={styles.error}>
            Couldn&apos;t load change alerts —{" "}
            {alerts.error instanceof Error ? alerts.error.message : "request failed"}
          </Text>
        </Card>
      ) : alerts.isLoading ? (
        <Card>
          <Text style={styles.muted}>Loading change alerts…</Text>
        </Card>
      ) : (
        <Card list>
          {alertRows.map((alert) => (
            <View key={alert.id} style={styles.row}>
              <View style={styles.rowMain}>
                <Text style={styles.title} numberOfLines={1}>
                  {alert.name}
                </Text>
                <Text style={styles.subtitle} numberOfLines={2}>
                  {COST_CHANGE_CADENCE_DESCRIPTIONS[alert.cadence]}
                  {alert.thresholdPercent !== null ? ` · ≥ ${alert.thresholdPercent}%` : ""}
                  {alert.thresholdAmountCents !== null
                    ? ` · ≥ ${formatMoney(alert.thresholdAmountCents / 100, "USD")}`
                    : ""}
                  {!alert.enabled ? " · paused" : ""}
                </Text>
              </View>
              <Text style={styles.when}>
                {alert.lastFiredAt ? `Fired ${formatWhen(alert.lastFiredAt)}` : "Never fired"}
              </Text>
            </View>
          ))}
        </Card>
      )}

      {eventRows.length > 0 && (
        <Card list>
          {eventRows.map((event) => (
            <EventRow key={event.id} event={event} />
          ))}
        </Card>
      )}

      {alertRows.length > 0 && (
        <Text style={styles.footnote}>
          Change alerts are managed from the web or desktop app; this list is read-only.
        </Text>
      )}
    </>
  );
}

/** "Aug 9" in UTC — the day the window is about, not the local rendering. */
function formatDay(day: string): string {
  const d = new Date(`${day}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) return day;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
}

function formatWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function EventRow({ event }: { event: CostAlertEvent }) {
  const window =
    event.windowFrom === event.windowTo
      ? formatDay(event.windowTo)
      : `${formatDay(event.windowFrom)}–${formatDay(event.windowTo)}`;
  return (
    <View style={styles.row}>
      <View style={styles.rowMain}>
        <Text style={styles.title} numberOfLines={1}>
          {event.alertName}
          {event.groupKey !== "" ? ` · ${event.groupKey}` : ""}
        </Text>
        <Text style={styles.subtitle} numberOfLines={1}>
          {window} · {formatMoney(event.previousAmountCents / 100, event.currency)} →{" "}
          {formatMoney(event.currentAmountCents / 100, event.currency)}
        </Text>
      </View>
      <Text
        style={[
          styles.delta,
          { color: event.direction === "increase" ? colors.danger : colors.success },
        ]}
      >
        {costAlertEventDeltaLabel(event)}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: spacing.md, paddingVertical: 10 },
  rowMain: { flex: 1, gap: 2 },
  title: { color: colors.text, fontSize: 15, fontWeight: "500", flexShrink: 1 },
  subtitle: { color: colors.textMuted, fontSize: 12 },
  when: { color: colors.textFaint, fontSize: 11 },
  delta: { fontSize: 13, fontWeight: "600" },
  muted: { color: colors.textMuted, fontSize: 13 },
  error: { color: colors.danger, fontSize: 13 },
  footnote: { color: colors.textFaint, fontSize: 11 },
});

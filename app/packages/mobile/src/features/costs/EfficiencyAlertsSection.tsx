import { StyleSheet, Text, View } from "react-native";
import {
  EFFICIENCY_ALERT_KIND_LABELS,
  formatMoney,
  type EfficiencyAlertEvent,
  type EfficiencyAlertKind,
} from "@infrawrench/client-core";
import { Card, SectionTitle } from "@/components/ui";
import { colors, spacing } from "@/lib/theme";
import { useEfficiencyAlerts } from "./useEfficiencyAlerts";

/**
 * Native counterpart to `EfficiencyAlertsSection` on web and desktop —
 * read-only, like every cost section here.
 *
 * The three slow-lane cost alerts share one list because they share one
 * reading habit: a commitment about to lapse, a commitment nobody is using,
 * and a unit cost going the wrong way are all things somebody acts on within
 * the week rather than the hour. All three deep-link here
 * (`pushDataToPath` routes `commitment_expiry`, `commitment_idle` and
 * `unit_cost_regression` to `/org/:orgId/costs`), so what the notification
 * summarised has to be readable on this screen.
 */
export function EfficiencyAlertsSection() {
  const alerts = useEfficiencyAlerts();
  const rows = alerts.data ?? [];

  // Nothing has fired: stay out of the way entirely. An org with no
  // commitments and no business metrics can never produce one of these, and
  // an empty card explaining that is furniture on a phone.
  if (!alerts.isLoading && !alerts.isError && rows.length === 0) return null;

  return (
    <>
      <SectionTitle>Commitment &amp; unit-cost alerts</SectionTitle>

      {alerts.isError ? (
        <Card>
          <Text style={styles.error}>
            Couldn&apos;t load efficiency alerts —{" "}
            {alerts.error instanceof Error ? alerts.error.message : "request failed"}
          </Text>
        </Card>
      ) : alerts.isLoading ? (
        <Card>
          <Text style={styles.muted}>Loading efficiency alerts…</Text>
        </Card>
      ) : (
        <Card list>
          {rows.map((event) => (
            <EventRow key={event.id} event={event} />
          ))}
        </Card>
      )}

      {rows.length > 0 && (
        <Text style={styles.footnote}>
          Thresholds are managed from the web or desktop app; this list is read-only.
        </Text>
      )}
    </>
  );
}

const KIND_TONE: Record<EfficiencyAlertKind, string> = {
  commitment_expiry: colors.warning,
  commitment_idle: colors.textMuted,
  unit_cost_regression: colors.danger,
};

function formatWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** The one-line "what it said", per kind. Mirrors the web section's version. */
function describe(event: EfficiencyAlertEvent): string {
  const d = event.detail;
  const currency = event.currency ?? "USD";
  switch (event.kind) {
    case "commitment_expiry": {
      const horizon = typeof d["horizonDays"] === "number" ? d["horizonDays"] : null;
      const end = typeof d["termEndDay"] === "string" ? d["termEndDay"] : "";
      const when = horizon === 0 ? `expired ${end}` : `ends ${end}`;
      return event.amount !== null
        ? `${when} · ≥ ${formatMoney(event.amount, currency)}/mo reverts to on-demand`
        : when;
    }
    case "commitment_idle": {
      const percent = typeof d["utilizationPercent"] === "number" ? d["utilizationPercent"] : null;
      return event.amount !== null
        ? `${percent ?? "?"}% used · ${formatMoney(event.amount, currency)} unused`
        : `${percent ?? "?"}% used`;
    }
    case "unit_cost_regression": {
      const percent = typeof d["changePercent"] === "number" ? d["changePercent"] : null;
      const unit = typeof d["unit"] === "string" && d["unit"] ? d["unit"] : "unit";
      return `cost per ${unit} up ${percent ?? "?"}%`;
    }
    default:
      return "";
  }
}

function EventRow({ event }: { event: EfficiencyAlertEvent }) {
  return (
    <View style={styles.row}>
      <View style={styles.rowMain}>
        <Text style={[styles.kind, { color: KIND_TONE[event.kind] ?? colors.textMuted }]}>
          {EFFICIENCY_ALERT_KIND_LABELS[event.kind]}
        </Text>
        <Text style={styles.title} numberOfLines={1}>
          {event.subject}
          {event.accountName ? ` · ${event.accountName}` : ""}
        </Text>
        <Text style={styles.subtitle} numberOfLines={2}>
          {describe(event)}
        </Text>
      </View>
      <Text style={styles.when}>{formatWhen(event.firedAt)}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "flex-start", gap: spacing.md, paddingVertical: 10 },
  rowMain: { flex: 1, gap: 2 },
  kind: { fontSize: 11, fontWeight: "600" },
  title: { color: colors.text, fontSize: 15, fontWeight: "500", flexShrink: 1 },
  subtitle: { color: colors.textMuted, fontSize: 12 },
  when: { color: colors.textFaint, fontSize: 11 },
  muted: { color: colors.textMuted, fontSize: 13 },
  error: { color: colors.danger, fontSize: 13 },
  footnote: { color: colors.textFaint, fontSize: 11 },
});

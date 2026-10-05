import { StyleSheet, Text, View } from "react-native";
import {
  formatMoney,
  REALIZED_SAVINGS_BASIS_LABELS,
  SAVINGS_EVENT_KIND_LABELS,
  type SavingsEventResult,
} from "@infrawrench/client-core";
import { Card, SectionTitle } from "@/components/ui";
import { colors, spacing } from "@/lib/theme";
import { useRealizedSavings } from "./useRealizedSavings";

/** Rows shown on a phone; the full list lives on web, desktop and the CLI. */
const MAX_ROWS = 15;

/**
 * Realized savings: the native counterpart to the web/desktop section. What
 * the actions taken actually saved against each resource's pre-action spend,
 * beside what they were projected to save.
 *
 * Read-only, deliberately: logging, editing and the settings are org-wide
 * `costs:write` actions that stay on web and desktop (the anomaly-tuning
 * line), and a phone is where the receipt is read rather than written.
 */
export function RealizedSavingsSection() {
  const query = useRealizedSavings();
  const report = query.data ?? null;

  return (
    <>
      <SectionTitle>Realized savings</SectionTitle>
      {query.isError ? (
        <Card>
          <Text style={styles.error}>
            Couldn&apos;t load realized savings:{" "}
            {query.error instanceof Error ? query.error.message : "request failed"}
          </Text>
        </Card>
      ) : query.isLoading ? (
        <Card>
          <Text style={styles.muted}>Measuring savings against billing…</Text>
        </Card>
      ) : !report || report.events.length === 0 ? (
        <Card>
          <Text style={styles.muted}>
            No savings recorded yet. Resizes, orphan cleanups and sleep schedules are recorded as
            they happen; anything else can be logged from the web or desktop app.
          </Text>
        </Card>
      ) : (
        <>
          <Card>
            {report.totals.map((t) => (
              <View key={t.currency} style={styles.totalRow}>
                <Text style={styles.total}>{formatMoney(t.realized, t.currency)}</Text>
                <Text style={styles.muted}>
                  realized of {formatMoney(t.projected, t.currency)} projected
                </Text>
              </View>
            ))}
            {report.shortfallCount > 0 && (
              <Text style={styles.warning}>
                {report.shortfallCount} action(s) realizing less than projected
              </Text>
            )}
          </Card>
          <Card list>
            {report.events.slice(0, MAX_ROWS).map((e) => (
              <SavingsRow key={e.id} event={e} />
            ))}
          </Card>
          <Text style={styles.footnote}>
            Last 12 months. Measured against each resource&apos;s spend before the action; one-off
            actions count for {report.settings.horizonMonths} months. Log or edit savings from the
            web or desktop app.
          </Text>
        </>
      )}
    </>
  );
}

function SavingsRow({ event }: { event: SavingsEventResult }) {
  const currency = event.realizedCurrency ?? event.currency ?? "USD";
  return (
    <View style={styles.row}>
      <View style={styles.rowMain}>
        <Text style={styles.title} numberOfLines={1}>
          {event.title}
        </Text>
        <Text style={styles.subtitle} numberOfLines={2}>
          {SAVINGS_EVENT_KIND_LABELS[event.kind]} · {event.occurredOn} ·{" "}
          {REALIZED_SAVINGS_BASIS_LABELS[event.basis]}
        </Text>
        {event.shortfall && (
          <Text style={styles.warning}>
            {event.shortfall.kind === "grew_back"
              ? "Spend is back above the baseline"
              : "Falling short of the projection"}
          </Text>
        )}
      </View>
      {/* Unmeasured shows no figure at all: a zero would read as "saved nothing". */}
      {event.realizedInRange !== null && (
        <Text style={styles.amount}>{formatMoney(event.realizedInRange, currency)}</Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  totalRow: { flexDirection: "row", alignItems: "baseline", gap: spacing.sm },
  total: { color: colors.text, fontSize: 20, fontWeight: "600" },
  row: { flexDirection: "row", alignItems: "center", gap: spacing.md, paddingVertical: 10 },
  rowMain: { flex: 1, gap: 2 },
  title: { color: colors.text, fontSize: 15, fontWeight: "500" },
  subtitle: { color: colors.textMuted, fontSize: 12 },
  amount: { color: colors.text, fontSize: 14, fontWeight: "500" },
  muted: { color: colors.textMuted, fontSize: 13 },
  warning: { color: colors.warning, fontSize: 12 },
  error: { color: colors.danger, fontSize: 13 },
  footnote: { color: colors.textFaint, fontSize: 11 },
});

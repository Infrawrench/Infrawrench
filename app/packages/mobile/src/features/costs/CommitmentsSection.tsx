import { StyleSheet, Text, View } from "react-native";
import {
  formatMoney,
  type CommitmentCoverageView,
  type CommitmentHolding,
  type CommitmentRecommendationView,
} from "@infrawrench/client-core";
import { Card, SectionTitle } from "@/components/ui";
import { colors, spacing } from "@/lib/theme";
import { useCommitments } from "./useCommitments";

/**
 * Native counterpart to `CommitmentsSection` on web and desktop — read-only,
 * like budgets here: reservations, savings plans and committed-use discounts
 * with coverage, utilization and the planner's recommendations. Purchasing
 * decisions stay on web/desktop (and ultimately in the provider's console —
 * nothing anywhere auto-purchases).
 *
 * The rendering rules travel with the contract: null money prints "price not
 * reported" (never $0), null region prints "All regions", null utilization
 * prints its reason (never 0% — "unknown" and "unused" must not look alike).
 */
export function CommitmentsSection() {
  const feed = useCommitments();
  const data = feed.data;

  // No commitment-capable providers connected: stay out of the way entirely,
  // the way the change-alerts section does.
  if (
    !feed.isLoading &&
    !feed.isError &&
    data &&
    data.holdings.length === 0 &&
    data.planner.recommendations.length === 0 &&
    data.failures.length === 0
  ) {
    return null;
  }
  if (!feed.isLoading && !feed.isError && !data) return null;

  return (
    <>
      <SectionTitle>Commitments</SectionTitle>

      {feed.isError ? (
        <Card>
          <Text style={styles.error}>
            Couldn&apos;t load commitments —{" "}
            {feed.error instanceof Error ? feed.error.message : "request failed"}
          </Text>
        </Card>
      ) : feed.isLoading ? (
        <Card>
          <Text style={styles.muted}>Loading commitments…</Text>
        </Card>
      ) : data ? (
        <>
          <CoverageNote coverage={data.coverage} windowDays={data.utilizationWindowDays} />
          {data.holdings.length > 0 && (
            <Card list>
              {data.holdings.map((holding) => (
                <HoldingRow
                  key={`${holding.accountId}:${holding.commitmentId}`}
                  holding={holding}
                />
              ))}
            </Card>
          )}
          {data.planner.recommendations.length > 0 && (
            <Card list>
              {data.planner.recommendations.map((rec) => (
                <RecommendationRow
                  key={`${rec.pluginId}:${rec.service}:${rec.region}:${rec.currency}`}
                  rec={rec}
                />
              ))}
            </Card>
          )}
          {data.failures.map((failure) => (
            <Text key={failure.accountId} style={styles.warning}>
              {failure.accountName}: {failure.message}
            </Text>
          ))}
          <Text style={styles.footnote}>
            Read-only; recommendations never purchase anything. Savings quote published “up to”
            rates.
          </Text>
        </>
      ) : null}
    </>
  );
}

function pct(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function CoverageNote({
  coverage,
  windowDays,
}: {
  coverage: CommitmentCoverageView;
  windowDays: number;
}) {
  if (!coverage.available) return null;
  const lines = coverage.currencies.filter((c) => c.broadRatio !== null && c.narrowRatio !== null);
  if (lines.length === 0) return null;
  return (
    <Text style={styles.coverage}>
      {lines
        .map((c) => {
          // A range, deliberately: the low end counts spend that can never be
          // committed against, the high end only demonstrably-committable cells.
          const range =
            c.broadRatio === c.narrowRatio
              ? pct(c.broadRatio!)
              : `${pct(c.broadRatio!)}–${pct(c.narrowRatio!)}`;
          return `${range} of ${c.currency} usage covered`;
        })
        .join(" · ")}{" "}
      (last {windowDays} days)
    </Text>
  );
}

const UTILIZATION_REASON: Record<string, string> = {
  unit_denominated: "utilization not measurable from spend",
  no_active_days: "not active in the window",
  no_data_days: "no cost data on active days",
  unattributed_rows: "no commitment attribution on cost rows",
};

function committedLabel(h: CommitmentHolding): string {
  if (h.hourlyCommitmentAmount !== null && h.currency) {
    return `${formatMoney(h.hourlyCommitmentAmount, h.currency)}/h committed`;
  }
  if (h.upfrontAmount !== null && h.currency) {
    return `${formatMoney(h.upfrontAmount, h.currency)} upfront`;
  }
  if (h.unitCommitments && h.unitCommitments.length > 0) {
    return h.unitCommitments.map((u) => `${u.amount} ${u.unit}`).join(", ");
  }
  // Not $0: Azure's list API reports no price, and "free" is the wrong word.
  return "price not reported";
}

function utilizationLabel(h: CommitmentHolding): string {
  const u = h.utilization;
  if (u.utilization !== null) {
    return `${pct(u.utilization)} utilized (${u.measuredDays}d measured${
      u.missingDays > 0 ? `, ${u.missingDays}d no data` : ""
    })`;
  }
  if (h.providerUtilization && h.providerUtilization.length > 0) {
    const monthly =
      h.providerUtilization.find((p) => p.grainDays === 30) ?? h.providerUtilization[0]!;
    return `${monthly.percentage}% utilized (provider-reported, ${monthly.grainDays}d)`;
  }
  return UTILIZATION_REASON[u.reason ?? ""] ?? "utilization unknown";
}

function HoldingRow({ holding }: { holding: CommitmentHolding }) {
  return (
    <View style={styles.row}>
      <View style={styles.rowMain}>
        <Text style={styles.title} numberOfLines={2}>
          {holding.description}
        </Text>
        <Text style={styles.subtitle} numberOfLines={2}>
          {holding.accountName} · {holding.region ?? "All regions"} · {committedLabel(holding)}
          {holding.endDate ? ` · ends ${holding.endDate.slice(0, 10)}` : ""}
        </Text>
        <Text style={styles.subtitle} numberOfLines={1}>
          {utilizationLabel(holding)}
        </Text>
      </View>
      <Text
        style={[
          styles.state,
          {
            color:
              holding.state === "active"
                ? colors.success
                : holding.state === "queued"
                  ? colors.textMuted
                  : colors.textFaint,
          },
        ]}
      >
        {holding.state}
      </Text>
    </View>
  );
}

function RecommendationRow({ rec }: { rec: CommitmentRecommendationView }) {
  const saving =
    rec.savingBasis === "range" && rec.estimatedAnnualSavingMin !== undefined
      ? `${formatMoney(rec.estimatedAnnualSavingMin, rec.currency)}–${formatMoney(rec.estimatedAnnualSavingMax, rec.currency)}/yr`
      : `up to ${formatMoney(rec.estimatedAnnualSavingMax, rec.currency)}/yr`;
  return (
    <View style={styles.row}>
      <View style={styles.rowMain}>
        <Text style={styles.title} numberOfLines={1}>
          {rec.pluginId} · {rec.service}
          {rec.region ? ` · ${rec.region}` : ""}
        </Text>
        <Text style={styles.subtitle} numberOfLines={2}>
          Commit {formatMoney(rec.recommendedHourlyCommitment, rec.currency)}/h — save {saving} ·
          break-even at {pct(rec.breakEvenUtilization)} utilization
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: spacing.md, paddingVertical: 10 },
  rowMain: { flex: 1, gap: 2 },
  title: { color: colors.text, fontSize: 15, fontWeight: "500", flexShrink: 1 },
  subtitle: { color: colors.textMuted, fontSize: 12 },
  state: { fontSize: 12, fontWeight: "600" },
  coverage: { color: colors.textMuted, fontSize: 12 },
  muted: { color: colors.textMuted, fontSize: 13 },
  warning: { color: colors.warning, fontSize: 12 },
  error: { color: colors.danger, fontSize: 13 },
  footnote: { color: colors.textFaint, fontSize: 11 },
});

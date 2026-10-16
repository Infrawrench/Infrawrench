import { useGT } from "gt-react";
import {
  COMMITMENT_REPORT_ON_DEMAND_KEY,
  COMMITMENT_REPORT_UNATTRIBUTED_KEY,
  COMMITMENT_REPORT_UNKNOWN_KIND_KEY,
  formatMoney,
  isCommitmentRatioMetric,
  type CommitmentKind,
  type CommitmentReportGranularity,
  type CommitmentReportGroupBy,
  type CommitmentReportMetric,
  type CommitmentReportNotice,
  type CommitmentReportSeries,
} from "@infrawrench/client-core";

/**
 * Translated labels for the commitment report vocabulary. Written as literal
 * `gt()` calls in switches (not a lookup over client-core's English maps) so
 * the extractor sees every string; the CLI prints the client-core maps.
 */
export function useCommitmentReportLabels() {
  const gt = useGT();

  const metric = (m: CommitmentReportMetric): string => {
    switch (m) {
      case "coverage":
        return gt("Coverage");
      case "eligibleCoverage":
        return gt("Coverage of eligible usage");
      case "utilization":
        return gt("Utilization");
      case "effectiveSavingsRate":
        return gt("Effective savings rate");
      case "netSavings":
        return gt("Net savings vs on-demand");
      case "onDemandRemainder":
        return gt("On-demand remainder");
      case "commitmentCost":
        return gt("Commitment cost");
      case "usedCommitmentCost":
        return gt("Used commitment cost");
      case "unusedCommitmentCost":
        return gt("Unused commitment cost");
    }
  };

  const metricHint = (m: CommitmentReportMetric): string => {
    switch (m) {
      case "coverage":
        return gt("Usage covered by commitments, as a share of all usage. The lower bound.");
      case "eligibleCoverage":
        return gt(
          "Covered usage as a share of usage in services and regions a commitment covered at some point in the window. The upper bound.",
        );
      case "utilization":
        return gt("Used commitment as a share of everything committed.");
      case "effectiveSavingsRate":
        return gt("Net savings as a share of what all this usage would have cost on demand.");
      case "netSavings":
        return gt(
          "What covered usage would have cost on demand, minus what it cost, minus unused commitment.",
        );
      case "onDemandRemainder":
        return gt("Usage no commitment covered, billed on demand.");
      case "commitmentCost":
        return gt("Used plus unused commitment, amortized.");
      case "usedCommitmentCost":
        return gt("Commitment that paid for usage.");
      case "unusedCommitmentCost":
        return gt("Commitment no usage absorbed: money that bought nothing.");
    }
  };

  const granularity = (g: CommitmentReportGranularity): string => {
    switch (g) {
      case "daily":
        return gt("Daily");
      case "weekly":
        return gt("Weekly");
      case "monthly":
        return gt("Monthly");
      case "quarterly":
        return gt("Quarterly");
    }
  };

  const groupBy = (g: CommitmentReportGroupBy): string => {
    switch (g) {
      case "none":
        return gt("No grouping");
      case "provider":
        return gt("Provider");
      case "commitment_type":
        return gt("Commitment type");
      case "commitment":
        return gt("Commitment");
      case "service":
        return gt("Service");
      case "account":
        return gt("Account");
      case "region":
        return gt("Region");
    }
  };

  const kind = (k: CommitmentKind): string => {
    switch (k) {
      case "reservation":
        return gt("Reservations");
      case "savings_plan":
        return gt("Savings plans");
      case "committed_use":
        return gt("Committed-use discounts");
    }
  };

  /** A series' display label: sentinels and kinds translated, data as-is. */
  const series = (
    s: Pick<CommitmentReportSeries, "groupKey" | "label">,
    by: CommitmentReportGroupBy,
  ) => {
    if (s.groupKey === COMMITMENT_REPORT_ON_DEMAND_KEY) return gt("On demand (not covered)");
    if (s.groupKey === COMMITMENT_REPORT_UNATTRIBUTED_KEY) {
      return gt("Covered, commitment not reported");
    }
    if (s.groupKey === COMMITMENT_REPORT_UNKNOWN_KIND_KEY) return gt("Commitment not in inventory");
    if (by === "commitment_type") {
      if (
        s.groupKey === "reservation" ||
        s.groupKey === "savings_plan" ||
        s.groupKey === "committed_use"
      ) {
        return kind(s.groupKey);
      }
    }
    if (by === "none") return gt("All commitments");
    if (s.groupKey === "") return by === "region" ? gt("No region") : gt("Not set");
    return s.label;
  };

  const notice = (n: CommitmentReportNotice): string => {
    switch (n) {
      case "unused_lumped_monthly":
        return gt(
          "AWS reports a month's unused commitment on the first day of the month (or the purchase day), so daily and weekly utilization dip there. Use monthly granularity for AWS utilization.",
        );
      case "unattributed_commitment_usage":
        return gt(
          "Some covered usage is not tied to a specific commitment: AWS billing data cannot say which reservation or savings plan covered an hour, so it is grouped as “Covered, commitment not reported”.",
        );
      case "partial_savings_measurement":
        return gt(
          "Some covered usage has no reported on-demand price, so savings count it as saving nothing. Savings here are a lower bound.",
        );
      case "no_measurable_accounts":
        return gt(
          "No account in scope reports covered usage separately, so coverage, utilization and savings cannot be measured.",
        );
    }
  };

  return { metric, metricHint, granularity, groupBy, kind, series, notice };
}

/** One metric value as text: a percentage for ratios, money otherwise; "—" for not measurable. */
export function formatCommitmentMetric(
  metric: CommitmentReportMetric,
  value: number | null,
  currency: string,
): string {
  if (value === null || !Number.isFinite(value)) return "—";
  if (isCommitmentRatioMetric(metric)) return `${(value * 100).toFixed(1)}%`;
  return formatMoney(value, currency);
}

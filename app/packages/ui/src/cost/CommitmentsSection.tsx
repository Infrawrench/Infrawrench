import { useEffect, useState } from "react";
import {
  formatCreditAmount,
  type CommitmentHolding,
  type CommitmentRecommendationView,
  type CommitmentsFeed,
  type CommitmentState,
} from "@infrawrench/client-core";

import type { CostsClient } from "./types.js";

const STATE_CLASS: Record<CommitmentState, string> = {
  active: "text-emerald-400 bg-emerald-500/10",
  queued: "text-sky-400 bg-sky-500/10",
  expired: "text-on-surface-tertiary bg-surface-overlay",
};

const REASON_LABEL: Record<string, string> = {
  unit_denominated: "not measurable from spend (unit-denominated)",
  no_active_days: "not active in the window",
  no_data_days: "no cost data collected on active days",
  unattributed_rows: "provider rows carry no commitment attribution",
};

function pct(value: number): string {
  return `${Math.round(value * 100)}%`;
}

export interface CommitmentsSectionProps {
  client: CostsClient;
}

/**
 * Commitments: what the org bought ahead of use, whether it is paying off,
 * and what the planner would buy next.
 *
 * The rendering rules here are the contract's rules, restated as pixels:
 * a null money field prints "not reported" (never $0 — that reads as free),
 * a null region prints "All regions" (a Compute Savings Plan really does
 * apply everywhere), a null utilization prints its reason (never 0% — in a
 * table, "unknown" and "unused" are indistinguishable and one of them gets
 * a healthy plan cancelled), and coverage prints as a range because there
 * is no single honest denominator.
 *
 * Renders nothing when the org has no commitment-capable accounts; hides
 * itself entirely when the host client lacks the capability.
 */
export function CommitmentsSection({ client }: CommitmentsSectionProps) {
  const [feed, setFeed] = useState<CommitmentsFeed | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const getCommitments = client.getCommitments;
    if (!getCommitments) return;
    let cancelled = false;
    // Awaited inside try/catch rather than chained: a host implementation may
    // throw *synchronously* (desktop's requires cloud mode) — see
    // CreditBurndownSection.
    void (async () => {
      try {
        const result = await getCommitments();
        if (!cancelled) {
          setFeed(result);
          setError(null);
        }
      } catch (e: unknown) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client]);

  if (!client.getCommitments) return null;
  // No holdings, no recommendations, nothing broken: the org has no
  // commitment-capable providers, and an empty card is furniture.
  if (
    !error &&
    feed &&
    feed.holdings.length === 0 &&
    feed.planner.recommendations.length === 0 &&
    feed.failures.length === 0 &&
    feed.pendingAccountIds.length === 0
  ) {
    return null;
  }

  return (
    <section className="space-y-3">
      <div>
        <h2 className="text-sm font-semibold text-on-surface-secondary">Commitments</h2>
        <p className="text-xs text-on-surface-muted mt-1">
          Reserved instances, savings plans and committed-use discounts — the largest lever on a
          large bill. Utilization is measured only over days with collected cost data.
        </p>
      </div>

      {error && <p className="text-sm text-red-400">{error}</p>}

      {feed && <CoverageLine feed={feed} />}

      {feed && feed.holdings.length > 0 && (
        <ul className="border border-border rounded-xl divide-y divide-border overflow-hidden">
          {feed.holdings.map((holding) => (
            <HoldingRow key={`${holding.accountId}:${holding.commitmentId}`} holding={holding} />
          ))}
        </ul>
      )}

      {feed && feed.planner.recommendations.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-xs font-semibold text-on-surface-secondary">
            Savings planner — commit at the floor of {feed.plannerWindowDays}-day uncovered spend
          </h3>
          <ul className="border border-border rounded-xl divide-y divide-border overflow-hidden">
            {feed.planner.recommendations.map((rec) => (
              <RecommendationRow
                key={`${rec.pluginId}:${rec.service}:${rec.region}:${rec.currency}`}
                rec={rec}
              />
            ))}
          </ul>
          <p className="text-xs text-on-surface-muted">
            Recommendations only — nothing is purchased automatically. Savings quote the
            provider&rsquo;s published &ldquo;up to&rdquo; rates.
          </p>
        </div>
      )}

      {feed?.failures.map((failure) => (
        <p key={failure.accountId} className="text-xs text-amber-400">
          {failure.accountName}: {failure.message}
        </p>
      ))}

      {feed && feed.pendingAccountIds.length > 0 && (
        <p className="text-xs text-on-surface-muted">
          {feed.pendingAccountIds.length} account
          {feed.pendingAccountIds.length === 1 ? "" : "s"} awaiting first commitment collection.
        </p>
      )}
    </section>
  );
}

/**
 * Coverage as a range, per currency. Ratios are never merged across
 * currencies, and an all-excluded scope says "unavailable", not 0%.
 */
function CoverageLine({ feed }: { feed: CommitmentsFeed }) {
  const { coverage } = feed;
  if (!coverage.available) {
    if (coverage.excludedAccountIds.length === 0) return null;
    return (
      <p className="text-xs text-on-surface-muted">
        Coverage unavailable: no connected account&rsquo;s provider distinguishes covered from
        uncovered usage.
      </p>
    );
  }
  const lines = coverage.currencies.filter((c) => c.broadRatio !== null);
  if (lines.length === 0) return null;
  return (
    <div className="text-xs text-on-surface-muted space-y-0.5">
      {lines.map((c) => (
        <p key={c.currency}>
          <span className="text-on-surface-secondary font-medium">
            {c.broadRatio !== null && c.narrowRatio !== null
              ? c.broadRatio === c.narrowRatio
                ? pct(c.broadRatio)
                : `${pct(c.broadRatio)}–${pct(c.narrowRatio)}`
              : "—"}
          </span>{" "}
          of {c.currency} usage spend covered by commitments over the last{" "}
          {feed.utilizationWindowDays} days
          {/* The range is the honest answer: the low end counts egress and
              per-request charges that can never be committed against, the
              high end only cells where a commitment demonstrably landed. */}
        </p>
      ))}
      {coverage.excludedAccountIds.length > 0 && (
        <p>
          {coverage.excludedAccountIds.length} account
          {coverage.excludedAccountIds.length === 1 ? "" : "s"} excluded (provider cannot
          distinguish charge types).
        </p>
      )}
    </div>
  );
}

function HoldingRow({ holding }: { holding: CommitmentHolding }) {
  const { utilization } = holding;
  const money =
    holding.hourlyCommitmentAmount !== null && holding.currency
      ? `${formatCreditAmount(holding.hourlyCommitmentAmount, holding.currency)}/hour committed`
      : holding.upfrontAmount !== null && holding.currency
        ? `${formatCreditAmount(holding.upfrontAmount, holding.currency)} upfront`
        : holding.unitCommitments && holding.unitCommitments.length > 0
          ? holding.unitCommitments.map((u) => `${u.amount} ${u.unit}`).join(", ")
          : // "Not reported" (Azure reports no price on its list API), which
            // is a different fact from $0.
            "price not reported";

  return (
    <li className="p-3 flex items-center gap-3 flex-wrap">
      <div className="min-w-0 flex-1">
        <p className="text-sm text-on-surface-secondary">
          <span className="font-medium">{holding.description}</span>
        </p>
        <p className="text-xs text-on-surface-muted mt-0.5">
          {holding.accountName} · {holding.region ?? "All regions"} · {money}
          {holding.endDate && <> · ends {holding.endDate.slice(0, 10)}</>}
        </p>
        <p className="text-xs text-on-surface-muted mt-0.5">
          {utilization.utilization !== null ? (
            <>
              {pct(utilization.utilization)} utilized over {utilization.measuredDays} measured day
              {utilization.measuredDays === 1 ? "" : "s"}
              {utilization.missingDays > 0 && (
                // A day collection never ran is reported, never counted as
                // idle commitment — that miscount cancels healthy plans.
                <> · {utilization.missingDays} days without cost data</>
              )}
            </>
          ) : (
            <>Utilization: {REASON_LABEL[utilization.reason ?? ""] ?? "not measurable"}</>
          )}
          {holding.providerUtilization && holding.providerUtilization.length > 0 && (
            <>
              {" "}
              · provider-reported:{" "}
              {holding.providerUtilization
                .map((u) => `${u.percentage}% / ${u.grainDays}d`)
                .join(", ")}
            </>
          )}
        </p>
      </div>
      <span
        className={`text-xs px-2 py-0.5 rounded-md whitespace-nowrap ${STATE_CLASS[holding.state]}`}
      >
        {holding.state}
      </span>
    </li>
  );
}

function RecommendationRow({ rec }: { rec: CommitmentRecommendationView }) {
  const saving =
    rec.savingBasis === "range" && rec.estimatedAnnualSavingMin !== undefined
      ? `${formatCreditAmount(rec.estimatedAnnualSavingMin, rec.currency)}–${formatCreditAmount(
          rec.estimatedAnnualSavingMax,
          rec.currency,
        )}/yr`
      : `up to ${formatCreditAmount(rec.estimatedAnnualSavingMax, rec.currency)}/yr`;
  return (
    <li className="p-3">
      <p className="text-sm text-on-surface-secondary">
        <span className="font-medium">
          {rec.pluginId} · {rec.service}
          {rec.region ? ` · ${rec.region}` : ""}
        </span>{" "}
        <span className="text-on-surface-muted">
          — commit {formatCreditAmount(rec.recommendedHourlyCommitment, rec.currency)}/hour, save{" "}
          {saving}
        </span>
      </p>
      <p className="text-xs text-on-surface-muted mt-0.5">
        Break-even at {pct(rec.breakEvenUtilization)} utilization — this workload can shrink by{" "}
        {pct(rec.discountRateMax)} before the commitment loses money.
        {rec.annualLossIfUsageHalves > 0 && (
          <>
            {" "}
            If usage halves: up to {formatCreditAmount(rec.annualLossIfUsageHalves, rec.currency)}
            /yr lost.
          </>
        )}
      </p>
    </li>
  );
}

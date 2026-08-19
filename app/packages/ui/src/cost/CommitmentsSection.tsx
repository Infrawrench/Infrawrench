import { useEffect, useState } from "react";
import { T, Var, useGT } from "gt-react";
import {
  formatCreditAmount,
  type CommitmentHolding,
  type CommitmentRecommendationView,
  type CommitmentsFeed,
  type CommitmentState,
} from "@infrawrench/client-core";

import type { CostsClient } from "./types.js";

const STATE_CLASS: Record<CommitmentState, string> = {
  active: "text-success bg-emerald-500/10",
  queued: "text-info bg-sky-500/10",
  expired: "text-on-surface-tertiary bg-surface-overlay",
};

function reasonLabel(gt: ReturnType<typeof useGT>, reason: string | undefined): string {
  switch (reason) {
    case "unit_denominated":
      return gt("not measurable from spend (unit-denominated)");
    case "no_active_days":
      return gt("not active in the window");
    case "no_data_days":
      return gt("no cost data collected on active days");
    case "unattributed_rows":
      return gt("provider rows carry no commitment attribution");
    default:
      return gt("not measurable");
  }
}

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
  const gt = useGT();
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
        <h2 className="text-sm font-semibold text-on-surface-secondary">{gt("Commitments")}</h2>
        <T>
          <p className="text-xs text-on-surface-muted mt-1">
            Reserved instances, savings plans and committed-use discounts — the largest lever on a
            large bill. Utilization is measured only over days with collected cost data.
          </p>
        </T>
      </div>

      {error && <p className="text-sm text-danger">{error}</p>}

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
            {gt("Savings planner — commit at the floor of {days}-day uncovered spend", {
              days: feed.plannerWindowDays,
            })}
          </h3>
          <ul className="border border-border rounded-xl divide-y divide-border overflow-hidden">
            {feed.planner.recommendations.map((rec) => (
              <RecommendationRow
                key={`${rec.pluginId}:${rec.service}:${rec.region}:${rec.currency}`}
                rec={rec}
              />
            ))}
          </ul>
          <T>
            <p className="text-xs text-on-surface-muted">
              Recommendations only — nothing is purchased automatically. Savings quote the
              provider&rsquo;s published &ldquo;up to&rdquo; rates.
            </p>
          </T>
        </div>
      )}

      {feed?.failures.map((failure) => (
        <p key={failure.accountId} className="text-xs text-warning">
          {failure.accountName}: {failure.message}
        </p>
      ))}

      {feed && feed.pendingAccountIds.length > 0 && (
        <p className="text-xs text-on-surface-muted">
          {feed.pendingAccountIds.length === 1
            ? gt("1 account awaiting first commitment collection.")
            : gt("{count} accounts awaiting first commitment collection.", {
                count: feed.pendingAccountIds.length,
              })}
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
  const gt = useGT();
  const { coverage } = feed;
  if (!coverage.available) {
    if (coverage.excludedAccountIds.length === 0) return null;
    return (
      <T>
        <p className="text-xs text-on-surface-muted">
          Coverage unavailable: no connected account&rsquo;s provider distinguishes covered from
          uncovered usage.
        </p>
      </T>
    );
  }
  const lines = coverage.currencies.filter((c) => c.broadRatio !== null);
  if (lines.length === 0) return null;
  return (
    <div className="text-xs text-on-surface-muted space-y-0.5">
      {lines.map((c) => (
        <T key={c.currency}>
          <p>
            <span className="text-on-surface-secondary font-medium">
              <Var>
                {c.broadRatio !== null && c.narrowRatio !== null
                  ? c.broadRatio === c.narrowRatio
                    ? pct(c.broadRatio)
                    : `${pct(c.broadRatio)}–${pct(c.narrowRatio)}`
                  : "—"}
              </Var>
            </span>{" "}
            of <Var>{c.currency}</Var> usage spend covered by commitments over the last{" "}
            <Var>{feed.utilizationWindowDays}</Var> days
            {/* The range is the honest answer: the low end counts egress and
                per-request charges that can never be committed against, the
                high end only cells where a commitment demonstrably landed. */}
          </p>
        </T>
      ))}
      {coverage.excludedAccountIds.length > 0 && (
        <p>
          {coverage.excludedAccountIds.length === 1
            ? gt("1 account excluded (provider cannot distinguish charge types).")
            : gt("{count} accounts excluded (provider cannot distinguish charge types).", {
                count: coverage.excludedAccountIds.length,
              })}
        </p>
      )}
    </div>
  );
}

function HoldingRow({ holding }: { holding: CommitmentHolding }) {
  const gt = useGT();
  const { utilization } = holding;
  const money =
    holding.hourlyCommitmentAmount !== null && holding.currency
      ? gt("{amount}/hour committed", {
          amount: formatCreditAmount(holding.hourlyCommitmentAmount, holding.currency),
        })
      : holding.upfrontAmount !== null && holding.currency
        ? gt("{amount} upfront", {
            amount: formatCreditAmount(holding.upfrontAmount, holding.currency),
          })
        : holding.unitCommitments && holding.unitCommitments.length > 0
          ? holding.unitCommitments.map((u) => `${u.amount} ${u.unit}`).join(", ")
          : // "Not reported" (Azure reports no price on its list API), which
            // is a different fact from $0.
            gt("price not reported");

  return (
    <li className="p-3 flex items-center gap-3 flex-wrap">
      <div className="min-w-0 flex-1">
        <p className="text-sm text-on-surface-secondary">
          <span className="font-medium">{holding.description}</span>
        </p>
        <p className="text-xs text-on-surface-muted mt-0.5">
          {holding.accountName} · {holding.region ?? gt("All regions")} · {money}
          {holding.endDate && <> · {gt("ends {date}", { date: holding.endDate.slice(0, 10) })}</>}
        </p>
        <p className="text-xs text-on-surface-muted mt-0.5">
          {utilization.utilization !== null ? (
            <>
              {utilization.measuredDays === 1
                ? gt("{pct} utilized over {days} measured day", {
                    pct: pct(utilization.utilization),
                    days: utilization.measuredDays,
                  })
                : gt("{pct} utilized over {days} measured days", {
                    pct: pct(utilization.utilization),
                    days: utilization.measuredDays,
                  })}
              {utilization.missingDays > 0 && (
                // A day collection never ran is reported, never counted as
                // idle commitment — that miscount cancels healthy plans.
                <> · {gt("{days} days without cost data", { days: utilization.missingDays })}</>
              )}
            </>
          ) : (
            <>{gt("Utilization: {reason}", { reason: reasonLabel(gt, utilization.reason) })}</>
          )}
          {holding.providerUtilization && holding.providerUtilization.length > 0 && (
            <>
              {" "}
              · {gt("provider-reported:")}{" "}
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
  const gt = useGT();
  const saving =
    rec.savingBasis === "range" && rec.estimatedAnnualSavingMin !== undefined
      ? gt("{min}–{max}/yr", {
          min: formatCreditAmount(rec.estimatedAnnualSavingMin, rec.currency),
          max: formatCreditAmount(rec.estimatedAnnualSavingMax, rec.currency),
        })
      : gt("up to {max}/yr", {
          max: formatCreditAmount(rec.estimatedAnnualSavingMax, rec.currency),
        });
  return (
    <li className="p-3">
      <p className="text-sm text-on-surface-secondary">
        <span className="font-medium">
          {rec.pluginId} · {rec.service}
          {rec.region ? ` · ${rec.region}` : ""}
        </span>{" "}
        <span className="text-on-surface-muted">
          {gt("— commit {amount}/hour, save {saving}", {
            amount: formatCreditAmount(rec.recommendedHourlyCommitment, rec.currency),
            saving,
          })}
        </span>
      </p>
      <p className="text-xs text-on-surface-muted mt-0.5">
        {gt(
          "Break-even at {breakEven} utilization — this workload can shrink by {discount} before the commitment loses money.",
          {
            breakEven: pct(rec.breakEvenUtilization),
            discount: pct(rec.discountRateMax),
          },
        )}
        {rec.annualLossIfUsageHalves > 0 && (
          <>
            {" "}
            {gt("If usage halves: up to {loss}/yr lost.", {
              loss: formatCreditAmount(rec.annualLossIfUsageHalves, rec.currency),
            })}
          </>
        )}
      </p>
    </li>
  );
}

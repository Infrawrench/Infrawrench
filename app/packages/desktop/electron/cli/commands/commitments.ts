import { CliError, orgFetch, resolveOrg, type CliContext } from "../context";
import type {
  CommitmentHolding,
  CommitmentRecommendationView,
  CommitmentsFeed,
} from "@infrawrench/client-core" with { "resolution-mode": "import" };
import { c, printJson, println, printTable, type Column } from "../output";

/** Money in the record's own currency; never summed across currencies. */
function amount(value: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
      maximumFractionDigits: Math.abs(value) < 10 ? 2 : 0,
    }).format(value);
  } catch {
    return `${value.toFixed(2)} ${currency}`;
  }
}

function pct(value: number): string {
  return `${Math.round(value * 100)}%`;
}

/**
 * The committed column: hourly spend commitment, upfront price, committed
 * units — or "not reported", which is a different fact from $0. Azure's list
 * API reports no price at all, GCP's reports no money of any kind, and
 * rendering either as free is how a wrong number lands in a finance review.
 */
function committedCell(h: CommitmentHolding): string {
  if (h.hourlyCommitmentAmount !== null && h.currency) {
    return `${amount(h.hourlyCommitmentAmount, h.currency)}/h`;
  }
  if (h.upfrontAmount !== null && h.currency) {
    return `${amount(h.upfrontAmount, h.currency)} upfront`;
  }
  if (h.unitCommitments && h.unitCommitments.length > 0) {
    return h.unitCommitments.map((u) => `${u.amount} ${u.unit}`).join(", ");
  }
  return c.dim("not reported");
}

/**
 * The utilization cell. Null is never printed as 0% — in a table those are
 * indistinguishable, and one of them sends somebody to cancel a healthy plan.
 */
function utilizationCell(h: CommitmentHolding): string {
  const u = h.utilization;
  if (u.utilization !== null) {
    const text = pct(u.utilization);
    const colored = u.utilization < 0.8 ? c.yellow(text) : c.green(text);
    return u.missingDays > 0 ? `${colored} ${c.dim(`(${u.missingDays}d no data)`)}` : colored;
  }
  if (h.providerUtilization && h.providerUtilization.length > 0) {
    // Azure reports its own utilization; show the 30-day grain when derived
    // utilization is unavailable. Provider-reported, and labelled as such.
    const monthly =
      h.providerUtilization.find((p) => p.grainDays === 30) ?? h.providerUtilization[0];
    if (monthly) return c.dim(`${monthly.percentage}% (provider, ${monthly.grainDays}d)`);
  }
  switch (u.reason) {
    case "unit_denominated":
      return c.dim("unit-denominated");
    case "no_active_days":
      return c.dim("not active in window");
    case "no_data_days":
      return c.dim("no cost data");
    case "unattributed_rows":
      return c.dim("no attribution");
    default:
      return c.dim("—");
  }
}

function stateCell(h: CommitmentHolding): string {
  switch (h.state) {
    case "active":
      return c.green("active");
    case "queued":
      return c.blue("queued");
    default:
      return c.dim("expired");
  }
}

/** "up to $X/yr" or "$X–$Y/yr", per the row's savingBasis — never a bare $X. */
function savingCell(r: CommitmentRecommendationView): string {
  if (r.savingBasis === "range" && r.estimatedAnnualSavingMin !== undefined) {
    return `${amount(r.estimatedAnnualSavingMin, r.currency)}–${amount(r.estimatedAnnualSavingMax, r.currency)}/yr`;
  }
  return `up to ${amount(r.estimatedAnnualSavingMax, r.currency)}/yr`;
}

/**
 * `infrawrench commitments` — reservations, savings plans and committed-use
 * discounts, with coverage, utilization and the savings planner.
 *
 * Worth a CLI surface because the two failure modes it guards against are
 * both scriptable checks: a commitment quietly expiring (holdings with an end
 * date inside your renewal horizon) and a commitment quietly idle (derived
 * utilization sagging). `--json` in a weekly cron is the intended consumer.
 */
export async function cmdCommitments(ctx: CliContext): Promise<void> {
  if (ctx.flags.local) {
    throw new CliError(
      "Commitments live in Infrawrench Cloud — the inventory is collected server-side.",
    );
  }
  const org = await resolveOrg(ctx);
  const feed = await orgFetch<CommitmentsFeed>(org.id, "/commitments");

  if (ctx.flags.output === "json") {
    printJson({ org: org.id, ...feed });
    return;
  }

  if (
    feed.holdings.length === 0 &&
    feed.planner.recommendations.length === 0 &&
    feed.failures.length === 0
  ) {
    println(
      c.dim(
        "No commitments found. Only AWS, GCP and Azure accounts report reservations, " +
          "savings plans or committed-use discounts.",
      ),
    );
    return;
  }

  const active = feed.holdings.filter((h) => h.state === "active").length;
  println(
    `${c.bold(org.displayName)} ${c.dim(
      `· ${feed.holdings.length} commitment${feed.holdings.length === 1 ? "" : "s"}` +
        (active !== feed.holdings.length ? ` (${active} active)` : "") +
        ` · utilization over ${feed.utilizationWindowDays}d of collected data`,
    )}`,
  );

  // Coverage as a range on one line per currency — the low end counts spend
  // that can never be committed against, the high end only cells where a
  // commitment demonstrably landed. One number would overstate certainty.
  if (feed.coverage.available) {
    for (const cov of feed.coverage.currencies) {
      if (cov.broadRatio === null || cov.narrowRatio === null) continue;
      const range =
        cov.broadRatio === cov.narrowRatio
          ? pct(cov.broadRatio)
          : `${pct(cov.broadRatio)}–${pct(cov.narrowRatio)}`;
      println(c.dim(`  ${cov.currency} usage covered by commitments: ${range}`));
    }
    if (feed.coverage.excludedAccountIds.length > 0) {
      println(
        c.dim(
          `  ${feed.coverage.excludedAccountIds.length} account(s) excluded — provider can't tell charge types apart`,
        ),
      );
    }
  } else if (feed.holdings.length > 0) {
    println(c.dim("  coverage unavailable — no account's provider distinguishes charge types"));
  }
  println();

  if (feed.holdings.length > 0) {
    const columns: Column<CommitmentHolding>[] = [
      { header: "commitment", value: (h) => h.description },
      { header: "account", value: (h) => c.dim(h.accountName) },
      // Absent region is a real state (a Compute Savings Plan applies
      // everywhere), not missing data.
      { header: "region", value: (h) => h.region ?? c.dim("all regions") },
      { header: "committed", value: (h) => committedCell(h) },
      { header: "ends", value: (h) => (h.endDate ? h.endDate.slice(0, 10) : c.dim("—")) },
      { header: "state", value: (h) => stateCell(h) },
      { header: "utilization", value: (h) => utilizationCell(h) },
    ];
    printTable(feed.holdings, columns);
  }

  if (feed.planner.recommendations.length > 0) {
    println();
    println(c.bold("Savings planner"));
    println(
      c.dim(
        `Sized at the p10 floor of ${feed.plannerWindowDays}d uncovered usage spend. ` +
          "Recommendations only — nothing is purchased automatically.",
      ),
    );
    const columns: Column<CommitmentRecommendationView>[] = [
      {
        header: "workload",
        value: (r) => `${r.pluginId} · ${r.service}${r.region ? ` · ${r.region}` : ""}`,
      },
      { header: "commit", value: (r) => `${amount(r.recommendedHourlyCommitment, r.currency)}/h` },
      { header: "annual", value: (r) => amount(r.annualCommitment, r.currency) },
      { header: "saving", value: (r) => savingCell(r) },
      {
        header: "break-even",
        value: (r) => `${pct(r.breakEvenUtilization)} util (can shrink ${pct(r.discountRateMax)})`,
      },
    ];
    printTable(feed.planner.recommendations, columns);
    println(
      c.dim(
        "Break-even is exact: at discount d the commitment pays for itself down to 1−d " +
          "utilization. Savings quote published “up to” rates.",
      ),
    );
  }

  for (const failure of feed.failures) {
    println();
    println(c.yellow(`${failure.accountName}: ${failure.message}`));
  }

  if (feed.pendingAccountIds.length > 0) {
    println();
    println(
      c.dim(`${feed.pendingAccountIds.length} account(s) awaiting first commitment collection.`),
    );
  }
}

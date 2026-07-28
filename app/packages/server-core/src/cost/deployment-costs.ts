/**
 * Hosted build minutes, as spend.
 *
 * A deployment run that built on our infrastructure (`build_runner` =
 * `cloud-build`) records the worker seconds we paid for in
 * `deployment_runs.build_seconds`. That column is null whenever the build ran
 * somewhere we don't pay for — a CLI local build, a customer's own SSH host —
 * so it already means "what it cost us". This module turns those seconds into a
 * `cost_daily` row, priced at {@link HOSTED_BUILD_USD_PER_SECOND}, so build
 * spend shows up in the same cost graphs, dimension filters, and budgets as
 * everything else instead of hiding in the deployment history.
 *
 * **Why the reserved tag.** `cost_daily` is a ReplacingMergeTree keyed on
 * `(org, account, day, service, region, resource_id, tags_hash, currency)` —
 * `plugin_id` is NOT in that key and the ORDER BY is frozen. A row we attribute
 * to a real account could therefore silently REPLACE a poller-collected row for
 * the same day and service. Every row written here carries the reserved
 * `infrawrench:deployment` tag naming the run, which changes `tags_hash` and
 * guarantees a key space disjoint from the collectors' — the same trick
 * `cost/workflow-costs.ts` and `cost/external-costs.ts` use, and the reason
 * `cost/cost-ingest.ts` refuses to let user code set an `infrawrench:` tag.
 * Keying on the *run* id additionally means two builds on the same day add up
 * rather than overwrite each other, while re-writing the same run (a retry, a
 * re-priced backfill) restates its own row and nothing else.
 */
import { isClickHouseConfigured } from "../clickhouse/client";
import { ingestCostRows } from "./cost-ingest";
import { isoDay } from "./dates";
import {
  DEPLOYMENT_COST_PLUGIN_ID,
  DEPLOYMENT_COST_TAG,
  deploymentCostAccountId,
  HOSTED_BUILD_SERVICE,
} from "./deployment-cost-ids";

/**
 * USD per second of hosted build-worker time.
 *
 * A placeholder in the right order of magnitude, not a billing figure: it
 * approximates Google Cloud Build's E2_HIGHCPU_8 machine-type rate (~$0.016 per
 * build-minute at the time of writing). Revisit it against what the build
 * workers actually cost us — and against the provider's current published
 * price — before anyone treats these numbers as chargeable.
 */
export const HOSTED_BUILD_USD_PER_SECOND = 0.00027;

/**
 * Record one hosted build's cost. Idempotent per run id: calling it again for
 * the same run restates that row rather than adding a second one.
 *
 * A run that built somewhere we don't pay for has no `buildSeconds` and writes
 * nothing, so callers can hand over whatever the row holds without checking.
 */
export async function writeDeploymentBuildCost(opts: {
  organizationId: string;
  /** `deployment_runs.id` — the reserved tag value and the row's resource id. */
  runId: string;
  /** Environment the run targeted; groups the row in the account dimension. */
  env: string;
  /** Hosted worker seconds we paid for. Null/0 for a build we didn't host. */
  buildSeconds: number | null | undefined;
  /** When the run started — decides which UTC day the spend lands on. */
  startedAt: Date;
}): Promise<{ written: number }> {
  const { organizationId, runId, env, buildSeconds, startedAt } = opts;

  if (typeof buildSeconds !== "number" || !Number.isFinite(buildSeconds) || buildSeconds <= 0) {
    return { written: 0 };
  }
  // Unlike the user-facing ingest paths there is nobody to report this to: a
  // self-hosted server without ClickHouse still deploys, and a bookkeeping write
  // must never be the thing that fails a deploy.
  if (!isClickHouseConfigured()) return { written: 0 };

  return ingestCostRows({
    organizationId,
    rows: [
      {
        date: isoDay(startedAt),
        currency: "USD",
        // Rounded to sub-cent precision purely to keep float noise out of the
        // stored value; the rate itself is an estimate.
        amount: Math.round(buildSeconds * HOSTED_BUILD_USD_PER_SECOND * 1e6) / 1e6,
        service: HOSTED_BUILD_SERVICE,
        resourceId: runId,
        usageAmount: buildSeconds,
        usageUnit: "seconds",
      },
    ],
    source: {
      pluginId: DEPLOYMENT_COST_PLUGIN_ID,
      tag: { key: DEPLOYMENT_COST_TAG, value: runId },
      fallbackAccountId: deploymentCostAccountId(env),
      errorPrefix: "deployment build cost",
      maxRows: 1,
    },
  });
}

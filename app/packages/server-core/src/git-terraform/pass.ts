/**
 * The poller's work for Terraform workspaces of git.infrawrench.com, on the
 * gateway (it calls plugin code for whole inventories):
 *
 * 1. starts queued runs nothing started (`ci/terraform.ts`);
 * 2. links each workspace whose state changed to the organisation's
 *    resources (`link.ts`);
 * 3. prices the plans that are waiting for it (`plan-cost.ts`): the forge
 *    hands over what pricing needs of a plan once, and deletes it.
 *
 * Each step claims little per pass and logs its own failures, so a forge
 * that is away costs a pass nothing but a warning.
 */
import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";
import type { PlanPricingInputs, PlanSummary } from "@infrawrench/git-terraform";

import { startStrandedTerraformRuns, terraformRunUrls } from "../ci/terraform.js";
import { estimateResourceCost } from "../cost/estimate.js";
import { db } from "../db/client.js";
import {
  accounts,
  gitNamespaces,
  gitRepositories,
  gitTerraformRuns,
  gitTerraformWorkspaceAccounts,
  gitTerraformWorkspaces,
  type TerraformRunCostDelta,
} from "../db/schema.js";
import { loadCapabilities } from "../iac/service.js";
import { forgeFetch, runTerraformLinkPass } from "./link.js";
import { priceTerraformPlan } from "./plan-cost.js";

const NOTHING_PRICED: TerraformRunCostDelta = {
  monthlyDelta: null,
  currency: null,
  partial: false,
  pricedChanges: 0,
  unpricedChanges: 0,
};

/** Prices the plans whose inputs wait on the forge. Returns how many it settled. */
export async function runTerraformPlanCostPass(limit = 5): Promise<number> {
  const due = await db
    .select({
      id: gitTerraformRuns.id,
      planSummary: gitTerraformRuns.planSummary,
      workspaceId: gitTerraformWorkspaces.id,
      workspace: gitTerraformWorkspaces.name,
      organizationId: gitTerraformWorkspaces.organizationId,
      repositoryId: gitRepositories.id,
      repository: gitRepositories.name,
      namespace: gitNamespaces.slug,
    })
    .from(gitTerraformRuns)
    .innerJoin(gitTerraformWorkspaces, eq(gitTerraformWorkspaces.id, gitTerraformRuns.workspaceId))
    .innerJoin(gitRepositories, eq(gitRepositories.id, gitTerraformRuns.repositoryId))
    .innerJoin(gitNamespaces, eq(gitNamespaces.id, gitRepositories.namespaceId))
    .where(
      and(
        isNotNull(gitTerraformRuns.planSummary),
        isNull(gitTerraformRuns.costPricedAt),
        isNotNull(gitTerraformWorkspaces.organizationId),
        // What waits on the forge is not kept for ever, and neither is the wish to price it.
        sql`${gitTerraformRuns.createdAt} > now() - interval '2 days'`,
      ),
    )
    .orderBy(gitTerraformRuns.createdAt)
    .limit(limit);

  for (const run of due) {
    const organizationId = run.organizationId!;
    let delta: TerraformRunCostDelta = NOTHING_PRICED;
    try {
      const summary = run.planSummary as unknown as PlanSummary;
      const changes = summary.add + summary.change + summary.destroy;
      const linked = await db
        .select({ id: accounts.id, pluginId: accounts.pluginId })
        .from(gitTerraformWorkspaceAccounts)
        .innerJoin(accounts, eq(accounts.id, gitTerraformWorkspaceAccounts.accountId))
        .where(
          and(
            eq(gitTerraformWorkspaceAccounts.workspaceId, run.workspaceId),
            eq(accounts.organizationId, organizationId),
          ),
        );
      if (changes === 0) {
        delta = { ...NOTHING_PRICED, monthlyDelta: 0 };
      } else {
        // Read even when nothing can be priced: reading is what deletes the
        // inputs, and nothing with a plan's values in it should outlive its use.
        const { planUrl } = terraformRunUrls(run.namespace, run.repository, run.workspace, run.id);
        const response = await forgeFetch(run.repositoryId, planUrl);
        if (response.ok && linked.length === 0) {
          await response.body?.cancel();
          // No account to price through: every change is unpriced, and says so.
          delta = { ...NOTHING_PRICED, partial: true, unpricedChanges: changes };
        } else if (response.ok) {
          const inputs = (await response.json()) as PlanPricingInputs;
          delta = await priceTerraformPlan(organizationId, linked, inputs, {
            capabilities: await loadCapabilities(),
            estimate: estimateResourceCost,
          });
        } else {
          await response.body?.cancel();
          if (response.status !== 404) {
            throw new Error(`The forge answered ${response.status} for the plan of run ${run.id}`);
          }
          delta = { ...NOTHING_PRICED, partial: true, unpricedChanges: changes };
        }
      }
    } catch (err) {
      console.warn(`[terraform] could not price the plan of run ${run.id}:`, err);
      continue;
    }
    await db
      .update(gitTerraformRuns)
      .set({ costDelta: delta, costPricedAt: new Date() })
      .where(and(eq(gitTerraformRuns.id, run.id), isNull(gitTerraformRuns.costPricedAt)));
  }
  return due.length;
}

/** One tick of everything above. Each step's failure is its own. */
export async function runGitTerraformPass(): Promise<void> {
  for (const [name, step] of [
    ["start", () => startStrandedTerraformRuns()],
    ["link", () => runTerraformLinkPass()],
    ["price", () => runTerraformPlanCostPass()],
  ] as const) {
    try {
      await step();
    } catch (err) {
      console.warn(`[terraform] the ${name} step failed:`, err);
    }
  }
}

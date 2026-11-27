/**
 * The poller's work for Terraform workspaces of git.infrawrench.com, on the
 * gateway (it calls plugin code for whole inventories):
 *
 * 1. starts queued runs nothing started (`ci/terraform.ts`);
 * 2. links each workspace whose state changed to the organisation's
 *    resources (`link.ts`);
 * 3. prices the plans that are waiting for it (`plan-cost.ts`): the forge
 *    hands over what pricing needs of a plan once, and deletes it;
 * 4. prices the forge's scans of repositories' Terraform from their
 *    configuration (`config-cost.ts`): list prices, and the organisation's
 *    accounts where a plugin maps a type.
 *
 * Each step claims little per pass and logs its own failures, so a forge
 * that is away costs a pass nothing but a warning.
 */
import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";
import type {
  ConfigurationEstimate,
  ConfigurationPricingInputs,
  PlanPricingInputs,
  PlanSummary,
} from "@infrawrench/git-terraform";

import { startStrandedTerraformRuns, terraformRunUrls } from "../ci/terraform.js";
import { estimateResourceCost } from "../cost/estimate.js";
import { db } from "../db/client.js";
import {
  accounts,
  gitNamespaces,
  gitRepositories,
  gitTerraformRuns,
  gitTerraformScans,
  gitTerraformWorkspaceAccounts,
  gitTerraformWorkspaces,
  type TerraformRunCostDelta,
} from "../db/schema.js";
import { warehouseHostServices } from "../host-services.js";
import { loadCapabilities } from "../iac/service.js";
import { loadPlugins } from "../plugin-loader.js";
import { priceConfiguration } from "./config-cost.js";
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
        const response = await forgeFetch(
          { repositoryId: run.repositoryId, workspaceId: run.workspaceId },
          planUrl,
        );
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

/**
 * Prices the scans waiting for it, oldest first. A scan that fails stays
 * `pending` and is tried again on a later pass, for as long as it is seven
 * days old; after that nobody is waiting for it. Returns how many it settled.
 */
export async function runTerraformScanPricingPass(limit = 5): Promise<number> {
  const due = await db
    .select({
      id: gitTerraformScans.id,
      pricingInputs: gitTerraformScans.pricingInputs,
      organizationId: gitNamespaces.organizationId,
    })
    .from(gitTerraformScans)
    .innerJoin(gitRepositories, eq(gitRepositories.id, gitTerraformScans.repositoryId))
    .innerJoin(gitNamespaces, eq(gitNamespaces.id, gitRepositories.namespaceId))
    .where(
      and(
        eq(gitTerraformScans.pricingStatus, "pending"),
        sql`${gitTerraformScans.createdAt} > now() - interval '7 days'`,
      ),
    )
    .orderBy(gitTerraformScans.createdAt)
    .limit(limit);
  if (due.length === 0) return 0;

  const capabilities = await loadCapabilities();
  const names = new Map(
    (await loadPlugins()).map((loaded) => [
      loaded.plugin.manifest.id,
      loaded.plugin.manifest.displayName,
    ]),
  );
  const pricing = warehouseHostServices().instancePricing;
  let settled = 0;
  for (const scan of due) {
    try {
      const accountRows =
        scan.organizationId === null
          ? []
          : await db
              .select({ id: accounts.id, pluginId: accounts.pluginId })
              .from(accounts)
              .where(
                and(eq(accounts.organizationId, scan.organizationId), isNull(accounts.deletedAt)),
              )
              .orderBy(accounts.createdAt);
      const estimates: Record<string, ConfigurationEstimate> = {};
      let sourced = pricing !== undefined;
      for (const inputs of scan.pricingInputs as unknown as ConfigurationPricingInputs[]) {
        const priced = await priceConfiguration(scan.organizationId, inputs, {
          capabilities,
          estimate: estimateResourceCost,
          pricing,
          accounts: accountRows,
          pluginName: (pluginId) => names.get(pluginId) ?? pluginId,
        });
        estimates[inputs.root] = priced.estimate;
        if (priced.sourced) sourced = true;
      }
      await db
        .update(gitTerraformScans)
        .set({
          estimates: estimates as unknown as Record<string, Record<string, unknown>>,
          // No price source at all on this deployment: say so rather than show nothing priced.
          pricingStatus: sourced ? "priced" : "unavailable",
          pricedAt: new Date(),
        })
        .where(
          and(eq(gitTerraformScans.id, scan.id), eq(gitTerraformScans.pricingStatus, "pending")),
        );
      settled++;
    } catch (err) {
      console.warn(`[terraform] could not price the scan ${scan.id}:`, err);
    }
  }
  return settled;
}

/** One tick of everything above. Each step's failure is its own. */
export async function runGitTerraformPass(): Promise<void> {
  for (const [name, step] of [
    ["start", () => startStrandedTerraformRuns()],
    ["link", () => runTerraformLinkPass()],
    ["price", () => runTerraformPlanCostPass()],
    ["estimate", () => runTerraformScanPricingPass()],
  ] as const) {
    try {
      await step();
    } catch (err) {
      console.warn(`[terraform] the ${name} step failed:`, err);
    }
  }
}

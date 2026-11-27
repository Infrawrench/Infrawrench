/**
 * What a Terraform plan would change in monthly cost, priced from the plan
 * itself.
 *
 * The pull request check (`pr-checks/analyze.ts`) prices a change by reading
 * the HCL that changed, so it cannot see through modules, `for_each` or a
 * value set from a variable. A plan has already expanded all of that: each
 * resource instance, with its real attributes before and after. This prices
 * those with the same two pieces the check uses and nothing new:
 *
 * - **the derived attribute map** (`deriveTerraformAttributeFieldMap`: each
 *   plugin's export mapper run backwards) turns a planned instance's
 *   attributes into the fields its create form has;
 * - **`estimateResourceCost`**, the create form's estimator, prices them.
 *
 * The input is `@infrawrench/git-terraform`'s `planPricingInputs`: plain
 * scalar attributes the plan does not mark sensitive, and nothing else of the
 * plan. **Null is not zero**: a change that cannot be priced is counted in
 * `unpricedChanges` and makes the total `partial`, never smaller.
 *
 * Calls plugin code, so it runs on the gateway (`pass.ts`).
 */
import {
  deriveTerraformAttributeFieldMap,
  terraformAttributesToFields,
  type TerraformAttributeFieldMap,
} from "@infrawrench/client-core";
import type { PlanPricingChange, PlanPricingInputs } from "@infrawrench/git-terraform";
import type { CostEstimate } from "@infrawrench/plugin-base";

import type { EstimateCostInput } from "../cost/estimate.js";
import type { TerraformRunCostDelta } from "../db/schema.js";
import type { loadCapabilities } from "../iac/service.js";

/** One pricing call's budget; a slow pricing API costs a line, not the plan. */
const ESTIMATE_TIMEOUT_MS = 20_000;
/** Changes priced per plan: each is one or two provider pricing calls. */
export const MAX_PRICED_PLAN_CHANGES = 60;

export interface PlanCostDeps {
  capabilities: Awaited<ReturnType<typeof loadCapabilities>>;
  estimate: (organizationId: string, input: EstimateCostInput) => Promise<CostEstimate | null>;
}

/** An account a workspace links: what a planned resource of its plugin is priced through. */
export interface PlanCostAccount {
  id: string;
  pluginId: string;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * The monthly cost change of a plan's resource changes, priced through the
 * workspace's linked accounts. A resource of a provider no linked account
 * covers, of a type no plugin maps, or whose price the provider does not
 * answer is unpriced.
 */
export async function priceTerraformPlan(
  organizationId: string,
  accounts: readonly PlanCostAccount[],
  inputs: PlanPricingInputs,
  deps: PlanCostDeps,
): Promise<TerraformRunCostDelta> {
  const { capabilityFor, typeMap } = deps.capabilities;
  const accountByPlugin = new Map<string, string>();
  for (const account of accounts) {
    if (!accountByPlugin.has(account.pluginId)) accountByPlugin.set(account.pluginId, account.id);
  }
  const maps = new Map<string, TerraformAttributeFieldMap>();
  const mapFor = (pluginId: string, resourceTypeId: string): TerraformAttributeFieldMap => {
    const key = `${pluginId}/${resourceTypeId}`;
    let map = maps.get(key);
    if (!map) {
      map = deriveTerraformAttributeFieldMap(capabilityFor(pluginId), pluginId, resourceTypeId);
      maps.set(key, map);
    }
    return map;
  };

  /** A side's monthly cost; `undefined` when it exists and could not be priced. */
  const side = async (
    change: PlanPricingChange,
    attributes: PlanPricingChange["before"],
  ): Promise<CostEstimate | null | undefined> => {
    if (attributes === null) return null;
    const mapping = (typeMap.byTerraformType.get(change.type) ?? []).find((m) =>
      accountByPlugin.has(m.pluginId),
    );
    if (!mapping) return undefined;
    const fields = terraformAttributesToFields(
      mapFor(mapping.pluginId, mapping.resourceTypeId),
      attributes,
    );
    const estimate = await withTimeout(
      deps
        .estimate(organizationId, {
          accountId: accountByPlugin.get(mapping.pluginId)!,
          resourceTypeId: mapping.resourceTypeId,
          fields,
        })
        .catch(() => null),
      ESTIMATE_TIMEOUT_MS,
    );
    return estimate ?? undefined;
  };

  const byCurrency = new Map<string, number>();
  let priced = 0;
  let unpriced = inputs.omitted;
  for (const [index, change] of inputs.changes.entries()) {
    if (index >= MAX_PRICED_PLAN_CHANGES) {
      unpriced++;
      continue;
    }
    const [before, after] = await Promise.all([
      side(change, change.before),
      side(change, change.after),
    ]);
    if (before === undefined || after === undefined) {
      unpriced++;
      continue;
    }
    const currency = after?.currency ?? before?.currency;
    if (!currency || (before && after && before.currency !== after.currency)) {
      unpriced++;
      continue;
    }
    const delta = (after?.monthlyAmount ?? 0) - (before?.monthlyAmount ?? 0);
    byCurrency.set(currency, (byCurrency.get(currency) ?? 0) + delta);
    priced++;
  }

  // One total, in the currency most changes are priced in; another currency's
  // changes are missing from it, which `partial` says.
  let winner: [string, number] | null = null;
  for (const entry of byCurrency) {
    if (!winner || Math.abs(entry[1]) > Math.abs(winner[1])) winner = entry;
  }
  return {
    monthlyDelta: winner ? Number(winner[1].toFixed(2)) : null,
    currency: winner ? winner[0] : null,
    partial: unpriced > 0 || byCurrency.size > 1,
    pricedChanges: priced,
    unpricedChanges: unpriced,
  };
}

/**
 * What the Terraform workspaces of git.infrawrench.com manage, read from
 * `git_terraform_managed_resources` (written by `link.ts`).
 *
 * Two readers:
 *
 * - {@link managedByForResource}: which repository and root manage one
 *   Infrawrench resource, for the app's resource page.
 * - {@link managedResourceCosts}: what the resources a workspace manages cost,
 *   for the forge's Infrastructure tab. **It reads cost through the caller's
 *   cost visibility** (`resolveCostVisibility`), like every other cost read:
 *   someone limited to part of the organisation's spend gets the part they
 *   may see, and never a total that includes the rest.
 *
 * Edge-safe: Postgres only, no plugin code.
 */
import { and, eq, inArray, isNotNull } from "drizzle-orm";

import { db } from "../db/client.js";
import {
  gitNamespaces,
  gitRepositories,
  gitTerraformManagedResources,
  gitTerraformWorkspaces,
} from "../db/schema.js";
import { terraformWorkspaceUrl } from "../ci/terraform.js";

/** One workspace that manages a resource: the app's "Managed by" line. */
export interface IacManagedBy {
  /** `<namespace>/<repository>` on git.infrawrench.com. */
  repository: string;
  /** The Terraform root, relative to the repository; empty for its top. */
  rootPath: string;
  workspace: string;
  /** The resource's address in that workspace's state. */
  address: string;
  /** The workspace's page on the forge. */
  url: string;
}

/**
 * The forge workspaces whose current state holds this resource. Usually one;
 * more when two states import the same thing, which is worth seeing.
 */
export async function managedByForResource(
  organizationId: string,
  resourceId: string,
): Promise<IacManagedBy[]> {
  const rows = await db
    .select({
      address: gitTerraformManagedResources.address,
      workspace: gitTerraformWorkspaces.name,
      rootPath: gitTerraformWorkspaces.rootPath,
      repository: gitRepositories.name,
      namespace: gitNamespaces.slug,
    })
    .from(gitTerraformManagedResources)
    .innerJoin(
      gitTerraformWorkspaces,
      eq(gitTerraformWorkspaces.id, gitTerraformManagedResources.workspaceId),
    )
    .innerJoin(gitRepositories, eq(gitRepositories.id, gitTerraformWorkspaces.repositoryId))
    .innerJoin(gitNamespaces, eq(gitNamespaces.id, gitRepositories.namespaceId))
    .where(
      and(
        eq(gitTerraformManagedResources.organizationId, organizationId),
        eq(gitTerraformManagedResources.resourceId, resourceId),
        // The link is the workspace's organisation's: a namespace moved to
        // another organisation takes no one else's resources with it.
        eq(gitTerraformWorkspaces.organizationId, organizationId),
      ),
    )
    .limit(20);
  return rows
    .map((row) => ({
      repository: `${row.namespace}/${row.repository}`,
      rootPath: row.rootPath,
      workspace: row.workspace,
      address: row.address,
      url: terraformWorkspaceUrl(row.namespace, row.repository, row.workspace),
    }))
    .sort((a, b) =>
      `${a.repository}/${a.workspace}/${a.address}`.localeCompare(
        `${b.repository}/${b.workspace}/${b.address}`,
      ),
    );
}

/** Who is asking for costs, as cost visibility resolves them. */
export interface CostViewer {
  userId: string;
  apiKeyId?: string | null | undefined;
}

export interface ManagedCost {
  amount: number;
  currency: string;
}

export interface ManagedResourceCosts {
  /** By Infrawrench resource id: the last thirty days' spend the viewer may see. */
  byResourceId: Map<string, ManagedCost>;
  /** By workspace id: the sum over its matched resources, in the currency most of it is in. */
  byWorkspaceId: Map<string, ManagedCost>;
  /** Matched resources per workspace, whether or not they have a cost. */
  matchedByWorkspaceId: Map<string, number>;
}

const DAY_MS = 24 * 60 * 60_000;
const day = (at: number): string => new Date(at).toISOString().slice(0, 10);

/** The window a "monthly cost" is read over: the thirty days up to yesterday. */
export function monthlyCostWindow(now: number = Date.now()): { from: string; to: string } {
  return { from: day(now - 30 * DAY_MS), to: day(now - DAY_MS) };
}

/**
 * Monthly cost of what these workspaces manage, per workspace and per matched
 * resource, as `viewer` may see it. With `viewer` null (a caller who may not
 * see costs at all) no cost is read: only the matched counts are answered.
 *
 * The caller has already checked `costs:read`; this applies the narrower
 * limits a role, a person or an API key may carry on top of it.
 */
export async function managedResourceCosts(
  organizationId: string,
  workspaceIds: readonly string[],
  viewer: CostViewer | null,
  now: number = Date.now(),
): Promise<ManagedResourceCosts> {
  const out: ManagedResourceCosts = {
    byResourceId: new Map(),
    byWorkspaceId: new Map(),
    matchedByWorkspaceId: new Map(),
  };
  if (workspaceIds.length === 0) return out;
  const { resources } = await import("../db/schema.js");
  const links = await db
    .select({
      workspaceId: gitTerraformManagedResources.workspaceId,
      resourceId: resources.id,
      accountId: resources.accountId,
      externalId: resources.externalId,
    })
    .from(gitTerraformManagedResources)
    .innerJoin(
      resources,
      and(
        eq(resources.id, gitTerraformManagedResources.resourceId),
        eq(resources.organizationId, organizationId),
      ),
    )
    .where(
      and(
        eq(gitTerraformManagedResources.organizationId, organizationId),
        inArray(gitTerraformManagedResources.workspaceId, [...workspaceIds]),
        isNotNull(gitTerraformManagedResources.resourceId),
      ),
    );
  for (const link of links) {
    out.matchedByWorkspaceId.set(
      link.workspaceId,
      (out.matchedByWorkspaceId.get(link.workspaceId) ?? 0) + 1,
    );
  }
  const priced = links.filter((link) => link.externalId);
  if (viewer === null || priced.length === 0) return out;

  const [{ resolveCostVisibility }, { runWithCostVisibility }, { getResourceCostWindows }] =
    await Promise.all([
      import("../cost/visibility.js"),
      import("../cost/visibility-context.js"),
      import("../analytics/cost-readers.js"),
    ]);
  const visibility = await resolveCostVisibility(organizationId, viewer);
  const rows = await runWithCostVisibility(visibility, () =>
    getResourceCostWindows(organizationId, [monthlyCostWindow(now)], {
      accountIds: [...new Set(priced.map((link) => link.accountId))],
      resourceIds: [...new Set(priced.map((link) => link.externalId!))],
    }),
  );

  // A provider's id is only unique within its account.
  const spend = new Map<string, Map<string, number>>();
  for (const row of rows) {
    const amount = row.amounts[0] ?? 0;
    if (amount === 0) continue;
    const key = `${row.accountId}\u0000${row.resourceId}`;
    const byCurrency = spend.get(key) ?? new Map<string, number>();
    byCurrency.set(row.currency, (byCurrency.get(row.currency) ?? 0) + amount);
    spend.set(key, byCurrency);
  }
  const largest = (byCurrency: Map<string, number>): ManagedCost | null => {
    let best: ManagedCost | null = null;
    for (const [currency, amount] of byCurrency) {
      if (!best || Math.abs(amount) > Math.abs(best.amount)) best = { currency, amount };
    }
    return best ? { currency: best.currency, amount: Number(best.amount.toFixed(2)) } : null;
  };

  const totals = new Map<string, Map<string, number>>();
  for (const link of priced) {
    const byCurrency = spend.get(`${link.accountId}\u0000${link.externalId}`);
    if (!byCurrency) continue;
    const cost = largest(byCurrency);
    if (cost) out.byResourceId.set(link.resourceId, cost);
    const total = totals.get(link.workspaceId) ?? new Map<string, number>();
    for (const [currency, amount] of byCurrency) {
      total.set(currency, (total.get(currency) ?? 0) + amount);
    }
    totals.set(link.workspaceId, total);
  }
  for (const [workspaceId, byCurrency] of totals) {
    const cost = largest(byCurrency);
    if (cost) out.byWorkspaceId.set(workspaceId, cost);
  }
  return out;
}

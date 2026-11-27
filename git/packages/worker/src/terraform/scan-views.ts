/**
 * A Terraform scan row as the API shows it, and a branch page's cost change
 * from configuration. Plain values in, contract shapes out; no database, so
 * the rules are tested on their own.
 */
import type {
  TerraformConfigurationEstimate,
  TerraformConfigurationRootChange,
  TerraformRoot,
  TerraformScan,
} from "@infrawrench/git-contract";
import {
  type ConfigurationEstimate,
  type TerraformRootSummary,
  type TerraformScanSummary,
  compareConfigurationEstimates,
  suggestWorkspaceName,
} from "@infrawrench/git-terraform";
import type { GitTerraformScanPricingStatus } from "@infrawrench/server-core/db/schema";

/** What a view needs of a scan row. */
export interface ScanRowView {
  readonly commitOid: string;
  readonly summary: TerraformScanSummary;
  readonly estimates: Readonly<Record<string, ConfigurationEstimate>> | null;
  readonly pricingStatus: GitTerraformScanPricingStatus;
  readonly pricedAt: Date | null;
  readonly createdAt: Date;
}

/** What a view needs of a workspace. */
export interface WorkspaceOnRoot {
  readonly id: string;
  readonly name: string;
  readonly rootPath: string;
}

const NO_ESTIMATE = {
  currency: null,
  monthlyTotal: null,
  complete: false,
  lines: [],
  unpriced: [],
  others: [],
} as const;

/** A root's estimate as the API shows it: pending, priced, or unavailable. */
export function estimateView(row: ScanRowView, path: string): TerraformConfigurationEstimate {
  if (row.pricingStatus === "pending") {
    return { status: "pending", ...NO_ESTIMATE, pricedAt: null };
  }
  const estimate = row.estimates?.[path];
  if (row.pricingStatus === "unavailable" || !estimate) {
    return {
      status: "unavailable",
      ...NO_ESTIMATE,
      pricedAt: row.pricedAt?.toISOString() ?? null,
    };
  }
  return {
    status: "priced",
    currency: estimate.currency,
    monthlyTotal: estimate.monthlyTotal,
    complete: estimate.complete,
    lines: estimate.lines,
    unpriced: estimate.unpriced,
    others: estimate.others,
    pricedAt: row.pricedAt?.toISOString() ?? null,
  };
}

const rootView = (
  row: ScanRowView,
  root: TerraformRootSummary,
  workspaces: readonly WorkspaceOnRoot[],
): TerraformRoot => {
  const taken = workspaces.map((workspace) => workspace.name);
  return {
    path: root.path,
    // Discovery's reasons for a root; a module's never reach a root.
    reasons: root.reasons.filter(
      (reason): reason is TerraformRoot["reasons"][number] =>
        reason === "backend" || reason === "provider-block" || reason === "unreferenced",
    ),
    workspaces: workspaces
      .filter((workspace) => workspace.rootPath === root.path)
      .map((workspace) => workspace.name),
    suggestedWorkspace: suggestWorkspaceName(root.path, taken),
    backend: root.backend,
    requiredVersion: root.requiredVersion,
    providers: root.providers,
    modules: root.modules,
    localModules: root.localModules,
    resourceCount: root.resourceCount,
    dataSourceCount: root.dataSourceCount,
    resourceTypes: root.resourceTypes,
    variableCount: root.variableCount,
    requiredVariables: root.requiredVariables,
    outputCount: root.outputCount,
    lockFile: root.lockFile,
    tfvarsFiles: root.tfvarsFiles,
    usesWorkspace: root.usesWorkspace,
    unreadable: root.unreadable,
    // A row written before the scanner counted these has neither.
    inactiveResources: root.inactiveResources ?? 0,
    inactiveAddresses: root.inactiveAddresses ?? [],
    estimate: estimateView(row, root.path),
  };
};

/** A scan row as `terraform.scan` answers it. `commitOid` is the commit asked about. */
export function scanView(
  row: ScanRowView,
  commitOid: string,
  workspaces: readonly WorkspaceOnRoot[],
): TerraformScan {
  return {
    commitOid,
    roots: row.summary.roots.map((root) => rootView(row, root, workspaces)),
    moduleCount: row.summary.moduleCount,
    truncated: row.summary.truncated,
    scannedAt: row.createdAt.toISOString(),
  };
}

/** What the plan-wins rule needs of a run. */
export interface PageRun {
  readonly workspaceId: string;
  readonly commitSha: string;
  readonly pullNumber: number | null;
  readonly hasPlan: boolean;
}

/**
 * The roots a Terraform plan has priced for a branch page's head: a run of a
 * workspace on the root, for this page, at its head, with a plan. There the
 * plan's cost card is the answer and the estimate from configuration is not
 * shown, so a root never has two numbers.
 */
export function rootsPlannedAtHead(
  workspaces: readonly WorkspaceOnRoot[],
  runs: readonly PageRun[],
  page: { readonly number: number; readonly headOid: string },
): Set<string> {
  const rootOf = new Map(workspaces.map((workspace) => [workspace.id, workspace.rootPath]));
  const planned = new Set<string>();
  for (const run of runs) {
    if (!run.hasPlan || run.commitSha !== page.headOid || run.pullNumber !== page.number) continue;
    const root = rootOf.get(run.workspaceId);
    if (root !== undefined) planned.add(root);
  }
  return planned;
}

/**
 * One root's change from configuration: pending while either side is, else
 * the comparison of the two estimates (a side with no root is no estimate).
 */
export function rootChangeView(
  path: string,
  base: ScanRowView | null,
  head: ScanRowView,
  workspaces: readonly WorkspaceOnRoot[],
): TerraformConfigurationRootChange {
  const workspace = workspaces.find((each) => each.rootPath === path)?.name ?? null;
  const pending = head.pricingStatus === "pending" || base?.pricingStatus === "pending";
  const empty = {
    path,
    workspace,
    currency: null,
    monthlyBefore: null,
    monthlyAfter: null,
    monthlyDelta: null,
    complete: false,
    lines: [],
    unpriced: [],
  };
  if (pending) return { ...empty, status: "pending" };
  const side = (row: ScanRowView | null): ConfigurationEstimate | null | undefined => {
    if (row === null) return null;
    const hasRoot = row.summary.roots.some((root) => root.path === path);
    if (!hasRoot) return null;
    if (row.pricingStatus === "unavailable") return undefined;
    return row.estimates?.[path] ?? undefined;
  };
  const before = side(base);
  const after = side(head);
  if (before === undefined || after === undefined) return { ...empty, status: "unavailable" };
  const change = compareConfigurationEstimates(before, after);
  return {
    path,
    workspace,
    status: "priced",
    currency: change.currency,
    monthlyBefore: change.monthlyBefore,
    monthlyAfter: change.monthlyAfter,
    monthlyDelta: change.monthlyDelta,
    complete: change.complete,
    lines: change.lines,
    unpriced: change.unpriced,
  };
}

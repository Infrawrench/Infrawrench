/**
 * The pure part of the Infrastructure tab's detected configurations and the
 * branch page's estimate from configuration: what each state reads as, and
 * the text a person copies to move a root's state here.
 */
import type {
  TerraformConfigurationChange,
  TerraformConfigurationEstimate,
  TerraformConfigurationOther,
  TerraformRoot,
  TerraformScan,
} from "@infrawrench/git-contract";
import { formatMoney } from "../../lib/amounts";

/** A root's path as shown: the repository's top is `/`. */
export const rootLabel = (path: string): string => (path === "" ? "/" : path);

/** What the tab shows as a whole, from the workspaces and the scan. */
export type InfrastructureView = "loading" | "empty" | "configurations" | "workspaces" | "mixed";

export function infrastructureView(
  workspaceCount: number,
  scan: Pick<TerraformScan, "roots"> | undefined,
  scanSettled: boolean,
): InfrastructureView {
  const roots = scan?.roots.length ?? 0;
  if (workspaceCount === 0 && !scanSettled) return "loading";
  if (workspaceCount === 0 && roots === 0) return "empty";
  if (workspaceCount === 0) return "configurations";
  const bare = scan?.roots.filter((root) => root.workspaces.length === 0).length ?? 0;
  return bare > 0 ? "mixed" : "workspaces";
}

/** The estimate's figure as a line of the table. */
export function estimateFigure(estimate: TerraformConfigurationEstimate): string {
  if (estimate.status === "pending") return "Estimating";
  if (estimate.status === "unavailable") return "Not priced";
  if (estimate.monthlyTotal === null || estimate.currency === null) {
    return estimate.unpriced.length > 0 ? "Not priced" : "Nothing priced";
  }
  return formatMoney(estimate.monthlyTotal, estimate.currency);
}

/** Whether a scan should be asked again: an estimate is still being worked out. */
export const scanPending = (scan: Pick<TerraformScan, "roots"> | undefined): boolean =>
  scan?.roots.some((root) => root.estimate.status === "pending") ?? false;

export const changePending = (
  change: Pick<TerraformConfigurationChange, "roots"> | undefined,
): boolean => change?.roots.some((root) => root.status === "pending") ?? false;

export const OTHER_KIND_LABELS: Record<TerraformConfigurationOther["kind"], string> = {
  usage: "Billed by usage",
  free: "No charge of its own",
  unknown: "No price data",
};

/** `others` by kind, in the order the labels above are listed, each by count. */
export function othersByKind(
  others: ReadonlyArray<TerraformConfigurationOther>,
): Array<{ kind: TerraformConfigurationOther["kind"]; total: number; types: string[] }> {
  return (["usage", "free", "unknown"] as const)
    .map((kind) => {
      const items = others
        .filter((other) => other.kind === kind)
        .sort((a, b) => b.count - a.count || a.type.localeCompare(b.type));
      return {
        kind,
        total: items.reduce((sum, item) => sum + item.count, 0),
        types: items.map((item) => (item.count > 1 ? `${item.type} × ${item.count}` : item.type)),
      };
    })
    .filter((group) => group.total > 0);
}

/** The state moves here with `-migrate-state` unless the root already uses this backend. */
export function migrationCommand(root: Pick<TerraformRoot, "backend">): string {
  return root.backend?.type === "http"
    ? "terraform init -reconfigure"
    : "terraform init -migrate-state";
}

/** Where the state is now, in words. */
export function stateLocation(root: Pick<TerraformRoot, "backend">): string {
  if (root.backend === null) return "Local state";
  const setting = (name: string) =>
    root.backend!.settings.find((item) => item.name === name)?.value ?? null;
  // An address is long: its host says where.
  const address = setting("address");
  let host: string | null = null;
  if (address !== null) {
    try {
      host = new URL(address).host;
    } catch {
      host = null;
    }
  }
  const where = setting("bucket") ?? setting("organization") ?? host;
  return where === null ? root.backend.type : `${root.backend.type} · ${where}`;
}

/** The workspace name the setup instructions are for: an existing one, else the suggestion. */
export const setupWorkspaceName = (
  root: Pick<TerraformRoot, "workspaces" | "suggestedWorkspace">,
) => root.workspaces[0] ?? root.suggestedWorkspace;

/** By path, the way the tree lists them. */
export const sortedRoots = (roots: ReadonlyArray<TerraformRoot>): TerraformRoot[] =>
  [...roots].sort((a, b) => a.path.localeCompare(b.path));

/** The heading over what a root's own values switch off. */
export const inactiveTitle = (count: number): string => `${count} switched off by default values`;

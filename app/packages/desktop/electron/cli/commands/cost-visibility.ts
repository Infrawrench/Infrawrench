import { CliError, orgFetch, resolveOrg, type CliContext } from "../context";
import type { CostVisibilityScope, CostVisibilitySummary } from "@infrawrench/client-core" with {
  "resolution-mode": "import",
};
import { c, printJson, println, printTable, type Column } from "../output";

interface MeResponse {
  email: string | null;
  costVisibility?: CostVisibilitySummary;
}

function kindLabel(kind: string): string {
  return kind === "api_key" ? "API key" : kind;
}

function describe(scope: {
  costCentreIds: string[];
  accountIds: string[];
  savedFilterId: string | null;
}): string {
  const parts: string[] = [];
  if (scope.costCentreIds.length > 0) parts.push(`${scope.costCentreIds.length} cost centre(s)`);
  if (scope.accountIds.length > 0) parts.push(`${scope.accountIds.length} account(s)`);
  const base = parts.join(" or ");
  if (scope.savedFilterId) return base ? `${base}, filtered` : "saved filter only";
  return base || c.red("nothing (sees no costs)");
}

/**
 * `infrawrench cost-visibility`: who is limited to which costs.
 *
 * `cost-visibility` lists every scope in the org (needs `team:read`);
 * `cost-visibility me` says whether *your* cost figures are narrowed, which
 * is the first thing to check when the CLI's totals disagree with a
 * colleague's. Read-only: scopes are edited with pickers in Settings → Cost
 * Visibility, or with Terraform.
 */
export async function cmdCostVisibility(ctx: CliContext, rest: string[]): Promise<void> {
  const org = await resolveOrg(ctx);
  const sub = rest[0];
  if (sub !== undefined && sub !== "list" && sub !== "me") {
    throw new CliError(`Unknown subcommand "${sub}". Try: cost-visibility, cost-visibility me`);
  }

  if (sub === "me") {
    const me = await orgFetch<MeResponse>(org.id, "/team/me");
    const summary = me.costVisibility ?? { restricted: false, sources: [] };
    if (ctx.flags.output === "json") {
      printJson({ org: org.id, costVisibility: summary });
      return;
    }
    if (!summary.restricted) {
      println(`${c.bold(org.displayName)} ${c.dim("· you see all of the organization's costs")}`);
      return;
    }
    println(
      `${c.bold(org.displayName)} ${c.yellow("· your cost figures are scoped")} ${c.dim(
        "(every layer below must match a cost row)",
      )}`,
    );
    println();
    printTable(summary.sources, [
      { header: "from", value: (s) => kindLabel(s.kind) },
      { header: "name", value: (s) => s.label ?? c.dim("unknown") },
      { header: "sees", value: (s) => describe(s) },
    ]);
    return;
  }

  const { scopes } = await orgFetch<{ scopes: CostVisibilityScope[] }>(org.id, "/cost-visibility");
  if (ctx.flags.output === "json") {
    printJson({ org: org.id, scopes });
    return;
  }
  if (scopes.length === 0) {
    println(c.dim("No cost visibility scopes. Everyone with cost access sees all spend."));
    return;
  }
  const columns: Column<CostVisibilityScope>[] = [
    { header: "kind", value: (s) => kindLabel(s.principalKind) },
    { header: "applies to", value: (s) => s.principalLabel ?? c.dim("deleted") },
    { header: "sees", value: (s) => describe(s) },
    { header: "updated", value: (s) => c.dim(s.updatedAt.slice(0, 10)) },
  ];
  println(`${c.bold(org.displayName)} ${c.dim(`· ${scopes.length} scope(s)`)}`);
  println();
  printTable(scopes, columns);
  println();
  println(c.dim("Edit scopes in Settings → Cost Visibility."));
}

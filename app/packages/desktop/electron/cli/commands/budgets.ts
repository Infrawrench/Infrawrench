// `infrawrench budgets`: every budget in the org as the same tree the Costs
// panel draws, each level showing its own actual and forecast against its own
// limit for its current period. Spend budgets print money, usage budgets
// print their unit; a parent is the sum of its children and says so. Read-only:
// budgets page people, and authoring one belongs in a form (web, desktop,
// mobile), the API, the MCP tools or the Terraform provider.
import { CliError, orgFetch, resolveOrg, type CliContext } from "../context";
import type { BudgetWithStatus } from "@infrawrench/client-core" with {
  "resolution-mode": "import",
};
import { c, printJson, println } from "../output";
import {
  budgetBar,
  budgetFigures,
  formatBudgetPeriod,
  formatBudgetValue,
  formatBudgetWarning,
  orderBudgetTree,
} from "../format";

export async function cmdBudgets(ctx: CliContext): Promise<void> {
  if (ctx.flags.local) {
    throw new CliError("Budgets evaluate your org's collected cloud spend — cloud mode only.");
  }
  const org = await resolveOrg(ctx);
  const budgets = (await orgFetch<BudgetWithStatus[]>(org.id, "/budgets")) ?? [];

  if (ctx.flags.output === "json") {
    printJson({ org: org.id, budgets });
    return;
  }

  println(`${c.bold(org.displayName)} ${c.dim("· budgets")}`);
  println();
  if (budgets.length === 0) {
    println(
      c.dim(
        "No budgets yet. Create one from the Costs panel or a dashboard in the app: a budget limits spend or a usage quantity per period and alerts on actual or forecast crossings.",
      ),
    );
    return;
  }

  const ordered = orderBudgetTree(budgets);
  const nameWidth = Math.min(
    40,
    Math.max(...ordered.map(({ row, depth }) => row.name.length + depth * 2)),
  );
  for (const { row, depth } of ordered) {
    const fig = budgetFigures(row);
    const indent = "  ".repeat(depth);
    const name = `${indent}${row.name}`.slice(0, nameWidth).padEnd(nameWidth);
    const amounts =
      fig.limit !== null
        ? `${formatBudgetValue(row, fig.actual)} / ${formatBudgetValue(row, fig.limit)}`
        : formatBudgetValue(row, fig.actual);
    const pct = fig.percent !== null ? `${fig.percent.toFixed(0).padStart(4)}%` : "     ";
    const forecast =
      fig.forecast !== null ? c.dim(` fc ${formatBudgetValue(row, fig.forecast)}`) : "";
    const flags = [
      row.measure === "usage" ? c.cyan("usage") : null,
      row.rolledUp ? c.dim("Σ children") : null,
      row.currentMonthEvents.length > 0 ? c.red("alert") : null,
    ]
      .filter((f) => f !== null)
      .join(" ");
    println(
      `${name}  ${budgetBar(fig.percent)} ${pct}  ${amounts}${forecast}  ${c.dim(formatBudgetPeriod(row))}${flags ? `  ${flags}` : ""}`,
    );
    for (const warning of row.hierarchyWarnings ?? []) {
      println(`${" ".repeat(nameWidth + 2)}${c.yellow(`⚠ ${formatBudgetWarning(row, warning)}`)}`);
    }
  }
}

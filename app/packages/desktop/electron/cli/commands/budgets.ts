// `infrawrench budgets`: every budget in the org as the same tree the Costs
// panel draws, each level showing its own actual and forecast against its own
// limit for its current period, plus one budget's alert history and the note
// that explains a firing. Spend budgets print money, usage budgets print their
// unit; a parent is the sum of its children and says so.
//
// A budget alert is usually read in a chat channel; the person who knows why
// it fired is often at a terminal. `budgets annotate` lets them say so without
// opening the app, and the note lands where the alert did (as a Slack thread
// reply, a Teams follow-up), on the budget, and on every cost chart at that day.
// Authoring a budget itself belongs in a form (web, desktop, mobile), the API,
// the MCP tools or the Terraform provider.
//
// Wire types come from `@infrawrench/client-core`, type-only, so the CLI still
// ships zero new runtime dependencies.
import { CliError, orgFetch, resolveOrg, type CliContext } from "../context";
import type {
  BudgetAlertEvent,
  BudgetAlertNoteResult,
  BudgetWithStatus,
} from "@infrawrench/client-core" with {
  "resolution-mode": "import",
};
import type { BulkFlags } from "../args";
import { c, printJson, println, printTable, safe } from "../output";
import {
  budgetBar,
  budgetFigures,
  formatBudgetPeriod,
  formatBudgetValue,
  formatBudgetWarning,
  matchCostReport,
  orderBudgetTree,
} from "../format";

function requireCloud(ctx: CliContext): void {
  if (ctx.flags.local) {
    throw new CliError("Budgets live in Infrawrench Cloud; there is no local budget store.");
  }
}

/** Resolve a name/id query to exactly one budget, or a helpful error. */
async function resolveBudget(orgId: string, query: string): Promise<BudgetWithStatus> {
  const budgets = (await orgFetch<BudgetWithStatus[]>(orgId, "/budgets")) ?? [];
  // Same matching rules as `reports <name|id>`: id, exact name, unique substring.
  const found = matchCostReport(budgets, query);
  if (found.match) return found.match;
  if (found.candidates.length === 0) {
    throw new CliError(`No budget matches "${query}". Run \`infrawrench budgets\` to list them.`);
  }
  throw new CliError(
    `"${query}" matches ${found.candidates.length} budgets: ${found.candidates
      .map((b) => b.name)
      .join(", ")}. Use the full name or the id.`,
  );
}

/** `"actual 80%"` / `"forecast 100%"`. */
function describeThreshold(e: Pick<BudgetAlertEvent, "thresholdType" | "thresholdPercent">) {
  return `${e.thresholdType} ${e.thresholdPercent}%`;
}

/** `"Q3 load test (Astrid, 2026-10-03)"`, or a dim dash when there is none. */
function describeNote(note: BudgetAlertEvent["note"] | undefined): string {
  if (!note) return c.dim("—");
  const who = note.notedByName ? `${safe(note.notedByName)}, ` : "";
  return `${safe(note.text)} ${c.dim(`(${who}${note.notedAt.slice(0, 10)})`)}`;
}

/**
 * `infrawrench budgets [name|id]`: every budget as a tree with this period's
 * status, or one budget's alert history with the note on each firing.
 */
export async function cmdBudgets(ctx: CliContext, query = ""): Promise<void> {
  requireCloud(ctx);
  const org = await resolveOrg(ctx);

  if (query.trim()) {
    const budget = await resolveBudget(org.id, query.trim());
    const events =
      (await orgFetch<BudgetAlertEvent[]>(
        org.id,
        `/budgets/${encodeURIComponent(budget.id)}/events`,
      )) ?? [];
    if (ctx.flags.output === "json") {
      printJson({ org: org.id, budget, events });
      return;
    }
    const fig = budgetFigures(budget);
    const amounts =
      fig.limit !== null
        ? `${formatBudgetValue(budget, fig.actual)} ${c.dim(`of ${formatBudgetValue(budget, fig.limit)}`)}`
        : formatBudgetValue(budget, fig.actual);
    const pct = fig.percent !== null ? ` ${fig.percent.toFixed(0)}%` : "";
    println(
      `${c.bold(safe(budget.name))} ${c.dim(`· ${formatBudgetPeriod(budget)}`)}  ${amounts}  ${budgetBar(fig.percent)}${pct}`,
    );
    println();
    if (events.length === 0) {
      println(c.dim("No thresholds have fired for this budget."));
      return;
    }
    const usage = budget.measure === "usage";
    printTable(events, [
      { header: "fired", value: (e) => e.triggeredAt.slice(0, 10) },
      { header: "threshold", value: (e) => describeThreshold(e) },
      {
        header: usage ? "usage" : "spend",
        // The figure at the crossing, in the budget's own unit: cents for a
        // spend budget, the quantity for a usage budget (its cents are 0).
        value: (e) => {
          const forecast = e.thresholdType === "forecast";
          const value = usage
            ? forecast
              ? (e.forecastUsage ?? e.actualUsage)
              : e.actualUsage
            : forecast
              ? (e.forecastAmountCents ?? e.actualAmountCents)
              : e.actualAmountCents;
          return value === null || value === undefined
            ? c.dim("—")
            : formatBudgetValue(budget, value);
        },
        align: "right",
      },
      { header: "note", value: (e) => describeNote(e.note) },
      { header: "event", value: (e) => c.dim(e.id) },
    ]);
    println();
    println(
      c.dim(
        `Explain a firing with \`infrawrench budgets annotate "${budget.name}" --note "<why>" [--event <id>]\`.`,
      ),
    );
    return;
  }

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
      // An alert with a note is answered; one without is still somebody's
      // open question.
      row.currentMonthEvents.some((e) => !e.note)
        ? c.dim(`${row.currentMonthEvents.filter((e) => !e.note).length} unexplained`)
        : null,
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
  println();
  println(c.dim('One budget\'s alert history and notes: `infrawrench budgets "<name>"`.'));
}

/**
 * `infrawrench budgets annotate <name|id> --note <text> [--event <id>]`:
 * explain a fired alert. Defaults to the most recent firing, which is the one
 * somebody is almost always asking about.
 */
export async function cmdBudgetAnnotate(
  ctx: CliContext,
  query: string,
  flags: BulkFlags,
): Promise<void> {
  requireCloud(ctx);
  if (!query.trim()) {
    throw new CliError(
      'Which budget? `infrawrench budgets annotate <name|id> --note "<why it fired>"`.',
      2,
    );
  }
  const note = flags.note?.trim();
  if (!note) throw new CliError('Add the note: `--note "<why it fired>"`.', 2);

  const org = await resolveOrg(ctx);
  const budget = await resolveBudget(org.id, query.trim());
  const events =
    (await orgFetch<BudgetAlertEvent[]>(
      org.id,
      `/budgets/${encodeURIComponent(budget.id)}/events`,
    )) ?? [];
  if (events.length === 0) {
    throw new CliError(
      `"${budget.name}" has not fired any alerts yet, so there is nothing to explain.`,
    );
  }
  const event = flags.event
    ? events.find((e) => e.id === flags.event || e.id.startsWith(flags.event!))
    : events[0];
  if (!event) {
    throw new CliError(
      `No firing "${flags.event}" on "${budget.name}". Run \`infrawrench budgets "${budget.name}"\` for event ids.`,
    );
  }

  const result = await orgFetch<BudgetAlertNoteResult>(
    org.id,
    `/budgets/${encodeURIComponent(budget.id)}/events/${encodeURIComponent(event.id)}/note`,
    { method: "POST", body: JSON.stringify({ note }) },
  );

  if (ctx.flags.output === "json") {
    printJson({ org: org.id, budget: { id: budget.id, name: budget.name }, event: result });
    return;
  }
  println(
    `${c.green("✓")} ${c.bold(safe(budget.name))} ${c.dim(
      `· ${describeThreshold(result)} on ${result.triggeredAt.slice(0, 10)}`,
    )}`,
  );
  println(`  ${describeNote(result.note)}`);
  const where: string[] = [];
  if (result.followUp.slack > 0) where.push(`${result.followUp.slack} Slack thread(s)`);
  if (result.followUp.msTeams > 0) where.push(`${result.followUp.msTeams} Teams webhook(s)`);
  println(
    c.dim(
      where.length > 0
        ? `  Posted under the alert in ${where.join(" and ")}, and drawn on the cost charts.`
        : "  Drawn on the cost charts. The alert reached no Slack or Teams destination to follow up in.",
    ),
  );
}

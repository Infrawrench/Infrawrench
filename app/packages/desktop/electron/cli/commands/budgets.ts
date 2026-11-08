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
// The response schemas are checked against `@infrawrench/client-core` by
// `wire`, type-only, so the CLI still ships zero new runtime dependencies.
import { Effect, Option, Predicate, Schema } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import type {
  BudgetAlertEvent,
  BudgetAlertNoteResult,
  BudgetWithStatus,
} from "@infrawrench/client-core" with { "resolution-mode": "import" };
import { CloudApi, currentOrg, decodeBody } from "../effect/cloud-api";
import { CliFailure, CliUsageError } from "../effect/errors";
import * as Print from "../effect/print";
import { CliSession } from "../effect/session";
import { decodePaired, wire } from "../effect/wire";
import { c, safe } from "../output";
import {
  budgetBar,
  budgetFigures,
  formatBudgetPeriod,
  formatBudgetValue,
  formatBudgetWarning,
  matchCostReport,
  orderBudgetTree,
} from "../format";

const BUDGETS_PATH = "/budgets";

const Note = Schema.Struct({
  text: Schema.String,
  notedAt: Schema.String,
  notedByName: Schema.NullOr(Schema.String),
});
type Note = typeof Note.Type;

const EventFields = {
  id: Schema.String,
  thresholdType: Schema.String,
  thresholdPercent: Schema.Finite,
  actualAmountCents: Schema.Finite,
  forecastAmountCents: Schema.NullOr(Schema.Finite),
  triggeredAt: Schema.String,
  actualUsage: Schema.optional(Schema.NullOr(Schema.Finite)),
  forecastUsage: Schema.optional(Schema.NullOr(Schema.Finite)),
  note: Schema.NullOr(Note),
};
const Events = wire<BudgetAlertEvent[]>()(Schema.Array(Schema.Struct(EventFields)));

const NoteResult = wire<BudgetAlertNoteResult>()(
  Schema.Struct({
    ...EventFields,
    followUp: Schema.Struct({ slack: Schema.Finite, msTeams: Schema.Finite }),
  }),
);

const optionalNumber = Schema.optional(Schema.NullOr(Schema.Finite));
const Budgets = wire<BudgetWithStatus[]>()(
  Schema.Array(
    Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      amountCents: Schema.Finite,
      currency: Schema.String,
      month: Schema.String,
      actualCents: Schema.Finite,
      forecastCents: Schema.NullOr(Schema.Finite),
      forecastLowCents: optionalNumber,
      forecastHighCents: optionalNumber,
      scenarioForecastCents: optionalNumber,
      currentMonthEvents: Schema.Array(
        Schema.Struct({ note: Schema.optional(Schema.NullOr(Schema.Unknown)) }),
      ),
      // A measure this build does not know prints as money, like `cost`.
      measure: Schema.optional(Schema.String),
      usageUnit: Schema.optional(Schema.NullOr(Schema.String)),
      parentBudgetId: Schema.optional(Schema.NullOr(Schema.String)),
      periodStart: Schema.optional(Schema.NullOr(Schema.String)),
      periodEnd: Schema.optional(Schema.NullOr(Schema.String)),
      periodLimit: optionalNumber,
      actualUsage: optionalNumber,
      forecastUsage: optionalNumber,
      rolledUp: Schema.optional(Schema.Boolean),
      hierarchyWarnings: Schema.optional(
        Schema.Array(
          Schema.Struct({
            kind: Schema.String,
            childTotal: Schema.Finite,
            parentLimit: Schema.Finite,
          }),
        ),
      ),
    }),
  ),
);
type Budget = (typeof Budgets.Type)[number];

const refuseLocal = Effect.gen(function* () {
  const session = yield* CliSession;
  if (session.local) {
    return yield* new CliFailure({
      message: "Budgets live in Infrawrench Cloud; there is no local budget store.",
    });
  }
});

/** A name/id query to exactly one budget, beside the element the server sent. */
const resolveBudget = Effect.fnUntraced(function* (orgId: string, query: string) {
  const api = yield* CloudApi;
  const budgets = yield* decodePaired(Budgets, BUDGETS_PATH)(yield* api.json(orgId, BUDGETS_PATH));
  // Same matching rules as `reports <name|id>`: id, exact name, unique substring.
  const found = matchCostReport(
    budgets.map((b) => ({ id: b.row.id, name: b.row.name, paired: b })),
    query,
  );
  if (found.match) return found.match.paired;
  return yield* new CliFailure({
    message:
      found.candidates.length === 0
        ? `No budget matches "${query}". Run \`infrawrench budgets\` to list them.`
        : `"${query}" matches ${found.candidates.length} budgets: ${found.candidates
            .map((b) => b.name)
            .join(", ")}. Use the full name or the id.`,
  });
});

const eventsPath = (budgetId: string) => `${BUDGETS_PATH}/${encodeURIComponent(budgetId)}/events`;

/** `"actual 80%"` / `"forecast 100%"`. */
function describeThreshold(e: {
  readonly thresholdType: string;
  readonly thresholdPercent: number;
}) {
  return `${safe(e.thresholdType)} ${e.thresholdPercent}%`;
}

/** `"Q3 load test (Astrid, 2026-10-03)"`, or a dim dash when there is none. */
function describeNote(note: Note | null | undefined): string {
  if (!note) return c.dim("—");
  const who = note.notedByName ? `${safe(note.notedByName)}, ` : "";
  return `${safe(note.text)} ${c.dim(`(${who}${safe(note.notedAt.slice(0, 10))})`)}`;
}

/** `infrawrench budgets <name|id>`: one budget's alert history, with the note on each firing. */
const showBudget = Effect.fnUntraced(function* (orgId: string, query: string) {
  const session = yield* CliSession;
  const api = yield* CloudApi;
  const { row: budget, raw } = yield* resolveBudget(orgId, query);
  const path = eventsPath(budget.id);
  const body = yield* api.json(orgId, path);
  if (session.output === "json") {
    return yield* Print.json({ org: orgId, budget: raw, events: body ?? [] });
  }
  const events = Predicate.isNullish(body) ? [] : yield* decodeBody(Events, path)(body);
  const fig = budgetFigures(budget);
  const amounts =
    fig.limit !== null
      ? `${formatBudgetValue(budget, fig.actual)} ${c.dim(`of ${formatBudgetValue(budget, fig.limit)}`)}`
      : formatBudgetValue(budget, fig.actual);
  const pct = fig.percent !== null ? ` ${fig.percent.toFixed(0)}%` : "";
  yield* Print.line(
    `${c.bold(safe(budget.name))} ${c.dim(`· ${safe(formatBudgetPeriod(budget))}`)}  ${amounts}  ${budgetBar(fig.percent)}${pct}`,
  );
  yield* Print.line();
  if (events.length === 0) {
    return yield* Print.line(c.dim("No thresholds have fired for this budget."));
  }
  const usage = budget.measure === "usage";
  yield* Print.table(events, [
    { header: "fired", value: (e) => safe(e.triggeredAt.slice(0, 10)) },
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
    { header: "event", value: (e) => c.dim(safe(e.id)) },
  ]);
  yield* Print.line();
  yield* Print.line(
    c.dim(
      `Explain a firing with \`infrawrench budgets annotate "${safe(budget.name)}" --note "<why>" [--event <id>]\`.`,
    ),
  );
});

/** `infrawrench budgets`: every budget as a tree with this period's status. */
const listBudgets = Effect.fnUntraced(function* (org: { id: string; displayName: string }) {
  const session = yield* CliSession;
  const api = yield* CloudApi;
  const body = yield* api.json(org.id, BUDGETS_PATH);
  if (session.output === "json") return yield* Print.json({ org: org.id, budgets: body ?? [] });
  const budgets: ReadonlyArray<Budget> = Predicate.isNullish(body)
    ? []
    : yield* decodeBody(Budgets, BUDGETS_PATH)(body);

  yield* Print.line(`${c.bold(safe(org.displayName))} ${c.dim("· budgets")}`);
  yield* Print.line();
  if (budgets.length === 0) {
    return yield* Print.line(
      c.dim(
        "No budgets yet. Create one from the Costs panel or a dashboard in the app: a budget limits spend or a usage quantity per period and alerts on actual or forecast crossings.",
      ),
    );
  }

  const ordered = orderBudgetTree(budgets);
  const nameWidth = Math.min(
    40,
    Math.max(...ordered.map(({ row, depth }) => safe(row.name).length + depth * 2)),
  );
  for (const { row, depth } of ordered) {
    const fig = budgetFigures(row);
    const indent = "  ".repeat(depth);
    const name = `${indent}${safe(row.name)}`.slice(0, nameWidth).padEnd(nameWidth);
    const amounts =
      fig.limit !== null
        ? `${formatBudgetValue(row, fig.actual)} / ${formatBudgetValue(row, fig.limit)}`
        : formatBudgetValue(row, fig.actual);
    const pct = fig.percent !== null ? `${fig.percent.toFixed(0).padStart(4)}%` : "     ";
    // The trend's 80% range rides beside the forecast when the server sent one.
    const band =
      row.measure !== "usage" && row.forecastLowCents != null && row.forecastHighCents != null
        ? ` (${formatBudgetValue(row, row.forecastLowCents)}-${formatBudgetValue(row, row.forecastHighCents)})`
        : "";
    const forecast =
      fig.forecast !== null ? c.dim(` fc ${formatBudgetValue(row, fig.forecast)}${band}`) : "";
    const unexplained = row.currentMonthEvents.filter((e) => !e.note).length;
    const flags = [
      row.measure === "usage" ? c.cyan("usage") : null,
      row.rolledUp ? c.dim("Σ children") : null,
      row.currentMonthEvents.length > 0 ? c.red("alert") : null,
      // An alert with a note is answered; one without is still somebody's
      // open question.
      unexplained > 0 ? c.dim(`${unexplained} unexplained`) : null,
    ]
      .filter((f) => f !== null)
      .join(" ");
    yield* Print.line(
      `${name}  ${budgetBar(fig.percent)} ${pct}  ${amounts}${forecast}  ${c.dim(safe(formatBudgetPeriod(row)))}${flags ? `  ${flags}` : ""}`,
    );
    for (const warning of row.hierarchyWarnings ?? []) {
      yield* Print.line(
        `${" ".repeat(nameWidth + 2)}${c.yellow(`⚠ ${formatBudgetWarning(row, warning)}`)}`,
      );
    }
  }
  yield* Print.line();
  yield* Print.line(
    c.dim('One budget\'s alert history and notes: `infrawrench budgets "<name>"`.'),
  );
});

const budgetName = Argument.String("name|id").pipe(
  Argument.withDescription("The budget (the words join into one name)"),
  Argument.variadic(),
);

/**
 * `infrawrench budgets annotate <name|id> --note <text> [--event <id>]`:
 * explain a fired alert. Defaults to the most recent firing, which is the one
 * somebody is almost always asking about.
 */
const annotate = Command.make(
  "annotate",
  {
    name: budgetName,
    note: Flag.String("note").pipe(
      Flag.withMetavar("text"),
      Flag.withDescription(
        "Why it fired; shows on the budget, the cost charts and the alert thread",
      ),
      Flag.optional,
    ),
    event: Flag.String("event").pipe(
      Flag.withMetavar("id"),
      Flag.withDescription("Which firing, by id or its first characters (default: the latest)"),
      Flag.optional,
    ),
  },
  Effect.fn("budgets.annotate")(function* (input) {
    yield* refuseLocal;
    const session = yield* CliSession;
    const api = yield* CloudApi;
    const query = input.name.join(" ").trim();
    if (!query) {
      return yield* new CliUsageError({
        message: 'Which budget? `infrawrench budgets annotate <name|id> --note "<why it fired>"`.',
      });
    }
    const note = Option.getOrUndefined(input.note)?.trim();
    if (!note) {
      return yield* new CliUsageError({ message: 'Add the note: `--note "<why it fired>"`.' });
    }

    const org = yield* currentOrg;
    const { row: budget } = yield* resolveBudget(org.id, query);
    const path = eventsPath(budget.id);
    const body = yield* api.json(org.id, path);
    const events = Predicate.isNullish(body) ? [] : yield* decodeBody(Events, path)(body);
    if (events.length === 0) {
      return yield* new CliFailure({
        message: `"${budget.name}" has not fired any alerts yet, so there is nothing to explain.`,
      });
    }
    const wanted = Option.getOrUndefined(input.event);
    const event = wanted
      ? events.find((e) => e.id === wanted || e.id.startsWith(wanted))
      : events[0];
    if (!event) {
      return yield* new CliFailure({
        message: `No firing "${wanted}" on "${budget.name}". Run \`infrawrench budgets "${budget.name}"\` for event ids.`,
      });
    }

    const notePath = `${path}/${encodeURIComponent(event.id)}/note`;
    const resultBody = yield* api.json(org.id, notePath, {
      method: "POST",
      body: JSON.stringify({ note }),
    });

    if (session.output === "json") {
      return yield* Print.json({
        org: org.id,
        budget: { id: budget.id, name: budget.name },
        event: resultBody,
      });
    }
    const result = yield* decodeBody(NoteResult, notePath)(resultBody);
    yield* Print.line(
      `${c.green("✓")} ${c.bold(safe(budget.name))} ${c.dim(
        `· ${describeThreshold(result)} on ${safe(result.triggeredAt.slice(0, 10))}`,
      )}`,
    );
    yield* Print.line(`  ${describeNote(result.note)}`);
    const where: string[] = [];
    if (result.followUp.slack > 0) where.push(`${result.followUp.slack} Slack thread(s)`);
    if (result.followUp.msTeams > 0) where.push(`${result.followUp.msTeams} Teams webhook(s)`);
    yield* Print.line(
      c.dim(
        where.length > 0
          ? `  Posted under the alert in ${where.join(" and ")}, and drawn on the cost charts.`
          : "  Drawn on the cost charts. The alert reached no Slack or Teams destination to follow up in.",
      ),
    );
  }),
).pipe(
  Command.withDescription(
    "Explain a fired budget alert (the latest by default) on the budget, cost charts and alert thread",
  ),
);

/**
 * `infrawrench budgets [name|id]`: every budget as a tree with this period's
 * status, or one budget's alert history with the note on each firing.
 */
export const budgets = Command.make(
  "budgets",
  { name: budgetName },
  Effect.fn("budgets")(function* (input) {
    yield* refuseLocal;
    const org = yield* currentOrg;
    const query = input.name.join(" ").trim();
    if (query) return yield* showBudget(org.id, query);
    yield* listBudgets(org);
  }),
).pipe(
  Command.withDescription(
    "Every budget as a tree: this period's actual and forecast vs its limit; give a name for its alert history",
  ),
  Command.withSubcommands([annotate]),
);

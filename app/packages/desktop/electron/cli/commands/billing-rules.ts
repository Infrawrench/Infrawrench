// `infrawrench billing-rules`: the org's own adjustments to collected spend.
//
// Worth a terminal command specifically because these rules are the answer to
// "why does this number not match the invoice". When a total in a report is
// higher than the bill, one of these rows is why, and being able to print them
// (with `--json` in a CI check or a reconciliation script) is faster than
// finding the settings page.
//
// The wire types come from `@infrawrench/client-core`, type-only with the
// resolution-mode attribute (the CLI is CJS, client-core is ESM), so the CLI
// still ships zero runtime dependencies.
import { Effect, Option, Schema } from "effect";
import { Argument, Command } from "effect/cli";
import type {
  BillingRule,
  ManagedAccount,
  PricingPreviewResult,
} from "@infrawrench/client-core" with {
  "resolution-mode": "import",
};
import { CloudApi, currentOrg, decodeBody } from "../effect/cloud-api";
import { CliFailure } from "../effect/errors";
import * as Print from "../effect/print";
import { customer, month } from "../effect/range-flags";
import { CliSession } from "../effect/session";
import { spreadBody, wire } from "../effect/wire";
import { formatBillingRule, matchCostReport } from "../format";
import { c, safe, type Column } from "../output";

const PATH = "/billing-rules";

const Rule = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  description: Schema.NullOr(Schema.String),
  enabled: Schema.Boolean,
  priority: Schema.Finite,
  match: Schema.Struct({
    tagKey: Schema.optional(Schema.String),
    tagValue: Schema.optional(Schema.String),
    accountId: Schema.optional(Schema.String),
    pluginId: Schema.optional(Schema.String),
    service: Schema.optional(Schema.String),
    chargeType: Schema.optional(Schema.String),
  }),
  // What `formatBillingRule` reads; `kind` picks a wording with a fallback.
  adjustment: Schema.Struct({
    kind: Schema.String,
    percent: Schema.optional(Schema.NullOr(Schema.Finite)),
    amount: Schema.optional(Schema.NullOr(Schema.Finite)),
    currency: Schema.optional(Schema.NullOr(Schema.String)),
    period: Schema.optional(Schema.NullOr(Schema.String)),
    targetKind: Schema.optional(Schema.NullOr(Schema.String)),
    targetId: Schema.optional(Schema.NullOr(Schema.String)),
    tiers: Schema.optional(
      Schema.NullOr(
        Schema.mutable(
          Schema.Array(
            Schema.Struct({ upTo: Schema.NullOr(Schema.Finite), percent: Schema.Finite }),
          ),
        ),
      ),
    ),
    tierMode: Schema.optional(Schema.NullOr(Schema.String)),
    tierScope: Schema.optional(Schema.NullOr(Schema.String)),
    expression: Schema.optional(Schema.NullOr(Schema.String)),
  }),
  managedAccountIds: Schema.optional(Schema.Array(Schema.String)),
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
type Rule = typeof Rule.Type;

const Rules = wire<BillingRule[]>()(Schema.Array(Rule));
const RawRules = Schema.Array(Schema.Unknown);

const Customers = wire<ManagedAccount[]>()(
  Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String })),
);

const Money = Schema.Record(Schema.String, Schema.Finite);

const Preview = wire<PricingPreviewResult>()(
  Schema.Struct({
    from: Schema.String,
    to: Schema.String,
    collected: Money,
    before: Money,
    after: Money,
    warnings: Schema.Array(Schema.String),
    expressionFailures: Schema.Array(
      Schema.Struct({ name: Schema.String, lines: Schema.Finite, message: Schema.String }),
    ),
    changes: Schema.Array(
      Schema.Struct({
        pluginId: Schema.String,
        service: Schema.String,
        accountName: Schema.String,
        currency: Schema.String,
        before: Schema.Finite,
        after: Schema.Finite,
      }),
    ),
  }),
);

const requireCloud = Effect.gen(function* () {
  const session = yield* CliSession;
  if (session.local) {
    return yield* new CliFailure({
      message:
        "Billing rules live in Infrawrench Cloud, and a local-only workspace has no collected spend to adjust.",
    });
  }
});

/** The org's rules, decoded and as the server sent them, plus the org. */
const loadRules = Effect.gen(function* () {
  const api = yield* CloudApi;
  const org = yield* currentOrg;
  const body = yield* api.json(org.id, PATH);
  const rules = yield* decodeBody(Rules, PATH)(body);
  const raw = yield* decodeBody(RawRules, PATH)(body);
  return { org, rules, raw };
});

const findRule = (rules: ReadonlyArray<Rule>, query: string): Effect.Effect<Rule, CliFailure> => {
  const found = matchCostReport(rules, query);
  if (found.match) return Effect.succeed(found.match);
  if (found.candidates.length === 0) {
    return Effect.fail(new CliFailure({ message: `No billing rule matches "${query}".` }));
  }
  return Effect.fail(
    new CliFailure({
      message: `"${query}" matches ${found.candidates.length} billing rules: ${found.candidates
        .map((r) => r.name)
        .join(", ")}.`,
    }),
  );
};

function money(amount: number, currency: string): string {
  return `${amount.toFixed(2)} ${currency}`;
}

const isInvoiceOnly = (rule: Rule) =>
  rule.adjustment.kind === "tiered" || rule.adjustment.kind === "expression";

/**
 * `infrawrench billing-rules`: list them, in the order they evaluate.
 *
 * The trailing note is not decoration. Anyone reading this list is reading it
 * to understand a number, and the two facts that make the list interpretable
 * (that nothing here changed the stored data, and that markups compound while
 * reallocation fires once) are not derivable from the rows themselves.
 */
const listRules = Effect.fn("billing-rules")(function* () {
  const session = yield* CliSession;
  const { org, rules, raw } = yield* loadRules;

  if (session.output === "json") return yield* Print.json({ org: org.id, rules: raw });

  if (rules.length === 0) {
    return yield* Print.line(
      c.dim(
        "No billing rules. Every figure this organisation reports is exactly what the providers charged.",
      ),
    );
  }

  const active = rules.filter((r) => r.enabled).length;
  yield* Print.line(
    `${c.bold(safe(org.displayName))} ${c.dim(
      `· ${rules.length} billing rule${rules.length === 1 ? "" : "s"}` +
        (active < rules.length ? `, ${rules.length - active} disabled` : ""),
    )}`,
  );
  yield* Print.line();

  const columns: Column<Rule>[] = [
    { header: "#", value: (r) => String(r.priority), align: "right" },
    { header: "name", value: (r) => (r.enabled ? safe(r.name) : c.dim(safe(r.name))) },
    { header: "kind", value: (r) => c.dim(safe(r.adjustment.kind)) },
    {
      header: "applies to",
      value: (r) =>
        isInvoiceOnly(r)
          ? (r.managedAccountIds ?? []).length === 0
            ? c.dim("invoices: every customer")
            : c.dim(`invoices: ${(r.managedAccountIds ?? []).length} customer(s)`)
          : c.dim("all figures"),
    },
    { header: "does", value: (r) => safe(formatBillingRule(r)) },
    { header: "state", value: (r) => (r.enabled ? c.green("on") : c.dim("off")) },
  ];
  yield* Print.table(rules, columns);

  yield* Print.line();
  yield* Print.line(
    c.dim(
      "Applied when a report is run, never written into collected spend. Provider charges are unchanged.",
    ),
  );
  yield* Print.line(
    c.dim(
      "Lower numbers evaluate first. Every matching markup or discount applies (two 10% markups " +
        "compound to 21%); reallocation is first-match-wins, so a row moves once and the total " +
        "is unchanged by it. Tiered and expression rules price managed-account invoices only.",
    ),
  );
  yield* Print.line(c.dim("Try one against last month: infrawrench billing-rules preview <name>"));
});

/** `infrawrench billing-rules <name|id>`: one rule in full. */
const showRule = Effect.fn("billing-rules.show")(function* (query: string) {
  const session = yield* CliSession;
  const { org, rules, raw } = yield* loadRules;
  const rule = yield* findRule(rules, query);

  if (session.output === "json") {
    const body = raw[rules.indexOf(rule)];
    return yield* Print.json(yield* spreadBody({ org: org.id }, body, PATH));
  }

  yield* Print.line(
    `${c.bold(safe(rule.name))} ${rule.enabled ? c.green("· on") : c.dim("· off")}`,
  );
  if (rule.description) yield* Print.line(c.dim(safe(rule.description)));
  yield* Print.line();
  yield* Print.line(`  priority   ${rule.priority}`);
  yield* Print.line(`  adjustment ${safe(formatBillingRule(rule))}`);
  if (isInvoiceOnly(rule)) {
    const scoped = rule.managedAccountIds ?? [];
    yield* Print.line(
      `  applies to ${scoped.length === 0 ? "every customer's invoices" : `invoices of ${scoped.join(", ")}`}`,
    );
  }
  yield* Print.line(`  created    ${rule.createdAt}`);
  yield* Print.line(`  updated    ${rule.updatedAt}`);
});

const ruleName = Argument.String("name|id").pipe(
  Argument.withDescription("The rule, by name or id (the words join into one name)"),
  Argument.variadic(),
);

/**
 * `infrawrench billing-rules preview <name|id> [--customer <name>] [--month YYYY-MM]`:
 * what one saved rule does to a month of real spend, as a dry run.
 *
 * Read-only like the rest of this command: the server prices the month without
 * the rule and with it and writes nothing.
 */
const preview = Command.make(
  "preview",
  {
    rule: ruleName,
    customer: customer,
    month: month,
  },
  Effect.fn("billing-rules.preview")(function* (input) {
    const session = yield* CliSession;
    const api = yield* CloudApi;
    yield* requireCloud;
    const query = input.rule.join(" ");
    if (!query) {
      return yield* new CliFailure({
        message: "Name the rule to preview: infrawrench billing-rules preview <name>",
      });
    }
    const { org, rules } = yield* loadRules;
    const rule = yield* findRule(rules, query);

    const wantedCustomer = Option.getOrUndefined(input.customer);
    let managedAccountId: string | undefined;
    if (wantedCustomer) {
      const customersPath = "/managed-accounts";
      const customers = yield* decodeBody(
        Customers,
        customersPath,
      )(yield* api.json(org.id, customersPath));
      const needle = wantedCustomer.toLowerCase();
      const match =
        customers.find((m) => m.id === wantedCustomer) ??
        customers.find((m) => m.name.toLowerCase() === needle);
      if (!match) {
        return yield* new CliFailure({ message: `No customer matches "${wantedCustomer}".` });
      }
      managedAccountId = match.id;
    }

    const path = "/billing-rules/preview";
    const monthValue = Option.getOrUndefined(input.month);
    const body = yield* api.json(org.id, path, {
      method: "POST",
      body: JSON.stringify({
        ruleId: rule.id,
        ...(managedAccountId ? { managedAccountId } : {}),
        ...(monthValue ? { month: monthValue } : {}),
      }),
    });

    if (session.output === "json") {
      return yield* Print.json(
        yield* spreadBody({ org: org.id, rule: { id: rule.id, name: rule.name } }, body, path),
      );
    }
    const result = yield* decodeBody(Preview, path)(body);

    yield* Print.line(
      `${c.bold(safe(rule.name))} ${c.dim(
        `· ${result.from} → ${result.to} · ${managedAccountId ? wantedCustomer : "whole organisation"}`,
      )}`,
    );
    yield* Print.line(c.dim(`  ${safe(formatBillingRule(rule))}`));
    yield* Print.line();
    const currencies = [...new Set([...Object.keys(result.before), ...Object.keys(result.after)])];
    yield* Print.table(currencies, [
      { header: "currency", value: (k) => safe(k) },
      { header: "collected", value: (k) => money(result.collected[k] ?? 0, k), align: "right" },
      { header: "without", value: (k) => money(result.before[k] ?? 0, k), align: "right" },
      { header: "with", value: (k) => money(result.after[k] ?? 0, k), align: "right" },
      {
        header: "difference",
        value: (k) => {
          const d = (result.after[k] ?? 0) - (result.before[k] ?? 0);
          return d === 0 ? c.dim("0") : `${d > 0 ? "+" : ""}${money(d, k)}`;
        },
        align: "right",
      },
    ]);
    for (const f of result.expressionFailures) {
      yield* Print.line(
        c.yellow(`${safe(f.name)}: ${f.lines} line(s) kept their cost: ${safe(f.message)}`),
      );
    }
    for (const w of result.warnings) yield* Print.line(c.yellow(safe(w)));
    if (result.changes.length > 0) {
      yield* Print.line();
      yield* Print.table(result.changes.slice(0, 10), [
        { header: "service", value: (r) => safe(`${r.pluginId} ${r.service}`) },
        { header: "account", value: (r) => safe(r.accountName) },
        { header: "without", value: (r) => money(r.before, r.currency), align: "right" },
        { header: "with", value: (r) => money(r.after, r.currency), align: "right" },
      ]);
    }
    yield* Print.line();
    yield* Print.line(
      c.dim("A dry run: nothing was saved, and collected spend is never rewritten."),
    );
  }),
).pipe(
  Command.withDescription("Dry-run one rule against a month of real spend, without and with it"),
);

export const billingRules = Command.make(
  "billing-rules",
  { rule: ruleName },
  Effect.fn("billing-rules")(function* (input) {
    yield* requireCloud;
    const query = input.rule.join(" ");
    return yield* query ? showRule(query) : listRules();
  }),
).pipe(
  Command.withDescription(
    "The org's own adjustments to collected spend (markups, discounts, fixed charges, reallocations)",
  ),
  Command.withSubcommands([preview]),
);

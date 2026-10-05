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
import { CliError, orgFetch, resolveOrg, type CliContext } from "../context";
import type {
  BillingRule,
  ManagedAccount,
  PricingPreviewResult,
} from "@infrawrench/client-core" with {
  "resolution-mode": "import",
};
import { formatBillingRule, matchCostReport } from "../format";
import { c, printJson, println, printTable, type Column } from "../output";

function requireCloud(ctx: CliContext): void {
  if (ctx.flags.local) {
    throw new CliError(
      "Billing rules live in Infrawrench Cloud, and a local-only workspace has no collected spend to adjust.",
    );
  }
}

/**
 * `infrawrench billing-rules`: list them, in the order they evaluate.
 *
 * The trailing note is not decoration. Anyone reading this list is reading it
 * to understand a number, and the two facts that make the list interpretable
 * (that nothing here changed the stored data, and that markups compound while
 * reallocation fires once) are not derivable from the rows themselves.
 */
export async function cmdBillingRules(ctx: CliContext): Promise<void> {
  requireCloud(ctx);
  const org = await resolveOrg(ctx);
  const rules = await orgFetch<BillingRule[]>(org.id, "/billing-rules");

  if (ctx.flags.output === "json") {
    printJson({ org: org.id, rules });
    return;
  }

  if (rules.length === 0) {
    println(
      c.dim(
        "No billing rules. Every figure this organisation reports is exactly what the providers charged.",
      ),
    );
    return;
  }

  const active = rules.filter((r) => r.enabled).length;
  println(
    `${c.bold(org.displayName)} ${c.dim(
      `· ${rules.length} billing rule${rules.length === 1 ? "" : "s"}` +
        (active < rules.length ? `, ${rules.length - active} disabled` : ""),
    )}`,
  );
  println();

  const columns: Column<BillingRule>[] = [
    { header: "#", value: (r) => String(r.priority), align: "right" },
    { header: "name", value: (r) => (r.enabled ? r.name : c.dim(r.name)) },
    { header: "kind", value: (r) => c.dim(r.adjustment.kind) },
    {
      header: "applies to",
      value: (r) =>
        r.adjustment.kind === "tiered" || r.adjustment.kind === "expression"
          ? (r.managedAccountIds ?? []).length === 0
            ? c.dim("invoices: every customer")
            : c.dim(`invoices: ${(r.managedAccountIds ?? []).length} customer(s)`)
          : c.dim("all figures"),
    },
    { header: "does", value: (r) => formatBillingRule(r) },
    { header: "state", value: (r) => (r.enabled ? c.green("on") : c.dim("off")) },
  ];
  printTable(rules, columns);

  println();
  println(
    c.dim(
      "Applied when a report is run, never written into collected spend. Provider charges are unchanged.",
    ),
  );
  println(
    c.dim(
      "Lower numbers evaluate first. Every matching markup or discount applies (two 10% markups " +
        "compound to 21%); reallocation is first-match-wins, so a row moves once and the total " +
        "is unchanged by it. Tiered and expression rules price managed-account invoices only.",
    ),
  );
  println(c.dim("Try one against last month: infrawrench billing-rules preview <name>"));
}

function findRule(rules: BillingRule[], query: string): BillingRule {
  const found = matchCostReport(rules, query);
  if (found.match) return found.match;
  if (found.candidates.length === 0) throw new CliError(`No billing rule matches "${query}".`);
  throw new CliError(
    `"${query}" matches ${found.candidates.length} billing rules: ${found.candidates
      .map((r) => r.name)
      .join(", ")}.`,
  );
}

function money(amount: number, currency: string): string {
  return `${amount.toFixed(2)} ${currency}`;
}

/**
 * `infrawrench billing-rules preview <name|id> [--customer <name>] [--month YYYY-MM]`:
 * what one saved rule does to a month of real spend, as a dry run.
 *
 * Read-only like the rest of this command: the server prices the month without
 * the rule and with it and writes nothing.
 */
export async function cmdBillingRulePreview(
  ctx: CliContext,
  query: string,
  options: { customer?: string | undefined; month?: string | undefined },
): Promise<void> {
  requireCloud(ctx);
  if (!query)
    throw new CliError("Name the rule to preview: infrawrench billing-rules preview <name>");
  if (options.month && !/^\d{4}-(0[1-9]|1[0-2])$/.test(options.month)) {
    throw new CliError(`--month must be YYYY-MM, got "${options.month}"`, 2);
  }
  const org = await resolveOrg(ctx);
  const rules = await orgFetch<BillingRule[]>(org.id, "/billing-rules");
  const rule = findRule(rules, query);

  let managedAccountId: string | undefined;
  if (options.customer) {
    const customers = await orgFetch<ManagedAccount[]>(org.id, "/managed-accounts");
    const needle = options.customer.toLowerCase();
    const match =
      customers.find((m) => m.id === options.customer) ??
      customers.find((m) => m.name.toLowerCase() === needle);
    if (!match) throw new CliError(`No customer matches "${options.customer}".`);
    managedAccountId = match.id;
  }

  const result = await orgFetch<PricingPreviewResult>(org.id, "/billing-rules/preview", {
    method: "POST",
    body: JSON.stringify({
      ruleId: rule.id,
      ...(managedAccountId ? { managedAccountId } : {}),
      ...(options.month ? { month: options.month } : {}),
    }),
  });

  if (ctx.flags.output === "json") {
    printJson({ org: org.id, rule: { id: rule.id, name: rule.name }, ...result });
    return;
  }

  println(
    `${c.bold(rule.name)} ${c.dim(
      `· ${result.from} → ${result.to} · ${managedAccountId ? options.customer : "whole organisation"}`,
    )}`,
  );
  println(c.dim(`  ${formatBillingRule(rule)}`));
  println();
  const currencies = [...new Set([...Object.keys(result.before), ...Object.keys(result.after)])];
  printTable(currencies, [
    { header: "currency", value: (k) => k },
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
    println(c.yellow(`${f.name}: ${f.lines} line(s) kept their cost: ${f.message}`));
  }
  for (const w of result.warnings) println(c.yellow(w));
  if (result.changes.length > 0) {
    println();
    printTable(result.changes.slice(0, 10), [
      { header: "service", value: (r) => `${r.pluginId} ${r.service}` },
      { header: "account", value: (r) => r.accountName },
      { header: "without", value: (r) => money(r.before, r.currency), align: "right" },
      { header: "with", value: (r) => money(r.after, r.currency), align: "right" },
    ]);
  }
  println();
  println(c.dim("A dry run: nothing was saved, and collected spend is never rewritten."));
}

/** `infrawrench billing-rules <name|id>`: one rule in full. */
export async function cmdBillingRule(ctx: CliContext, query: string): Promise<void> {
  requireCloud(ctx);
  const org = await resolveOrg(ctx);
  const rules = await orgFetch<BillingRule[]>(org.id, "/billing-rules");

  const rule = findRule(rules, query);

  if (ctx.flags.output === "json") {
    printJson({ org: org.id, ...rule });
    return;
  }

  println(`${c.bold(rule.name)} ${rule.enabled ? c.green("· on") : c.dim("· off")}`);
  if (rule.description) println(c.dim(rule.description));
  println();
  println(`  priority   ${rule.priority}`);
  println(`  adjustment ${formatBillingRule(rule)}`);
  if (rule.adjustment.kind === "tiered" || rule.adjustment.kind === "expression") {
    const scoped = rule.managedAccountIds ?? [];
    println(
      `  applies to ${scoped.length === 0 ? "every customer's invoices" : `invoices of ${scoped.join(", ")}`}`,
    );
  }
  println(`  created    ${rule.createdAt}`);
  println(`  updated    ${rule.updatedAt}`);
}

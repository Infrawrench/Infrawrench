// `infrawrench billing-rules` — the org's own adjustments to collected spend.
//
// Worth a terminal command specifically because these rules are the answer to
// "why does this number not match the invoice". When a total in a report is
// higher than the bill, one of these rows is why, and being able to print them
// — with `--json` in a CI check or a reconciliation script — is faster than
// finding the settings page.
//
// The wire types come from `@infrawrench/client-core`, type-only with the
// resolution-mode attribute (the CLI is CJS, client-core is ESM), so the CLI
// still ships zero runtime dependencies.
import { CliError, orgFetch, resolveOrg, type CliContext } from "../context";
import type { BillingRule } from "@infrawrench/client-core" with {
  "resolution-mode": "import",
};
import { formatBillingRule, matchCostReport } from "../format";
import { c, printJson, println, printTable, type Column } from "../output";

function requireCloud(ctx: CliContext): void {
  if (ctx.flags.local) {
    throw new CliError(
      "Billing rules live in Infrawrench Cloud — they are applied to collected spend when a " +
        "report is run, and a local-only workspace has no collected spend to adjust.",
    );
  }
}

/**
 * `infrawrench billing-rules` — list them, in the order they evaluate.
 *
 * The trailing note is not decoration. Anyone reading this list is reading it
 * to understand a number, and the two facts that make the list interpretable —
 * that nothing here changed the stored data, and that markups compound while
 * reallocation fires once — are not derivable from the rows themselves.
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
    { header: "does", value: (r) => formatBillingRule(r) },
    { header: "state", value: (r) => (r.enabled ? c.green("on") : c.dim("off")) },
  ];
  printTable(rules, columns);

  println();
  println(
    c.dim(
      "Applied when a report is run, never written into collected spend — what the providers " +
        "charged is unchanged and still reconciles against the invoice.",
    ),
  );
  println(
    c.dim(
      "Lower numbers evaluate first. Every matching markup or discount applies (two 10% markups " +
        "compound to 21%); reallocation is first-match-wins, so a row moves once and the total " +
        "is unchanged by it.",
    ),
  );
}

/** `infrawrench billing-rules <name|id>` — one rule in full. */
export async function cmdBillingRule(ctx: CliContext, query: string): Promise<void> {
  requireCloud(ctx);
  const org = await resolveOrg(ctx);
  const rules = await orgFetch<BillingRule[]>(org.id, "/billing-rules");

  const found = matchCostReport(rules, query);
  if (!found.match) {
    if (found.candidates.length === 0) throw new CliError(`No billing rule matches "${query}".`);
    throw new CliError(
      `"${query}" matches ${found.candidates.length} billing rules: ${found.candidates
        .map((r) => r.name)
        .join(", ")}.`,
    );
  }
  const rule = found.match;

  if (ctx.flags.output === "json") {
    printJson({ org: org.id, ...rule });
    return;
  }

  println(`${c.bold(rule.name)} ${rule.enabled ? c.green("· on") : c.dim("· off")}`);
  if (rule.description) println(c.dim(rule.description));
  println();
  println(`  priority   ${rule.priority}`);
  println(`  adjustment ${formatBillingRule(rule)}`);
  println(`  created    ${rule.createdAt}`);
  println(`  updated    ${rule.updatedAt}`);
}

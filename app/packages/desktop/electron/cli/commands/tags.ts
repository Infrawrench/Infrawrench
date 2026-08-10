// `infrawrench tags` — the org tag policy, per-account compliance, and
// untagged spend; `infrawrench showback` — spend by cost centre. Both are
// reads over the same endpoints the web/desktop Costs panel uses, and the
// wire shapes come from `@infrawrench/client-core` type-only, so the CLI
// keeps its zero-runtime-dependency rule.
import { CliError, orgFetch, resolveOrg, type CliContext } from "../context";
import type {
  ShowbackReport,
  TagComplianceReport,
  UntaggedSpendReport,
} from "@infrawrench/client-core" with { "resolution-mode": "import" };
import type { RangeFlags } from "../args";
import { parseLastDays } from "../args";
import { c, printJson, println, printTable, formatMoney } from "../output";
import { barChart } from "../charts";

function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function resolveRange(range: RangeFlags): { from: string; to: string } {
  const days = range.last ? Math.max(1, Math.round(parseLastDays(range.last))) : 30;
  const to = range.to ?? isoDay(Date.now());
  const from = range.from ?? isoDay(Date.parse(to) - (days - 1) * 86_400_000);
  return { from, to };
}

/**
 * Tag policy + compliance + untagged spend, in one screen: what the org
 * requires, which accounts carry it, and what the gap costs.
 */
export async function cmdTags(ctx: CliContext, range: RangeFlags): Promise<void> {
  if (ctx.flags.local) {
    throw new CliError(
      "Tag policy and compliance are org-level cloud state — there is no local tag policy.",
    );
  }
  const org = await resolveOrg(ctx);
  const { from, to } = resolveRange(range);

  const [compliance, untagged] = await Promise.all([
    orgFetch<TagComplianceReport>(org.id, "/tag-policy/compliance"),
    orgFetch<UntaggedSpendReport>(org.id, `/costs/untagged?from=${from}&to=${to}`),
  ]);

  if (ctx.flags.output === "json") {
    printJson({ org: org.id, from, to, ...compliance, untagged });
    return;
  }

  const { policy, accounts } = compliance;
  if (policy.requiredTags.length === 0) {
    println(
      c.dim(
        "No tag policy configured. An org admin can require tags like owner and env on every resource under Settings → Tag Policy in the web app.",
      ),
    );
    return;
  }

  const required = policy.requiredTags
    .map((t) => (t.allowedValues?.length ? `${t.key}(${t.allowedValues.join("|")})` : t.key))
    .join(", ");
  println(
    `${c.bold(org.displayName)} ${c.dim("· requires")} ${c.bold(required)}` +
      (policy.enforceOnCreate ? ` ${c.yellow("[enforced at create]")}` : ""),
  );
  println();

  if (accounts.length === 0) {
    println(c.dim("No accounts connected."));
  } else {
    printTable(accounts, [
      { header: "account", value: (a) => `${c.bold(a.displayName)} ${c.dim(a.pluginId)}` },
      {
        header: "taggable",
        value: (a) =>
          a.totalResources > a.evaluated
            ? `${a.evaluated} ${c.dim(`of ${a.totalResources}`)}`
            : String(a.evaluated),
        align: "right",
      },
      { header: "compliant", value: (a) => String(a.compliant), align: "right" },
      {
        header: "score",
        value: (a) => {
          if (a.score === null) return c.dim("—");
          const paint = a.score >= 90 ? c.green : a.score >= 50 ? c.yellow : c.red;
          return paint(`${a.score}%`);
        },
        align: "right",
      },
    ]);
  }

  println();
  if (untagged.currencies.length === 0) {
    println(c.dim(`No spend collected between ${from} and ${to}.`));
    return;
  }
  for (const currency of untagged.currencies) {
    const total = untagged.totals[currency] ?? 0;
    const missing = untagged.untaggedTotals[currency] ?? 0;
    println(
      `${c.bold(formatMoney(missing, currency))} of ${formatMoney(total, currency)} ${c.dim(
        `missing a required tag · ${from} → ${to}`,
      )}`,
    );
  }
  const top = untagged.topUntagged.slice(0, 8);
  if (top.length > 0) {
    println();
    const items = top.map((row, idx) => ({
      label: row.service ? `${row.accountLabel} · ${row.service}` : row.accountLabel,
      value: row.amount,
      display: formatMoney(row.amount, row.currency),
      colorIndex: idx,
    }));
    for (const line of barChart(items, 32)) println(line);
  }
}

/** Spend grouped by cost centre through the org's allocation rules. */
export async function cmdShowback(ctx: CliContext, range: RangeFlags): Promise<void> {
  if (ctx.flags.local) {
    throw new CliError("Showback runs over your org's collected cloud spend — cloud mode only.");
  }
  const org = await resolveOrg(ctx);
  const { from, to } = resolveRange(range);

  const report = await orgFetch<ShowbackReport>(org.id, `/costs/showback?from=${from}&to=${to}`);

  if (ctx.flags.output === "json") {
    printJson({ org: org.id, ...report });
    return;
  }

  println(`${c.bold(org.displayName)} ${c.dim(`· showback, ${from} → ${to}`)}`);
  println();

  if (report.centres.length === 0) {
    println(
      c.dim(
        "No cost centres defined. Create centres and allocation rules under Settings → Tag Policy in the web app; unmatched spend reports as Unallocated.",
      ),
    );
    return;
  }

  // One bar per (centre, currency); mixed-currency orgs get one bar each.
  const items = report.centres.flatMap((centre) =>
    Object.entries(centre.totals).map(([currency, amount]) => ({
      label: centre.costCentreId === null ? c.dim("unallocated") : centre.name,
      value: amount,
      display: formatMoney(amount, currency),
      colorIndex: centre.costCentreId === null ? 7 : report.centres.indexOf(centre),
    })),
  );
  if (items.length === 0) {
    println(c.dim("No spend collected in this period."));
    return;
  }
  for (const line of barChart(items, 32)) println(line);
}

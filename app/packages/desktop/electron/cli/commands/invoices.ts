// `infrawrench invoices`: the customers a managed service provider bills and
// the invoices raised against them.
//
// Read-only on purpose. Approving an invoice freezes the figures a customer
// will be sent and sending one states that they have them; neither is an act to
// make one flag away in a shell, and both carry an audit entry naming a person.
// What the terminal is genuinely good for is the other half: printing an
// invoice's derivation next to the spend it came from, in a reconciliation
// script or a CI check, without opening a browser.
//
// The wire types come from `@infrawrench/client-core`, type-only with the
// resolution-mode attribute (the CLI is CJS, client-core is ESM), so the CLI
// still ships zero runtime dependencies.
import { CliError, orgFetch, resolveOrg, type CliContext } from "../context";
import type { RangeFlags } from "../args";
import type {
  BillingProfile,
  ManagedAccount,
  ManagedInvoice,
  ManagedInvoiceSummary,
  UnassignedSpendReport,
} from "@infrawrench/client-core" with { "resolution-mode": "import" };
import { formatInvoiceStatus, formatInvoiceTotal } from "../format";
import { c, printJson, println, printTable, type Column } from "../output";

function requireCloud(ctx: CliContext): void {
  if (ctx.flags.local) {
    throw new CliError(
      "Invoices live in Infrawrench Cloud, and a local-only workspace has no collected spend to bill.",
    );
  }
}

/**
 * Match an invoice by id, exact number, or unique case-insensitive substring of
 * the number or the customer name. The same three-tier resolution the report
 * and billing-rule commands use, so `infrawrench invoices INV-2026-0004` and
 * `infrawrench invoices northwind` both work.
 */
function matchInvoice(
  invoices: readonly ManagedInvoiceSummary[],
  query: string,
): { match: ManagedInvoiceSummary | null; candidates: ManagedInvoiceSummary[] } {
  const byId = invoices.find((i) => i.id === query);
  if (byId) return { match: byId, candidates: [] };

  const lower = query.toLowerCase();
  const exact = invoices.filter((i) => (i.number ?? "").toLowerCase() === lower);
  if (exact.length === 1) return { match: exact[0]!, candidates: [] };

  const partial = invoices.filter(
    (i) =>
      (i.number ?? "").toLowerCase().includes(lower) ||
      i.managedAccountName.toLowerCase().includes(lower),
  );
  if (partial.length === 1) return { match: partial[0]!, candidates: [] };
  return { match: null, candidates: partial };
}

/** `infrawrench invoices`: every invoice, newest period first. */
export async function cmdInvoices(ctx: CliContext): Promise<void> {
  requireCloud(ctx);
  const org = await resolveOrg(ctx);
  const invoices = await orgFetch<ManagedInvoiceSummary[]>(org.id, "/invoices");

  if (ctx.flags.output === "json") {
    printJson({ org: org.id, invoices });
    return;
  }

  if (invoices.length === 0) {
    println(
      c.dim(
        "No invoices. Add a managed account (a customer, with the cost centres whose spend is " +
          "theirs) in the Invoices tab, then raise one.",
      ),
    );
    return;
  }

  const drafts = invoices.filter((i) => i.status === "draft").length;
  println(
    `${c.bold(org.displayName)} ${c.dim(
      `· ${invoices.length} invoice${invoices.length === 1 ? "" : "s"}` +
        (drafts > 0 ? `, ${drafts} draft` : ""),
    )}`,
  );
  println();

  const columns: Column<ManagedInvoiceSummary>[] = [
    { header: "number", value: (i) => i.number ?? c.dim("—") },
    { header: "customer", value: (i) => i.managedAccountName },
    { header: "period", value: (i) => `${i.periodFrom} → ${i.periodTo}` },
    {
      header: "total",
      value: (i) => (i.totals ? formatInvoiceTotal(i.totals, i.currency) : c.dim("not computed")),
      align: "right",
    },
    {
      header: "status",
      value: (i) => {
        const text = formatInvoiceStatus(i);
        if (i.status === "void") return c.red(text);
        if (i.status === "sent") return c.green(text);
        if (i.status === "draft") return c.dim(text);
        return c.blue(text);
      },
    },
  ];
  printTable(invoices, columns);

  println();
  println(
    c.dim(
      "Draft totals are not computed in this list. Run `infrawrench invoices <number|customer>` " +
        "for a draft's current total. Approved and sent invoices are frozen.",
    ),
  );
}

/** `infrawrench invoices customers`: the managed accounts themselves. */
export async function cmdInvoiceCustomers(ctx: CliContext): Promise<void> {
  requireCloud(ctx);
  const org = await resolveOrg(ctx);
  const accounts = await orgFetch<ManagedAccount[]>(org.id, "/managed-accounts");

  if (ctx.flags.output === "json") {
    printJson({ org: org.id, customers: accounts });
    return;
  }

  if (accounts.length === 0) {
    println(c.dim("No managed accounts. Add one in the Invoices tab to bill a customer."));
    return;
  }

  const columns: Column<ManagedAccount>[] = [
    { header: "name", value: (a) => a.name },
    { header: "currency", value: (a) => a.billingCurrency },
    { header: "basis", value: (a) => c.dim(a.costBasis) },
    {
      header: "rules",
      value: (a) => (a.applyBillingRules ? c.dim("applied") : c.dim("pass-through")),
    },
    {
      header: "scope",
      value: (a) => {
        const centres = a.costCentreIds.length;
        const cloud = a.accountIds.length;
        if (centres === 0 && cloud === 0) return c.yellow("none");
        return [
          centres > 0 ? `${centres} cost centre${centres === 1 ? "" : "s"}` : "",
          cloud > 0 ? `${cloud} account${cloud === 1 ? "" : "s"}` : "",
        ]
          .filter(Boolean)
          .join(", ");
      },
    },
    { header: "invoices", value: (a) => String(a.invoiceCount), align: "right" },
  ];
  printTable(accounts, columns);

  println();
  println(
    c.dim(
      "A customer names cost centres; which spend lands in a centre is decided by the org's " +
        "allocation rules, so an invoice line always matches `infrawrench showback` for the " +
        "same centre and period.",
    ),
  );
}

/** `infrawrench invoices <number|id|customer>`: one invoice, with its derivation. */
export async function cmdInvoice(ctx: CliContext, query: string): Promise<void> {
  requireCloud(ctx);
  const org = await resolveOrg(ctx);
  const invoices = await orgFetch<ManagedInvoiceSummary[]>(org.id, "/invoices");

  const found = matchInvoice(invoices, query);
  if (!found.match) {
    if (found.candidates.length === 0) throw new CliError(`No invoice matches "${query}".`);
    throw new CliError(
      `"${query}" matches ${found.candidates.length} invoices: ${found.candidates
        .map((i) => `${i.number ?? "draft"} (${i.managedAccountName})`)
        .join(", ")}.`,
    );
  }

  // The list carries no lines (a draft's are recomputed on read) so the
  // detail is always a second request rather than a cached half-answer.
  const invoice = await orgFetch<ManagedInvoice>(
    org.id,
    `/invoices/${encodeURIComponent(found.match.id)}`,
  );

  if (ctx.flags.output === "json") {
    printJson({ org: org.id, ...invoice });
    return;
  }

  const d = invoice.derivation;
  println(
    `${c.bold(invoice.number ?? "Draft invoice")} ${c.dim(`· ${invoice.managedAccountName}`)}`,
  );
  println(
    c.dim(
      `${invoice.periodFrom} → ${invoice.periodTo} · ${d.costBasis} basis · ${formatInvoiceStatus(
        invoice,
      )}`,
    ),
  );
  println();
  // The sentence that separates a working document from a sent one.
  println(
    invoice.live
      ? c.yellow(
          "These figures were recomputed just now from live spend and will keep moving as " +
            "providers restate. Approving freezes them.",
        )
      : c.dim(
          `Frozen at approval on ${invoice.computedAt.slice(0, 10)}. No restatement of spend, ` +
            "change of exchange rate, edit of a billing rule or rename can change what this " +
            "document says.",
        ),
  );
  if (invoice.status === "void" && invoice.voidReason) {
    println(c.red(`Voided: ${invoice.voidReason}`));
  }
  // Delivery, when there has been an attempt. Worth a line in a reconciliation
  // script: "sent" is a decision a person made, "delivered" is a thing that
  // either happened or did not, and only the second is checkable here.
  if (invoice.delivery) {
    const { status, delivered, recipients, attemptedAt, error } = invoice.delivery;
    const summary = `Delivery: ${status}, ${delivered}/${recipients.length} recipient${
      recipients.length === 1 ? "" : "s"
    } on ${attemptedAt.slice(0, 10)}`;
    println(status === "succeeded" ? c.dim(summary) : c.yellow(summary));
    if (error) println(c.dim(error));
  }
  println();

  if (invoice.lines.length === 0) {
    println(c.dim("No spend in this period for anything this customer owns."));
  } else {
    const columns: Column<(typeof invoice.lines)[number]>[] = [
      { header: "line", value: (l) => l.label },
      { header: "kind", value: (l) => c.dim(l.kind.replace("_", " ")) },
      {
        header: "collected",
        value: (l) => `${l.collected.toFixed(2)} ${l.currency}`,
        align: "right",
      },
      {
        header: "adjustment",
        value: (l) =>
          l.adjustment === 0 ? c.dim("—") : `${l.adjustment.toFixed(2)} ${l.currency}`,
        align: "right",
      },
      {
        header: "subtotal",
        value: (l) => `${l.adjusted.toFixed(2)} ${l.currency}`,
        align: "right",
      },
      {
        header: "rate",
        value: (l) =>
          l.rate === null ? c.yellow("no rate") : l.rate === 1 ? c.dim("—") : l.rate.toFixed(4),
        align: "right",
      },
      {
        header: "invoiced",
        value: (l) =>
          l.billed === null
            ? `${l.adjusted.toFixed(2)} ${l.currency}`
            : `${l.billed.toFixed(2)} ${invoice.currency}`,
        align: "right",
      },
    ];
    printTable(invoice.lines, columns);
  }

  println();
  println(`  ${c.bold("total")}      ${formatInvoiceTotal(invoice.totals, invoice.currency)}`);
  println();

  // The derivation, spelled out. An invoice a customer cannot reconcile is an
  // invoice a customer does not pay.
  println(c.bold("How this total was reached"));
  const scope = [
    ...d.scope.costCentres.map((s) => s.name),
    ...d.scope.accounts.map((s) => s.label),
  ];
  println(`  scope      ${scope.length > 0 ? scope.join(", ") : c.yellow("nothing")}`);
  println(
    `  rules      ${
      !d.applyBillingRules
        ? "pass-through. No billing rule was applied"
        : d.rules.length === 0
          ? "the organisation has no billing rules"
          : d.rules.map((r) => `${r.name} (${r.summary})`).join("; ")
    }`,
  );
  println(
    `  rates      ${
      d.rates.length === 0
        ? `all spend was already in ${invoice.currency}`
        : d.rates
            .map(
              (r) => `1 ${r.currency} = ${r.rate} ${invoice.currency} (stated ${r.effectiveFrom})`,
            )
            .join("; ")
    }`,
  );
  println(`  rate date  ${d.rateDate}`);
  if (d.unconverted.length > 0) {
    println(
      c.yellow(
        `  warning    no exchange rate stated for ${d.unconverted.join(", ")}. Those amounts ` +
          "are carried in their own currency, and this invoice cannot be approved until a rate " +
          "exists",
      ),
    );
  }
  if (d.missingScope.length > 0) {
    println(
      c.yellow(
        `  warning    ${d.missingScope.length} scope entr${
          d.missingScope.length === 1 ? "y" : "ies"
        } no longer exist and contributed nothing`,
      ),
    );
  }
  if (invoice.supersedesInvoiceId) {
    println(c.dim(`  corrects   an earlier, voided invoice (${invoice.supersedesInvoiceId})`));
  }
  if (invoice.supersededByInvoiceId) {
    println(c.dim(`  superseded by ${invoice.supersededByInvoiceId}`));
  }

  // Who it is addressed to and how it gets paid, when the invoice carries it.
  const b = invoice.billing;
  if (b) {
    println();
    println(c.bold("Billing"));
    println(`  bill to    ${b.legalName}${b.taxId ? c.dim(` · tax ID ${b.taxId}`) : ""}`);
    if (b.poNumber) println(`  PO         ${b.poNumber}`);
    println(
      `  dates      issued ${b.issueDate}` +
        (b.dueDate ? `, due ${b.dueDate} (${describeTerms(b.paymentTermsDays)})` : ", no terms"),
    );
    println(
      `  emailed    ${b.to.length > 0 ? b.to.join(", ") : c.yellow("nobody")}` +
        (b.cc.length > 0 ? c.dim(` · cc ${b.cc.join(", ")}`) : ""),
    );
    if (b.profileName) println(c.dim(`  profile    ${b.profileName}`));
  }
}

/* ------------------------------------------------------------------ *
 * Billing profiles
 * ------------------------------------------------------------------ */

function describeTerms(days: number | null): string {
  if (days === null) return "no terms";
  return days === 0 ? "due on receipt" : `net ${days}`;
}

/**
 * The last four characters only. The terminal is a screen someone may be
 * sharing; `--json` carries the full value for a script that needs it.
 */
export function tail4(value: string | null): string | null {
  if (!value) return null;
  const compact = value.replace(/\s+/g, "");
  return compact.length <= 4 ? "••••" : `•••• ${compact.slice(-4)}`;
}

/**
 * `infrawrench invoices profiles [name]`: the billing profiles customers are
 * assigned to, or one in full.
 */
export async function cmdInvoiceProfiles(ctx: CliContext, query?: string): Promise<void> {
  requireCloud(ctx);
  const org = await resolveOrg(ctx);
  const [profiles, customers] = await Promise.all([
    orgFetch<BillingProfile[]>(org.id, "/billing-profiles"),
    orgFetch<ManagedAccount[]>(org.id, "/managed-accounts"),
  ]);
  const customerName = new Map(customers.map((a) => [a.id, a.name]));

  if (query) {
    const lower = query.toLowerCase();
    const matches = profiles.filter(
      (p) =>
        p.id === query || p.name.toLowerCase() === lower || p.name.toLowerCase().includes(lower),
    );
    const exact = matches.find((p) => p.id === query || p.name.toLowerCase() === lower);
    const profile = exact ?? (matches.length === 1 ? matches[0]! : null);
    if (!profile) {
      if (matches.length === 0) throw new CliError(`No billing profile matches "${query}".`);
      throw new CliError(
        `"${query}" matches ${matches.length} profiles: ${matches.map((p) => p.name).join(", ")}.`,
      );
    }
    if (ctx.flags.output === "json") {
      printJson({ org: org.id, ...profile });
      return;
    }
    println(c.bold(profile.name));
    const rows: Array<[string, string | null]> = [
      ["legal name", profile.legalName ?? c.dim("each customer's own name")],
      ["address", profile.address ? profile.address.replace(/\n/g, ", ") : null],
      ["tax ID", profile.taxId],
      ["PO number", profile.poNumber],
      ["to", profile.toEmails.length > 0 ? profile.toEmails.join(", ") : null],
      ["cc", profile.ccEmails.length > 0 ? profile.ccEmails.join(", ") : null],
      ["currency", profile.currency ?? c.dim("each customer's own")],
      ["terms", describeTerms(profile.paymentTermsDays)],
      [
        "taxes",
        profile.taxRates.length > 0
          ? profile.taxRates.map((t) => `${t.name} ${t.rate}%`).join(", ")
          : c.dim("none"),
      ],
      [
        "numbering",
        `${profile.numberPrefix}${profile.numberIncludesYear ? "-YYYY" : ""}-NNNN, from ${profile.numberStart}`,
      ],
      ["account", profile.bank?.accountName ?? null],
      ["bank", profile.bank?.bankName ?? null],
      ["IBAN", tail4(profile.bank?.iban ?? null)],
      ["SWIFT/BIC", profile.bank?.bic ?? null],
      ["account no.", tail4(profile.bank?.accountNumber ?? null)],
      ["routing", profile.bank?.routingNumber ?? null],
      ["footer", profile.footer],
      ["logo", profile.logo ? "yes" : null],
    ];
    for (const [label, value] of rows) {
      if (value) println(`  ${label.padEnd(12)} ${value}`);
    }
    println(
      `  ${"customers".padEnd(12)} ${
        profile.managedAccountIds.length > 0
          ? profile.managedAccountIds.map((id) => customerName.get(id) ?? id).join(", ")
          : c.dim("none")
      }`,
    );
    return;
  }

  if (ctx.flags.output === "json") {
    printJson({ org: org.id, profiles });
    return;
  }
  if (profiles.length === 0) {
    println(c.dim("No billing profiles. Create one in the Invoices tab, under Billing profiles."));
    return;
  }
  const columns: Column<BillingProfile>[] = [
    { header: "name", value: (p) => p.name },
    { header: "bill to", value: (p) => p.legalName ?? c.dim("customer") },
    { header: "currency", value: (p) => p.currency ?? c.dim("customer") },
    { header: "terms", value: (p) => describeTerms(p.paymentTermsDays) },
    {
      header: "taxes",
      value: (p) =>
        p.taxRates.length > 0
          ? p.taxRates.map((t) => `${t.name} ${t.rate}%`).join(", ")
          : c.dim("—"),
    },
    { header: "prefix", value: (p) => p.numberPrefix },
    { header: "customers", value: (p) => String(p.managedAccountIds.length), align: "right" },
  ];
  printTable(profiles, columns);
  println();
  println(
    c.dim(
      "Drafts follow a profile edit; approved invoices keep the settings they were issued with. " +
        "Run `infrawrench invoices profiles <name>` for one in full.",
    ),
  );
}

/* ------------------------------------------------------------------ *
 * Unassigned spend
 * ------------------------------------------------------------------ */

function formatAmounts(amounts: Record<string, number>): string {
  const entries = Object.entries(amounts).filter(([, v]) => v !== 0);
  if (entries.length === 0) return "0.00";
  return entries
    .sort(([, a], [, b]) => Math.abs(b) - Math.abs(a))
    .map(([currency, amount]) => `${amount.toFixed(2)} ${currency}`)
    .join(" + ");
}

/** The query string for `--from`/`--to`: both or neither, ISO days, in order. */
export function unassignedQuery(range: Pick<RangeFlags, "from" | "to">): string {
  const { from, to } = range;
  if (!from && !to) return "";
  if (!from || !to) {
    throw new CliError("Give both --from and --to, or neither for the last full month.", 2);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    throw new CliError("--from and --to are days, like 2026-01-31.", 2);
  }
  if (to < from) throw new CliError("--to must not be before --from.", 2);
  return `?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
}

/**
 * `infrawrench invoices unassigned [--from YYYY-MM-DD --to YYYY-MM-DD]`:
 * spend no customer is billed for, by cost centre and account. Defaults to
 * the last full month. Exits 0 either way; a script that wants to fail on
 * unassigned spend reads `assignable` from `--json`.
 */
export async function cmdInvoiceUnassigned(
  ctx: CliContext,
  range: Pick<RangeFlags, "from" | "to">,
): Promise<void> {
  requireCloud(ctx);
  const org = await resolveOrg(ctx);
  const query = unassignedQuery(range);
  const report = await orgFetch<UnassignedSpendReport>(
    org.id,
    `/managed-accounts/unassigned${query}`,
  );

  if (ctx.flags.output === "json") {
    printJson({ org: org.id, ...report });
    return;
  }

  println(
    `${c.bold(org.displayName)} ${c.dim(`· ${report.periodFrom} → ${report.periodTo} · amortized, before billing rules`)}`,
  );
  println();
  if (report.rows.length === 0) {
    println(c.green("Every cost in this period is billed to a customer."));
    return;
  }
  const columns: Column<UnassignedSpendReport["rows"][number]>[] = [
    {
      header: "item",
      value: (r) => (r.kind === "unallocated" ? c.dim("(no connected account)") : r.name),
    },
    {
      header: "kind",
      value: (r) =>
        c.dim(
          r.kind === "cost_centre"
            ? "cost centre"
            : r.kind === "account"
              ? (r.pluginId ?? "account")
              : "—",
        ),
    },
    { header: "spend", value: (r) => formatAmounts(r.amounts), align: "right" },
  ];
  printTable(report.rows, columns);
  println();
  println(
    `  ${c.bold("unassigned")} ${formatAmounts(report.totals.unassigned)} ${c.dim(
      `of ${formatAmounts(report.totals.all)}`,
    )}`,
  );
  println();
  println(
    c.dim(
      "Assign these in the Invoices tab (Unassigned spend), or name the cost centre or account " +
        "on a customer.",
    ),
  );
}

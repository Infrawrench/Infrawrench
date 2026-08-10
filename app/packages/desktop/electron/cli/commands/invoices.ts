// `infrawrench invoices` — the customers a managed service provider bills and
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
import type {
  ManagedAccount,
  ManagedInvoice,
  ManagedInvoiceSummary,
} from "@infrawrench/client-core" with { "resolution-mode": "import" };
import { formatInvoiceStatus, formatInvoiceTotal } from "../format";
import { c, printJson, println, printTable, type Column } from "../output";

function requireCloud(ctx: CliContext): void {
  if (ctx.flags.local) {
    throw new CliError(
      "Invoices live in Infrawrench Cloud — they bill for spend collected server-side, and a " +
        "local-only workspace has no collected spend to bill.",
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

/** `infrawrench invoices` — every invoice, newest period first. */
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
      "A draft's figures are recomputed from live spend every time it is read, so the list does " +
        "not compute them — run `infrawrench invoices <number|customer>` for a draft's current " +
        "total. An approved or sent invoice is frozen and cannot change.",
    ),
  );
}

/** `infrawrench invoices customers` — the managed accounts themselves. */
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

/** `infrawrench invoices <number|id|customer>` — one invoice, with its derivation. */
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

  // The list carries no lines — a draft's are recomputed on read — so the
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
    println(c.red(`Voided — ${invoice.voidReason}`));
  }
  // Delivery, when there has been an attempt. Worth a line in a reconciliation
  // script: "sent" is a decision a person made, "delivered" is a thing that
  // either happened or did not, and only the second is checkable here.
  if (invoice.delivery) {
    const { status, delivered, recipients, attemptedAt, error } = invoice.delivery;
    const summary = `Delivery: ${status} — ${delivered}/${recipients.length} recipient${
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
        ? "pass-through — no billing rule was applied"
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
        `  warning    no exchange rate stated for ${d.unconverted.join(", ")} — those amounts ` +
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
}

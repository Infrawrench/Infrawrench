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
// The response schemas are checked against `@infrawrench/client-core` by
// `wire`, type-only, so the CLI still ships zero runtime dependencies.
import { Effect, Option, Schema } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import type {
  BillingProfile,
  ManagedAccount,
  ManagedInvoice,
  ManagedInvoiceSummary,
  UnassignedSpendReport,
} from "@infrawrench/client-core" with { "resolution-mode": "import" };
import { CloudApi, currentOrg, decodeBody } from "../effect/cloud-api";
import { CliFailure, CliUsageError } from "../effect/errors";
import * as Print from "../effect/print";
import { from as fromFlag, to as toFlag } from "../effect/range-flags";
import { CliSession } from "../effect/session";
import { decodePaired, spreadBody, wire } from "../effect/wire";
import { formatInvoiceStatus, formatInvoiceTotal } from "../format";
import { c, safe, type Column } from "../output";

const INVOICES_PATH = "/invoices";
const CUSTOMERS_PATH = "/managed-accounts";
const PROFILES_PATH = "/billing-profiles";

const Totals = Schema.Struct({ billed: Schema.Record(Schema.String, Schema.Finite) });

const Summaries = wire<ManagedInvoiceSummary[]>()(
  Schema.Array(
    Schema.Struct({
      id: Schema.String,
      managedAccountName: Schema.String,
      number: Schema.NullOr(Schema.String),
      status: Schema.String,
      periodFrom: Schema.String,
      periodTo: Schema.String,
      currency: Schema.String,
      totals: Schema.NullOr(Totals),
      issuedAt: Schema.NullOr(Schema.String),
      sentAt: Schema.NullOr(Schema.String),
      voidedAt: Schema.NullOr(Schema.String),
    }),
  ),
);
type Summary = (typeof Summaries.Type)[number];

const Invoice = wire<ManagedInvoice>()(
  Schema.Struct({
    managedAccountName: Schema.String,
    number: Schema.NullOr(Schema.String),
    status: Schema.String,
    periodFrom: Schema.String,
    periodTo: Schema.String,
    currency: Schema.String,
    lines: Schema.Array(
      Schema.Struct({
        kind: Schema.String,
        label: Schema.String,
        currency: Schema.String,
        collected: Schema.Finite,
        adjustment: Schema.Finite,
        adjusted: Schema.Finite,
        rate: Schema.NullOr(Schema.Finite),
        billed: Schema.NullOr(Schema.Finite),
      }),
    ),
    totals: Totals,
    derivation: Schema.Struct({
      costBasis: Schema.String,
      applyBillingRules: Schema.Boolean,
      rateDate: Schema.String,
      rates: Schema.Array(
        Schema.Struct({
          currency: Schema.String,
          rate: Schema.Finite,
          effectiveFrom: Schema.String,
        }),
      ),
      unconverted: Schema.Array(Schema.String),
      rules: Schema.Array(Schema.Struct({ name: Schema.String, summary: Schema.String })),
      scope: Schema.Struct({
        costCentres: Schema.Array(Schema.Struct({ name: Schema.String })),
        accounts: Schema.Array(Schema.Struct({ label: Schema.String })),
      }),
      missingScope: Schema.Array(Schema.String),
    }),
    billing: Schema.NullOr(
      Schema.Struct({
        profileName: Schema.NullOr(Schema.String),
        legalName: Schema.String,
        taxId: Schema.NullOr(Schema.String),
        poNumber: Schema.NullOr(Schema.String),
        to: Schema.Array(Schema.String),
        cc: Schema.Array(Schema.String),
        paymentTermsDays: Schema.NullOr(Schema.Finite),
        issueDate: Schema.String,
        dueDate: Schema.NullOr(Schema.String),
      }),
    ),
    live: Schema.Boolean,
    computedAt: Schema.String,
    issuedAt: Schema.NullOr(Schema.String),
    sentAt: Schema.NullOr(Schema.String),
    delivery: Schema.NullOr(
      Schema.Struct({
        status: Schema.String,
        recipients: Schema.Array(Schema.String),
        delivered: Schema.Finite,
        attemptedAt: Schema.String,
        error: Schema.NullOr(Schema.String),
      }),
    ),
    voidedAt: Schema.NullOr(Schema.String),
    voidReason: Schema.NullOr(Schema.String),
    supersedesInvoiceId: Schema.NullOr(Schema.String),
    supersededByInvoiceId: Schema.NullOr(Schema.String),
  }),
);
type Invoice = typeof Invoice.Type;

const Customers = wire<ManagedAccount[]>()(
  Schema.Array(
    Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      billingCurrency: Schema.String,
      costBasis: Schema.String,
      applyBillingRules: Schema.Boolean,
      costCentreIds: Schema.Array(Schema.String),
      accountIds: Schema.Array(Schema.String),
      invoiceCount: Schema.Finite,
    }),
  ),
);

const TaxRates = Schema.Array(Schema.Struct({ name: Schema.String, rate: Schema.Finite }));
const Profiles = wire<BillingProfile[]>()(
  Schema.Array(
    Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      legalName: Schema.NullOr(Schema.String),
      address: Schema.NullOr(Schema.String),
      taxId: Schema.NullOr(Schema.String),
      poNumber: Schema.NullOr(Schema.String),
      toEmails: Schema.Array(Schema.String),
      ccEmails: Schema.Array(Schema.String),
      currency: Schema.NullOr(Schema.String),
      paymentTermsDays: Schema.NullOr(Schema.Finite),
      numberPrefix: Schema.String,
      numberIncludesYear: Schema.Boolean,
      numberStart: Schema.Finite,
      taxRates: TaxRates,
      bank: Schema.NullOr(
        Schema.Struct({
          accountName: Schema.NullOr(Schema.String),
          bankName: Schema.NullOr(Schema.String),
          iban: Schema.NullOr(Schema.String),
          bic: Schema.NullOr(Schema.String),
          accountNumber: Schema.NullOr(Schema.String),
          routingNumber: Schema.NullOr(Schema.String),
        }),
      ),
      footer: Schema.NullOr(Schema.String),
      logo: Schema.NullOr(Schema.String),
      managedAccountIds: Schema.Array(Schema.String),
    }),
  ),
);
type Profile = (typeof Profiles.Type)[number];

const Amounts = Schema.Record(Schema.String, Schema.Finite);
const Unassigned = wire<UnassignedSpendReport>()(
  Schema.Struct({
    periodFrom: Schema.String,
    periodTo: Schema.String,
    rows: Schema.Array(
      Schema.Struct({
        kind: Schema.String,
        name: Schema.String,
        pluginId: Schema.NullOr(Schema.String),
        amounts: Amounts,
      }),
    ),
    totals: Schema.Struct({ unassigned: Amounts, all: Amounts }),
  }),
);
type UnassignedRow = (typeof Unassigned.Type)["rows"][number];

const refuseLocal = Effect.gen(function* () {
  const session = yield* CliSession;
  if (session.local) {
    return yield* new CliFailure({
      message:
        "Invoices live in Infrawrench Cloud, and a local-only workspace has no collected spend to bill.",
    });
  }
});

/**
 * Match an invoice by id, exact number, or unique case-insensitive substring of
 * the number or the customer name. The same three-tier resolution the report
 * and billing-rule commands use, so `infrawrench invoices INV-2026-0004` and
 * `infrawrench invoices northwind` both work.
 */
function matchInvoice(
  invoices: ReadonlyArray<Summary>,
  query: string,
): { match: Summary | null; candidates: Summary[] } {
  const byId = invoices.find((i) => i.id === query);
  if (byId) return { match: byId, candidates: [] };

  const lower = query.toLowerCase();
  const exact = invoices.filter((i) => (i.number ?? "").toLowerCase() === lower);
  const [oneExact] = exact;
  if (oneExact && exact.length === 1) return { match: oneExact, candidates: [] };

  const partial = invoices.filter(
    (i) =>
      (i.number ?? "").toLowerCase().includes(lower) ||
      i.managedAccountName.toLowerCase().includes(lower),
  );
  const [onePartial] = partial;
  if (onePartial && partial.length === 1) return { match: onePartial, candidates: [] };
  return { match: null, candidates: partial };
}

/** `infrawrench invoices`: every invoice, newest period first. */
const listInvoices = Effect.fnUntraced(function* () {
  yield* refuseLocal;
  const session = yield* CliSession;
  const api = yield* CloudApi;
  const org = yield* currentOrg;
  const body = yield* api.json(org.id, INVOICES_PATH);

  if (session.output === "json") return yield* Print.json({ org: org.id, invoices: body });
  const invoices = yield* decodeBody(Summaries, INVOICES_PATH)(body);

  if (invoices.length === 0) {
    return yield* Print.line(
      c.dim(
        "No invoices. Add a managed account (a customer, with the cost centres whose spend is " +
          "theirs) in the Invoices tab, then raise one.",
      ),
    );
  }

  const drafts = invoices.filter((i) => i.status === "draft").length;
  yield* Print.line(
    `${c.bold(safe(org.displayName))} ${c.dim(
      `· ${invoices.length} invoice${invoices.length === 1 ? "" : "s"}` +
        (drafts > 0 ? `, ${drafts} draft` : ""),
    )}`,
  );
  yield* Print.line();

  yield* Print.table(invoices, [
    { header: "number", value: (i) => (i.number !== null ? safe(i.number) : c.dim("—")) },
    { header: "customer", value: (i) => safe(i.managedAccountName) },
    { header: "period", value: (i) => `${safe(i.periodFrom)} → ${safe(i.periodTo)}` },
    {
      header: "total",
      value: (i) =>
        i.totals ? safe(formatInvoiceTotal(i.totals, i.currency)) : c.dim("not computed"),
      align: "right",
    },
    {
      header: "status",
      value: (i) => {
        const text = safe(formatInvoiceStatus(i));
        if (i.status === "void") return c.red(text);
        if (i.status === "sent") return c.green(text);
        if (i.status === "draft") return c.dim(text);
        return c.blue(text);
      },
    },
  ]);

  yield* Print.line();
  yield* Print.line(
    c.dim(
      "Draft totals are not computed in this list. Run `infrawrench invoices <number|customer>` " +
        "for a draft's current total. Approved and sent invoices are frozen.",
    ),
  );
});

/** `infrawrench invoices customers`: the managed accounts themselves. */
const customers = Command.make(
  "customers",
  {},
  Effect.fn("invoices.customers")(function* () {
    yield* refuseLocal;
    const session = yield* CliSession;
    const api = yield* CloudApi;
    const org = yield* currentOrg;
    const body = yield* api.json(org.id, CUSTOMERS_PATH);

    if (session.output === "json") return yield* Print.json({ org: org.id, customers: body });
    const accounts = yield* decodeBody(Customers, CUSTOMERS_PATH)(body);

    if (accounts.length === 0) {
      return yield* Print.line(
        c.dim("No managed accounts. Add one in the Invoices tab to bill a customer."),
      );
    }

    yield* Print.table(accounts, [
      { header: "name", value: (a) => safe(a.name) },
      { header: "currency", value: (a) => safe(a.billingCurrency) },
      { header: "basis", value: (a) => c.dim(safe(a.costBasis)) },
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
    ]);

    yield* Print.line();
    yield* Print.line(
      c.dim(
        "A customer names cost centres; which spend lands in a centre is decided by the org's " +
          "allocation rules, so an invoice line always matches `infrawrench showback` for the " +
          "same centre and period.",
      ),
    );
  }),
).pipe(
  Command.withDescription(
    "The managed accounts: billing currency, cost basis and the cost centres whose spend is theirs",
  ),
);

/** `infrawrench invoices <number|id|customer>`: one invoice, with its derivation. */
const showInvoice = Effect.fnUntraced(function* (query: string) {
  yield* refuseLocal;
  const session = yield* CliSession;
  const api = yield* CloudApi;
  const org = yield* currentOrg;
  const invoices = yield* api.decode(Summaries, org.id, INVOICES_PATH);

  const found = matchInvoice(invoices, query);
  if (!found.match) {
    return yield* new CliFailure({
      message:
        found.candidates.length === 0
          ? `No invoice matches "${query}".`
          : `"${query}" matches ${found.candidates.length} invoices: ${found.candidates
              .map((i) => `${i.number ?? "draft"} (${i.managedAccountName})`)
              .join(", ")}.`,
    });
  }

  // The list carries no lines (a draft's are recomputed on read) so the
  // detail is always a second request rather than a cached half-answer.
  const path = `${INVOICES_PATH}/${encodeURIComponent(found.match.id)}`;
  const body = yield* api.json(org.id, path);

  if (session.output === "json") {
    return yield* Print.json(yield* spreadBody({ org: org.id }, body, path));
  }
  yield* printInvoice(yield* decodeBody(Invoice, path)(body));
});

const printInvoice = Effect.fnUntraced(function* (invoice: Invoice) {
  const d = invoice.derivation;
  const currency = safe(invoice.currency);
  yield* Print.line(
    `${c.bold(invoice.number !== null ? safe(invoice.number) : "Draft invoice")} ${c.dim(`· ${safe(invoice.managedAccountName)}`)}`,
  );
  yield* Print.line(
    c.dim(
      `${safe(invoice.periodFrom)} → ${safe(invoice.periodTo)} · ${safe(d.costBasis)} basis · ${safe(
        formatInvoiceStatus(invoice),
      )}`,
    ),
  );
  yield* Print.line();
  // The sentence that separates a working document from a sent one.
  yield* Print.line(
    invoice.live
      ? c.yellow(
          "These figures were recomputed just now from live spend and will keep moving as " +
            "providers restate. Approving freezes them.",
        )
      : c.dim(
          `Frozen at approval on ${safe(invoice.computedAt.slice(0, 10))}. No restatement of spend, ` +
            "change of exchange rate, edit of a billing rule or rename can change what this " +
            "document says.",
        ),
  );
  if (invoice.status === "void" && invoice.voidReason) {
    yield* Print.line(c.red(`Voided: ${safe(invoice.voidReason)}`));
  }
  // Delivery, when there has been an attempt. Worth a line in a reconciliation
  // script: "sent" is a decision a person made, "delivered" is a thing that
  // either happened or did not, and only the second is checkable here.
  if (invoice.delivery) {
    const { status, delivered, recipients, attemptedAt, error } = invoice.delivery;
    const summary = `Delivery: ${safe(status)}, ${delivered}/${recipients.length} recipient${
      recipients.length === 1 ? "" : "s"
    } on ${safe(attemptedAt.slice(0, 10))}`;
    yield* Print.line(status === "succeeded" ? c.dim(summary) : c.yellow(summary));
    if (error) yield* Print.line(c.dim(safe(error)));
  }
  yield* Print.line();

  if (invoice.lines.length === 0) {
    yield* Print.line(c.dim("No spend in this period for anything this customer owns."));
  } else {
    const columns: Column<Invoice["lines"][number]>[] = [
      { header: "line", value: (l) => safe(l.label) },
      { header: "kind", value: (l) => c.dim(safe(l.kind.replace("_", " "))) },
      {
        header: "collected",
        value: (l) => `${l.collected.toFixed(2)} ${safe(l.currency)}`,
        align: "right",
      },
      {
        header: "adjustment",
        value: (l) =>
          l.adjustment === 0 ? c.dim("—") : `${l.adjustment.toFixed(2)} ${safe(l.currency)}`,
        align: "right",
      },
      {
        header: "subtotal",
        value: (l) => `${l.adjusted.toFixed(2)} ${safe(l.currency)}`,
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
            ? `${l.adjusted.toFixed(2)} ${safe(l.currency)}`
            : `${l.billed.toFixed(2)} ${currency}`,
        align: "right",
      },
    ];
    yield* Print.table(invoice.lines, columns);
  }

  yield* Print.line();
  yield* Print.line(
    `  ${c.bold("total")}      ${safe(formatInvoiceTotal(invoice.totals, invoice.currency))}`,
  );
  yield* Print.line();

  // The derivation, spelled out. An invoice a customer cannot reconcile is an
  // invoice a customer does not pay.
  yield* Print.line(c.bold("How this total was reached"));
  const scope = [
    ...d.scope.costCentres.map((s) => safe(s.name)),
    ...d.scope.accounts.map((s) => safe(s.label)),
  ];
  yield* Print.line(`  scope      ${scope.length > 0 ? scope.join(", ") : c.yellow("nothing")}`);
  yield* Print.line(
    `  rules      ${
      !d.applyBillingRules
        ? "pass-through. No billing rule was applied"
        : d.rules.length === 0
          ? "the organisation has no billing rules"
          : d.rules.map((r) => `${safe(r.name)} (${safe(r.summary)})`).join("; ")
    }`,
  );
  yield* Print.line(
    `  rates      ${
      d.rates.length === 0
        ? `all spend was already in ${currency}`
        : d.rates
            .map(
              (r) =>
                `1 ${safe(r.currency)} = ${r.rate} ${currency} (stated ${safe(r.effectiveFrom)})`,
            )
            .join("; ")
    }`,
  );
  yield* Print.line(`  rate date  ${safe(d.rateDate)}`);
  if (d.unconverted.length > 0) {
    yield* Print.line(
      c.yellow(
        `  warning    no exchange rate stated for ${d.unconverted.map(safe).join(", ")}. Those amounts ` +
          "are carried in their own currency, and this invoice cannot be approved until a rate " +
          "exists",
      ),
    );
  }
  if (d.missingScope.length > 0) {
    yield* Print.line(
      c.yellow(
        `  warning    ${d.missingScope.length} scope entr${
          d.missingScope.length === 1 ? "y" : "ies"
        } no longer exist and contributed nothing`,
      ),
    );
  }
  if (invoice.supersedesInvoiceId) {
    yield* Print.line(
      c.dim(`  corrects   an earlier, voided invoice (${safe(invoice.supersedesInvoiceId)})`),
    );
  }
  if (invoice.supersededByInvoiceId) {
    yield* Print.line(c.dim(`  superseded by ${safe(invoice.supersededByInvoiceId)}`));
  }

  // Who it is addressed to and how it gets paid, when the invoice carries it.
  const b = invoice.billing;
  if (b) {
    yield* Print.line();
    yield* Print.line(c.bold("Billing"));
    yield* Print.line(
      `  bill to    ${safe(b.legalName)}${b.taxId ? c.dim(` · tax ID ${safe(b.taxId)}`) : ""}`,
    );
    if (b.poNumber) yield* Print.line(`  PO         ${safe(b.poNumber)}`);
    yield* Print.line(
      `  dates      issued ${safe(b.issueDate)}` +
        (b.dueDate
          ? `, due ${safe(b.dueDate)} (${describeTerms(b.paymentTermsDays)})`
          : ", no terms"),
    );
    yield* Print.line(
      `  emailed    ${b.to.length > 0 ? b.to.map(safe).join(", ") : c.yellow("nobody")}` +
        (b.cc.length > 0 ? c.dim(` · cc ${b.cc.map(safe).join(", ")}`) : ""),
    );
    if (b.profileName) yield* Print.line(c.dim(`  profile    ${safe(b.profileName)}`));
  }
});

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

const taxText = (rates: Profile["taxRates"]) =>
  rates.map((t) => `${safe(t.name)} ${t.rate}%`).join(", ");

/**
 * `infrawrench invoices profiles [name]`: the billing profiles customers are
 * assigned to, or one in full.
 */
const profiles = Command.make(
  "profiles",
  {
    name: Argument.String("name").pipe(
      Argument.withDescription("One profile in full (the words join into one name)"),
      Argument.variadic(),
    ),
  },
  Effect.fn("invoices.profiles")(function* (input) {
    yield* refuseLocal;
    const session = yield* CliSession;
    const api = yield* CloudApi;
    const org = yield* currentOrg;
    const [profilesBody, accounts] = yield* Effect.all(
      [api.json(org.id, PROFILES_PATH), api.decode(Customers, org.id, CUSTOMERS_PATH)],
      { concurrency: "unbounded" },
    );
    const all = yield* decodePaired(Profiles, PROFILES_PATH)(profilesBody);
    const customerName = new Map(accounts.map((a) => [a.id, a.name]));
    const query = input.name.join(" ");

    if (query) {
      const lower = query.toLowerCase();
      const matches = all.filter(
        ({ row: p }) =>
          p.id === query || p.name.toLowerCase() === lower || p.name.toLowerCase().includes(lower),
      );
      const exact = matches.find(({ row: p }) => p.id === query || p.name.toLowerCase() === lower);
      const [onlyMatch] = matches;
      const found = exact ?? (onlyMatch && matches.length === 1 ? onlyMatch : null);
      if (!found) {
        return yield* new CliFailure({
          message:
            matches.length === 0
              ? `No billing profile matches "${query}".`
              : `"${query}" matches ${matches.length} profiles: ${matches.map((p) => p.row.name).join(", ")}.`,
        });
      }
      if (session.output === "json") {
        return yield* Print.json(yield* spreadBody({ org: org.id }, found.raw, PROFILES_PATH));
      }
      const profile = found.row;
      yield* Print.line(c.bold(safe(profile.name)));
      const show = (value: string | null) => (value === null ? null : safe(value));
      const rows: Array<[string, string | null]> = [
        [
          "legal name",
          profile.legalName !== null ? safe(profile.legalName) : c.dim("each customer's own name"),
        ],
        ["address", profile.address ? safe(profile.address.replace(/\n/g, ", ")) : null],
        ["tax ID", show(profile.taxId)],
        ["PO number", show(profile.poNumber)],
        ["to", profile.toEmails.length > 0 ? profile.toEmails.map(safe).join(", ") : null],
        ["cc", profile.ccEmails.length > 0 ? profile.ccEmails.map(safe).join(", ") : null],
        [
          "currency",
          profile.currency !== null ? safe(profile.currency) : c.dim("each customer's own"),
        ],
        ["terms", describeTerms(profile.paymentTermsDays)],
        ["taxes", profile.taxRates.length > 0 ? taxText(profile.taxRates) : c.dim("none")],
        [
          "numbering",
          `${safe(profile.numberPrefix)}${profile.numberIncludesYear ? "-YYYY" : ""}-NNNN, from ${profile.numberStart}`,
        ],
        ["account", show(profile.bank?.accountName ?? null)],
        ["bank", show(profile.bank?.bankName ?? null)],
        ["IBAN", show(tail4(profile.bank?.iban ?? null))],
        ["SWIFT/BIC", show(profile.bank?.bic ?? null)],
        ["account no.", show(tail4(profile.bank?.accountNumber ?? null))],
        ["routing", show(profile.bank?.routingNumber ?? null)],
        ["footer", show(profile.footer)],
        ["logo", profile.logo ? "yes" : null],
      ];
      for (const [label, value] of rows) {
        if (value) yield* Print.line(`  ${label.padEnd(12)} ${value}`);
      }
      return yield* Print.line(
        `  ${"customers".padEnd(12)} ${
          profile.managedAccountIds.length > 0
            ? profile.managedAccountIds.map((id) => safe(customerName.get(id) ?? id)).join(", ")
            : c.dim("none")
        }`,
      );
    }

    if (session.output === "json")
      return yield* Print.json({ org: org.id, profiles: profilesBody });
    if (all.length === 0) {
      return yield* Print.line(
        c.dim("No billing profiles. Create one in the Invoices tab, under Billing profiles."),
      );
    }
    yield* Print.table(
      all.map((p) => p.row),
      [
        { header: "name", value: (p) => safe(p.name) },
        {
          header: "bill to",
          value: (p) => (p.legalName !== null ? safe(p.legalName) : c.dim("customer")),
        },
        {
          header: "currency",
          value: (p) => (p.currency !== null ? safe(p.currency) : c.dim("customer")),
        },
        { header: "terms", value: (p) => describeTerms(p.paymentTermsDays) },
        {
          header: "taxes",
          value: (p) => (p.taxRates.length > 0 ? taxText(p.taxRates) : c.dim("—")),
        },
        { header: "prefix", value: (p) => safe(p.numberPrefix) },
        { header: "customers", value: (p) => String(p.managedAccountIds.length), align: "right" },
      ],
    );
    yield* Print.line();
    yield* Print.line(
      c.dim(
        "Drafts follow a profile edit; approved invoices keep the settings they were issued with. " +
          "Run `infrawrench invoices profiles <name>` for one in full.",
      ),
    );
  }),
).pipe(
  Command.withDescription(
    "Billing profiles: addressee, tax, terms, numbering and the customers on each; a name shows one",
  ),
);

/* ------------------------------------------------------------------ *
 * Unassigned spend
 * ------------------------------------------------------------------ */

function formatAmounts(amounts: Readonly<Record<string, number>>): string {
  const entries = Object.entries(amounts).filter(([, v]) => v !== 0);
  if (entries.length === 0) return "0.00";
  return entries
    .sort(([, a], [, b]) => Math.abs(b) - Math.abs(a))
    .map(([currency, amount]) => `${amount.toFixed(2)} ${safe(currency)}`)
    .join(" + ");
}

/** The query string for `--from`/`--to`: both or neither, ISO days, in order. */
export function unassignedQuery(range: {
  readonly from?: string | undefined;
  readonly to?: string | undefined;
}): string | CliUsageError {
  const { from, to } = range;
  if (!from && !to) return "";
  if (!from || !to) {
    return new CliUsageError({
      message: "Give both --from and --to, or neither for the last full month.",
    });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    return new CliUsageError({ message: "--from and --to are days, like 2026-01-31." });
  }
  if (to < from) return new CliUsageError({ message: "--to must not be before --from." });
  return `?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
}

/**
 * `infrawrench invoices unassigned [--from YYYY-MM-DD --to YYYY-MM-DD]`:
 * spend no customer is billed for, by cost centre and account. Defaults to
 * the last full month. Exits 0 either way; a script that wants to fail on
 * unassigned spend reads `assignable` from `--json`.
 */
const unassigned = Command.make(
  "unassigned",
  {
    from: fromFlag.pipe(Flag.withDescription("First day, YYYY-MM-DD (with --to)")),
    to: toFlag.pipe(Flag.withDescription("Last day, YYYY-MM-DD (default: the last full month)")),
  },
  Effect.fn("invoices.unassigned")(function* (input) {
    yield* refuseLocal;
    const session = yield* CliSession;
    const api = yield* CloudApi;
    const org = yield* currentOrg;
    const query = unassignedQuery({
      from: Option.getOrUndefined(input.from),
      to: Option.getOrUndefined(input.to),
    });
    if (query instanceof CliUsageError) return yield* query;
    const path = `${CUSTOMERS_PATH}/unassigned${query}`;
    const body = yield* api.json(org.id, path);

    if (session.output === "json") {
      return yield* Print.json(yield* spreadBody({ org: org.id }, body, path));
    }
    const report = yield* decodeBody(Unassigned, path)(body);

    yield* Print.line(
      `${c.bold(safe(org.displayName))} ${c.dim(`· ${safe(report.periodFrom)} → ${safe(report.periodTo)} · amortized, before billing rules`)}`,
    );
    yield* Print.line();
    if (report.rows.length === 0) {
      return yield* Print.line(c.green("Every cost in this period is billed to a customer."));
    }
    const columns: Column<UnassignedRow>[] = [
      {
        header: "item",
        value: (r) => (r.kind === "unallocated" ? c.dim("(no connected account)") : safe(r.name)),
      },
      {
        header: "kind",
        value: (r) =>
          c.dim(
            r.kind === "cost_centre"
              ? "cost centre"
              : r.kind === "account"
                ? safe(r.pluginId ?? "account")
                : "—",
          ),
      },
      { header: "spend", value: (r) => formatAmounts(r.amounts), align: "right" },
    ];
    yield* Print.table(report.rows, columns);
    yield* Print.line();
    yield* Print.line(
      `  ${c.bold("unassigned")} ${formatAmounts(report.totals.unassigned)} ${c.dim(
        `of ${formatAmounts(report.totals.all)}`,
      )}`,
    );
    yield* Print.line();
    yield* Print.line(
      c.dim(
        "Assign these in the Invoices tab (Unassigned spend), or name the cost centre or account " +
          "on a customer.",
      ),
    );
  }),
).pipe(
  Command.withDescription(
    "Spend no customer is billed for, by cost centre and account (default: the last full month)",
  ),
);

// Read-only on purpose. Approving an invoice freezes the figures a customer
// will be sent and sending one states that they have them; both ride
// `invoices:issue` and carry an audit entry naming a person, which is not a
// thing to make one flag away in a shell.
export const invoices = Command.make(
  "invoices",
  {
    query: Argument.String("number|id|customer").pipe(
      Argument.withDescription("One invoice in full (the words join into one query)"),
      Argument.variadic(),
    ),
  },
  Effect.fn("invoices")(function* (input) {
    if (input.query.length > 0) return yield* showInvoice(input.query.join(" "));
    yield* listInvoices();
  }),
).pipe(
  Command.withDescription(
    "Invoices raised against managed accounts (customers), newest first; give one to see it in full",
  ),
  Command.withSubcommands([customers, profiles, unassigned]),
);

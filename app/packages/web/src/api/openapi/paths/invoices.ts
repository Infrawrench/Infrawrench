import { z } from "../zod";
import { strict, ErrorResponses, Ok, OrgIdParam, Uuid, IsoDateTime } from "../common";
import type { BuildContext } from "../context";
import { PdfBody } from "./dashboard-notifications";
import {
  BILLING_RULE_KIND_ENUM,
  ManagedAccountPricing,
  PricingEffect,
  PricingExpressionFailure,
  RerateCoverage,
} from "./billing-rules";

const IsoDay = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .openapi({ format: "date", example: "2026-01-31" });

const CurrencyAmounts = z
  .record(z.string(), z.number())
  .openapi({ description: "Currency code → amount in the currency's major unit." });

/* ------------------------------------------------------------------ *
 * Managed accounts
 * ------------------------------------------------------------------ */

const ManagedAccountInput = strict({
  name: z.string().min(1).max(120).openapi({ example: "Northwind Trading" }),
  contactName: z.string().max(120).nullish(),
  contactEmail: z.string().max(254).nullish(),
  billingAddress: z.string().max(1000).nullish(),
  billingCurrency: z
    .string()
    .regex(/^[A-Za-z]{3}$/)
    .openapi({
      description:
        "ISO 4217 code the customer is invoiced in. Spend collected in another currency is " +
        "converted through the organisation's own stated exchange rates, and the rate used is " +
        "frozen onto every invoice; so restating a rate later cannot restate history.",
      example: "GBP",
    }),
  costBasis: z
    .enum(["cash", "amortized", "blended"])
    .optional()
    .openapi({
      description:
        "Defaults to `amortized`. Charging a customer the whole cash value of a three-year " +
        "commitment in the month it was signed is not a bill anyone can budget against. " +
        "`blended` spreads each commitment's discount evenly over all the usage it could " +
        "cover, so a customer is not billed more or less depending on which account the " +
        "provider happened to apply a shared commitment to.",
    }),
  applyBillingRules: z
    .boolean()
    .optional()
    .openapi({
      description:
        "Defaults to true. False is a pass-through contract: the customer is billed exactly what " +
        "the providers charged, with no markup, discount or fixed fee applied.",
    }),
  pricing: ManagedAccountPricing.optional().openapi({
    description:
      "Re-rating to public pricing and discount treatment. Absent on update leaves the saved " +
      "settings unchanged; absent on create means nothing is re-rated and everything passes " +
      "through.",
  }),
  notes: z.string().max(4000).nullish(),
  billingProfileId: Uuid.nullish().openapi({
    description:
      "The billing profile this customer's invoices are addressed, taxed and numbered by. " +
      "Absent on update leaves the saved profile; null removes it.",
  }),
  costCentreIds: z
    .array(z.string().min(1))
    .max(100)
    .default([])
    .openapi({
      description:
        "Cost centres whose spend belongs to this customer. **Subtrees are included**; naming a " +
        "parent bills every descendant, and naming both a parent and its child bills the child " +
        "once, not twice.\n\n" +
        "This is deliberately a list of existing cost centres rather than a rule of its own. " +
        "Which spend lands in which centre is already decided by the organisation's allocation " +
        "rules, and a second vocabulary over the same data would eventually disagree with the " +
        "first: at which point an invoice would stop matching the showback report the customer " +
        "was shown.",
    }),
  accountIds: z
    .array(z.string().min(1))
    .max(100)
    .default([])
    .openapi({
      description:
        "Cloud accounts whose spend belongs to this customer. Evaluated **after** every " +
        "allocation rule, so an account in scope claims only the spend no cost centre already " +
        "claimed. Every cost row therefore resolves exactly once: nothing is billed twice and " +
        "nothing goes missing.",
    }),
}).openapi("ManagedAccountInput");

const ManagedAccount = strict({
  id: Uuid,
  name: z.string(),
  contactName: z.string().nullable(),
  contactEmail: z.string().nullable(),
  billingAddress: z.string().nullable(),
  billingCurrency: z.string(),
  costBasis: z.enum(["cash", "amortized", "blended"]),
  applyBillingRules: z.boolean(),
  pricing: ManagedAccountPricing,
  notes: z.string().nullable(),
  billingProfileId: Uuid.nullable(),
  costCentreIds: z.array(z.string()),
  accountIds: z.array(z.string()),
  invoiceCount: z.number().int(),
  createdByUserId: z.string().nullable(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
}).openapi("ManagedAccount", {
  description:
    "A customer a managed service provider bills. A cost centre or cloud account belongs to at " +
    "most one managed account; billing the same money to two customers is refused at write " +
    "time with a 409 naming the other customer.",
});

/* ------------------------------------------------------------------ *
 * Billing profiles
 * ------------------------------------------------------------------ */

const BillingProfileTaxRate = strict({
  name: z.string().min(1).max(40).openapi({ example: "VAT" }),
  rate: z.number().min(0).max(100).openapi({ description: "Percent.", example: 20 }),
}).openapi("BillingProfileTaxRate", {
  description:
    "A tax applied to the invoice subtotal as its own line. Several rates each apply to the " +
    "same subtotal; they do not compound.",
});

const BillingProfileBank = strict({
  accountName: z.string().max(120).nullable(),
  bankName: z.string().max(120).nullable(),
  iban: z
    .string()
    .max(64)
    .nullable()
    .openapi({
      description:
        "Checked against its mod-97 digits and stored grouped in fours. Masked to its last four " +
        "characters in audit entries.",
    }),
  bic: z.string().max(11).nullable().openapi({ description: "SWIFT / BIC." }),
  accountNumber: z.string().max(64).nullable().openapi({
    description: "For banking systems without IBANs. Masked in audit entries.",
  }),
  routingNumber: z
    .string()
    .max(64)
    .nullable()
    .openapi({ description: "Sort code, ABA routing number, BSB." }),
  instructions: z.string().max(2000).nullable().openapi({
    description: "Free-text remittance instructions, printed under the bank details.",
  }),
}).openapi("BillingProfileBank");

const BillingProfileBankInput = strict({
  accountName: z.string().max(120).nullish(),
  bankName: z.string().max(120).nullish(),
  iban: z.string().max(64).nullish(),
  bic: z.string().max(11).nullish(),
  accountNumber: z.string().max(64).nullish(),
  routingNumber: z.string().max(64).nullish(),
  instructions: z.string().max(2000).nullish(),
}).openapi("BillingProfileBankInput");

const BillingProfileInput = strict({
  name: z.string().min(1).max(120).openapi({
    description: "What the profile is called in pickers. Not printed on the invoice.",
    example: "EU customers",
  }),
  legalName: z.string().max(200).nullish().openapi({
    description: "The legal entity invoices are addressed to. Null leaves each customer's name.",
  }),
  address: z.string().max(1000).nullish().openapi({
    description: "Printed under the legal name. Null leaves each customer's billing address.",
  }),
  taxId: z.string().max(64).nullish().openapi({ description: "Tax ID or VAT number." }),
  poNumber: z.string().max(64).nullish().openapi({ description: "Purchase-order reference." }),
  toEmails: z.array(z.string().max(254)).max(20).optional().openapi({
    description:
      "Addresses invoices are emailed to, **in addition to** each customer's own contact email.",
  }),
  ccEmails: z.array(z.string().max(254)).max(20).optional().openapi({
    description: "Addresses that receive a copy. Each address gets its own message.",
  }),
  currency: z
    .string()
    .regex(/^[A-Za-z]{3}$/)
    .nullish()
    .openapi({
      description:
        "ISO 4217. When set, invoices for every assigned customer are issued in this currency " +
        "instead of the customer's billing currency.",
    }),
  paymentTermsDays: z.number().int().min(0).max(365).nullish().openapi({
    description: "Net N days from the issue date. Null prints no due date; 0 is due on receipt.",
  }),
  numberPrefix: z
    .string()
    .min(1)
    .max(16)
    .optional()
    .openapi({
      description:
        "Starts with a letter; letters, digits and hyphens. Defaults to `INV`. Profiles sharing a " +
        "prefix share a sequence.",
      example: "INV",
    }),
  numberIncludesYear: z
    .boolean()
    .optional()
    .openapi({
      description:
        "Defaults to true: `INV-2026-0001`, with the sequence restarting each year of the period " +
        "end. False gives `INV-0001` and one sequence for ever.",
    }),
  numberStart: z.number().int().min(1).max(999_999_999).optional().openapi({
    description:
      "The lowest sequence number issued, for continuing a sequence from another system.",
  }),
  taxRates: z.array(BillingProfileTaxRate).max(5).optional(),
  bank: BillingProfileBankInput.nullish(),
  footer: z.string().max(2000).nullish().openapi({
    description: "Printed at the bottom of every page of the PDF.",
  }),
  logo: z
    .string()
    .nullish()
    .openapi({
      description:
        "A PNG or JPEG `data:` URL of at most 100 KB, printed at the top of the PDF. Interlaced " +
        "and 16-bit PNGs and CMYK JPEGs are refused. Absent on update leaves the saved logo; null " +
        "removes it.",
    }),
}).openapi("BillingProfileInput");

const BillingProfile = strict({
  id: Uuid,
  name: z.string(),
  legalName: z.string().nullable(),
  address: z.string().nullable(),
  taxId: z.string().nullable(),
  poNumber: z.string().nullable(),
  toEmails: z.array(z.string()),
  ccEmails: z.array(z.string()),
  currency: z.string().nullable(),
  paymentTermsDays: z.number().int().nullable(),
  numberPrefix: z.string(),
  numberIncludesYear: z.boolean(),
  numberStart: z.number().int(),
  taxRates: z.array(BillingProfileTaxRate),
  bank: BillingProfileBank.nullable(),
  footer: z.string().nullable(),
  logo: z.string().nullable(),
  managedAccountIds: z
    .array(Uuid)
    .openapi({ description: "Live customers assigned to this profile." }),
  createdByUserId: z.string().nullable(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
}).openapi("BillingProfile", {
  description:
    "Reusable invoice settings: addressee, recipients, tax, payment terms, remittance details " +
    "and numbering, shared by every customer assigned to it. The profile wins where it sets a " +
    "field and the customer fills the gaps; recipients are the union of both.\n\n" +
    "Drafts follow a profile edit. **Approved invoices do not**: approval writes a resolved copy " +
    "onto the invoice (`Invoice.billing`), so a new bank account or tax rate reaches the next " +
    "invoice and no issued one.",
});

const InvoiceBilling = strict({
  profileId: Uuid.nullable(),
  profileName: z.string().nullable(),
  legalName: z.string(),
  attention: z.string().nullable(),
  address: z.string().nullable(),
  taxId: z.string().nullable(),
  poNumber: z.string().nullable(),
  to: z.array(z.string()),
  cc: z.array(z.string()),
  paymentTermsDays: z.number().int().nullable(),
  issueDate: IsoDay,
  dueDate: IsoDay.nullable(),
  taxRates: z.array(BillingProfileTaxRate),
  bank: BillingProfileBank.nullable(),
  footer: z.string().nullable(),
  logoId: z
    .string()
    .nullable()
    .openapi({ description: "SHA-256 of the logo printed on the PDF, frozen with the invoice." }),
  numberPrefix: z.string(),
  numberIncludesYear: z.boolean(),
}).openapi("InvoiceBilling", {
  description:
    "Who the invoice is addressed to and how to pay it: the customer and its billing profile " +
    "resolved together. Live on a draft; written once at approval and read back verbatim after.",
});

/* ------------------------------------------------------------------ *
 * Scope tools
 * ------------------------------------------------------------------ */

const UnassignedSpendReport = strict({
  periodFrom: IsoDay,
  periodTo: IsoDay,
  rows: z.array(
    strict({
      kind: z.enum(["cost_centre", "account", "unallocated"]).openapi({
        description:
          "`unallocated` is spend that resolved to no cost centre and no connected account " +
          "(a disconnected account, an uploaded source); it cannot be assigned.",
      }),
      id: z.string().nullable(),
      name: z.string().openapi({ description: "Cost centres carry their full path." }),
      pluginId: z.string().nullable(),
      amounts: CurrencyAmounts,
    }),
  ),
  totals: strict({
    unassigned: CurrencyAmounts,
    assigned: CurrencyAmounts,
    all: CurrencyAmounts,
  }),
  assignable: z.number().int(),
}).openapi("UnassignedSpendReport", {
  description:
    "Spend in the period no customer is billed for. Resolved exactly the way an invoice " +
    "resolves it: allocation rules claim spend for cost centres first, and each account claims " +
    "only what no rule did. A cost centre is assigned when it or any ancestor is on a customer. " +
    "Raw spend on the amortized basis, before billing rules.",
});

const ManagedAccountAssignment = strict({
  managedAccountId: Uuid.nullable().openapi({
    description: "The customer to assign to, or null to take the items off every customer.",
  }),
  costCentreIds: z.array(z.string().min(1)).max(500).default([]),
  accountIds: z.array(z.string().min(1)).max(500).default([]),
}).openapi("ManagedAccountAssignment");

const ManagedAccountAssignmentPreviewRequest = ManagedAccountAssignment.extend({
  periodFrom: IsoDay.optional(),
  periodTo: IsoDay.optional(),
}).openapi("ManagedAccountAssignmentPreviewRequest", {
  description: "The period whose spend is previewed defaults to the last full calendar month.",
});

const ManagedAccountAssignmentPreview = strict({
  periodFrom: IsoDay,
  periodTo: IsoDay,
  target: strict({ id: Uuid, name: z.string() }).nullable(),
  items: z.array(
    strict({
      kind: z.enum(["cost_centre", "account"]),
      id: z.string(),
      name: z.string(),
      fromManagedAccountId: Uuid.nullable(),
      fromManagedAccountName: z.string().nullable(),
      amounts: CurrencyAmounts.openapi({
        description:
          "Spend that moves with the item: a cost centre's whole subtree, an account's spend no " +
          "cost centre claimed.",
      }),
      unchanged: z.boolean(),
    }),
  ),
  moves: z.array(
    strict({
      fromManagedAccountId: Uuid.nullable(),
      fromManagedAccountName: z.string().nullable(),
      amounts: CurrencyAmounts,
    }),
  ),
  total: CurrencyAmounts,
  affectedDrafts: z.number().int(),
  warnings: z.array(z.string()),
}).openapi("ManagedAccountAssignmentPreview");

const ManagedAccountAssignmentResult = strict({
  changes: z.array(
    strict({
      id: Uuid,
      name: z.string(),
      before: strict({ costCentreIds: z.array(z.string()), accountIds: z.array(z.string()) }),
      after: strict({ costCentreIds: z.array(z.string()), accountIds: z.array(z.string()) }),
    }),
  ),
  accounts: z.array(ManagedAccount),
}).openapi("ManagedAccountAssignmentResult");

/* ------------------------------------------------------------------ *
 * Invoices
 * ------------------------------------------------------------------ */

const InvoiceStatus = z.enum(["draft", "approved", "sent", "void"]).openapi("InvoiceStatus", {
  description:
    "`draft` → `approved` → `sent`, plus `void` from either issued state.\n\n" +
    "**A draft recomputes its figures from live spend on every read; an approved, sent or void " +
    "invoice never does.** Approval is the freeze: the lines, the totals, the exchange rates and " +
    "the day they were read, the billing rules in force and the names of everything in scope are " +
    "written onto the invoice, and no later restatement of spend, change of rate, edit of a rule " +
    "or rename can alter what the document says.\n\n" +
    "An issued invoice is never edited and never deleted. A wrong one is voided with a reason " +
    "and superseded by a corrective invoice; both survive. The server enforces this, not just " +
    "the UI.",
});

const InvoiceLine = strict({
  kind: z.enum(["cost_centre", "account", "fixed", "tax"]).openapi({
    description:
      "`tax` lines come from the customer's billing profile: one per tax rate, on the " +
      "converted subtotal of every other line, always last.",
  }),
  refId: z.string().nullable().openapi({
    description: "Cost-centre id, account id, or null for an org-level fixed charge or a tax.",
  }),
  label: z.string().openapi({
    description:
      "The name at issue time, frozen with the numbers; renaming a cost centre in March must " +
      "not retitle a line on January's invoice.",
  }),
  currency: z.string().openapi({ description: "The currency the providers billed in." }),
  collected: z.number().openapi({
    description: "What the providers charged for this scope, before any billing rule.",
  }),
  adjustment: z
    .number()
    .openapi({ description: "What the organisation's billing rules added or removed." }),
  adjusted: z.number().openapi({ description: "`collected + adjustment`." }),
  rate: z
    .number()
    .nullable()
    .openapi({
      description:
        "The rate applied to reach `billed`. 1 when the line is already in the invoice currency; " +
        "null when the organisation has stated no rate for this currency, in which case the " +
        "amount is carried in its own currency rather than dropped or invented.",
    }),
  billed: z
    .number()
    .nullable()
    .openapi({ description: "`adjusted × rate`, in the invoice currency." }),
  effects: z
    .array(strict({ key: z.string(), amount: z.number() }))
    .optional()
    .openapi({
      description:
        "What moved this line, in pipeline order and in the line's currency: one entry per " +
        "re-rating step, discount treatment or billing rule. Sums to `adjustment`. `key` " +
        "matches an entry in the derivation's `effects`. Absent on invoices approved before the " +
        "breakdown existed.",
    }),
}).openapi("InvoiceLine", {
  description:
    "One scope entry in one collected currency. Two currencies for one cost centre are two " +
    "lines, not one blended line, because the conversion is a separately reconcilable step.",
});

const InvoiceTotals = strict({
  collected: CurrencyAmounts,
  adjustment: CurrencyAmounts,
  adjusted: CurrencyAmounts,
  billed: CurrencyAmounts.openapi({
    description:
      "Keyed by the invoice currency, plus any currency that could not be converted; which " +
      "keeps its own key so the total is never quietly short.",
  }),
}).openapi("InvoiceTotals", {
  description:
    "`collected + adjustment === adjusted` holds for every currency. That identity is what makes " +
    "an invoice reconcilable back to the spend that produced it, and it is checked before " +
    "anything is frozen.",
});

const InvoiceDerivation = strict({
  costBasis: z.enum(["cash", "amortized", "blended"]),
  applyBillingRules: z.boolean(),
  rateDate: IsoDay.openapi({
    description:
      "The day the exchange rates were read; always the period's last day. One rate for the " +
      "period rather than a per-day blend: “January, at the 31 January rate” is a sentence a " +
      "finance team can reproduce.",
  }),
  rates: z.array(strict({ currency: z.string(), rate: z.number(), effectiveFrom: IsoDay })),
  unconverted: z.array(z.string()).openapi({
    description:
      "Currencies the organisation had stated no usable rate for. A non-empty list blocks " +
      "approval: an invoice that cannot be expressed as one number in the customer's currency " +
      "must not be frozen.",
  }),
  rules: z.array(
    strict({
      id: Uuid,
      name: z.string(),
      kind: z.enum(BILLING_RULE_KIND_ENUM),
      summary: z.string(),
    }),
  ),
  scope: strict({
    costCentres: z.array(strict({ id: z.string(), name: z.string() })),
    accounts: z.array(strict({ id: z.string(), label: z.string() })),
  }),
  missingScope: z.array(z.string()).openapi({
    description:
      "Scope entries that no longer exist. Recorded rather than silently skipped; an invoice " +
      "that is quietly short is worse than one that says why.",
  }),
  pricing: ManagedAccountPricing.optional().openapi({
    description: "The customer's pricing settings at issue time, frozen with the figures.",
  }),
  effects: z
    .array(PricingEffect)
    .optional()
    .openapi({
      description:
        "Every rule or setting that moved money, in pipeline order, with its total per currency: " +
        "the per-invoice answer to which rule changed what.",
    }),
  rerateCoverage: RerateCoverage.nullish().openapi({
    description: "How much in-scope usage was re-rated from a list price. Null when off.",
  }),
  warnings: z.array(z.string()).optional(),
  expressionFailures: z.array(PricingExpressionFailure).optional(),
}).openapi("InvoiceDerivation", {
  description:
    "Everything needed to re-derive the invoice by hand. Not decoration: an invoice a customer " +
    "cannot reconcile is an invoice a customer does not pay.",
});

const InvoiceDelivery = strict({
  status: z.enum(["pending", "succeeded", "partial", "failed", "no_targets"]).openapi({
    description:
      "`pending` means an attempt was claimed and its outcome never recorded; the process " +
      "died mid-send, so whether the customer received it is unknown. It is not a failure and " +
      "is never retried automatically.",
  }),
  recipients: z.array(z.string()).openapi({
    description: "The addresses this attempt was made to, as the customer record had them then.",
  }),
  delivered: z.number().int().openapi({ description: "How many the mail provider accepted." }),
  attemptedAt: IsoDateTime,
  deliveredAt: IsoDateTime.nullable().openapi({
    description:
      "The last attempt that reached at least one address, or null when none ever has. Never " +
      "cleared by a later failure; it is a fact about the past, and it is what decides whether " +
      "sending again is a retry or a second copy.",
  }),
  attempts: z.number().int(),
  error: z.string().nullable(),
}).openapi("InvoiceDelivery", {
  description:
    "What became of the last attempt to email this invoice to its customer. Separate from the " +
    "figures in every sense: delivery records where a frozen document went and cannot restate " +
    "what it says.\n\n" +
    "**A partial delivery is terminal.** The mail provider has no idempotency key, so retrying " +
    "after some addresses succeeded would put a second copy of the same bill in inboxes that " +
    "already have it.",
});

const InvoiceSummary = strict({
  id: Uuid,
  managedAccountId: Uuid,
  managedAccountName: z.string(),
  number: z
    .string()
    .nullable()
    .openapi({
      description:
        "`INV-2026-0001`. Null while draft: numbers are assigned at approval so a deleted draft " +
        "cannot leave a gap in the sequence.",
      example: "INV-2026-0001",
    }),
  status: InvoiceStatus,
  periodFrom: IsoDay,
  periodTo: IsoDay,
  currency: z.string(),
  totals: InvoiceTotals.nullable().openapi({
    description:
      "**Null for a draft**, null, not zero. A draft's figures are recomputed on read and the " +
      "list does not recompute; fetch the invoice by id for a draft's current numbers.",
  }),
  issuedAt: IsoDateTime.nullable(),
  sentAt: IsoDateTime.nullable(),
  delivery: InvoiceDelivery.nullable().openapi({
    description:
      "The last delivery attempt, or null when none has been made; including on an invoice " +
      "marked sent by a deployment with no mail provider. “A person released this” and “we " +
      "delivered it” are different claims, and this field is only ever the second.",
  }),
  voidedAt: IsoDateTime.nullable(),
  voidReason: z.string().nullable(),
  supersedesInvoiceId: Uuid.nullable(),
  supersededByInvoiceId: Uuid.nullable(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
}).openapi("InvoiceSummary");

const Invoice = InvoiceSummary.extend({
  notes: z.string().nullable(),
  lines: z.array(InvoiceLine),
  totals: InvoiceTotals,
  derivation: InvoiceDerivation,
  billing: InvoiceBilling.nullable().openapi({
    description:
      "Addressee, recipients, terms and remittance details. Null on invoices approved before " +
      "billing profiles existed.",
  }),
  live: z.boolean().openapi({
    description:
      "True when the figures in this response were recomputed for it; true for a draft, false " +
      "for everything else. Say so: “these numbers will move” and “these numbers are what we " +
      "sent” are different claims about the same fields.",
  }),
  computedAt: IsoDateTime,
  approvedByUserId: z.string().nullable(),
  sentByUserId: z.string().nullable(),
  voidedByUserId: z.string().nullable(),
  createdByUserId: z.string().nullable(),
}).openapi("Invoice");

const InvoiceInput = strict({
  managedAccountId: Uuid,
  periodFrom: IsoDay,
  periodTo: IsoDay,
  notes: z.string().max(4000).nullish(),
  supersedesInvoiceId: Uuid.nullish().openapi({
    description:
      "The void invoice this one corrects. The original must already be void; a correction that " +
      "leaves the original standing means the customer holds two live invoices for one period.",
  }),
}).openapi("InvoiceInput", {
  description:
    "A new invoice is always a draft. There is no status field and no scope field: generating " +
    "and issuing are two acts, and the scope comes from the customer.",
});

const InvoiceUpdate = strict({
  periodFrom: IsoDay,
  periodTo: IsoDay,
  notes: z.string().max(4000).nullish(),
}).openapi("InvoiceUpdate");

const InvoiceSendRequest = strict({
  resend: z
    .boolean()
    .default(false)
    .openapi({
      description:
        "Send another copy of an invoice that has already reached somebody. Required only in " +
        "that case: retrying a delivery that reached nobody (`failed`, `no_targets`) needs no " +
        "flag, because there is no inbox to duplicate into. Refused with 409 without it when the " +
        "last attempt landed, or when its outcome is unknown (`pending`).",
    }),
}).openapi("InvoiceSendRequest");

const InvoiceVoidRequest = strict({
  reason: z.string().min(1).max(1000).openapi({
    description:
      "Required. The only record of why a customer was sent an invoice that was then withdrawn.",
  }),
  supersede: z
    .boolean()
    .default(false)
    .openapi({
      description:
        "Raise the corrective draft in the same call, linked both ways to the original. Doing it " +
        "in one call is what keeps the pair from being left half-made by a failed second request.",
    }),
}).openapi("InvoiceVoidRequest");

const InvoiceVoidResponse = strict({
  invoice: Invoice,
  replacement: Invoice.nullable(),
}).openapi("InvoiceVoidResponse");

export function registerInvoicePaths(ctx: BuildContext) {
  const { registry } = ctx;
  const accountIdParam = OrgIdParam.extend({
    id: Uuid.openapi({ param: { name: "id", in: "path" } }),
  });
  const invoiceIdParam = OrgIdParam.extend({
    id: Uuid.openapi({ param: { name: "id", in: "path" } }),
  });

  /* -- managed accounts -- */

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/managed-accounts",
    tags: ["Managed Accounts"],
    summary: "List managed accounts",
    description:
      "The customers a managed service provider bills. A managed account references existing " +
      "cost centres rather than defining its own matching rules, so the spend on an invoice is " +
      "the same spend the showback report attributes to those centres.",
    request: { params: OrgIdParam },
    responses: {
      200: {
        description: "Customers, name-sorted",
        content: { "application/json": { schema: z.array(ManagedAccount) } },
      },
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/managed-accounts",
    tags: ["Managed Accounts"],
    summary: "Create a managed account",
    description:
      "Refused with 409 when a cost centre or account named here is already billed to another " +
      "customer. The error names the other customer, because “it conflicts” without saying with " +
      "whom sends the caller hunting.",
    request: {
      params: OrgIdParam,
      body: { content: { "application/json": { schema: ManagedAccountInput } }, required: true },
    },
    responses: {
      200: { description: "Created", content: { "application/json": { schema: ManagedAccount } } },
      400: ErrorResponses[400],
      409: ErrorResponses[409],
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/managed-accounts/{id}",
    tags: ["Managed Accounts"],
    summary: "Get a managed account",
    request: { params: accountIdParam },
    responses: {
      200: {
        description: "The customer",
        content: { "application/json": { schema: ManagedAccount } },
      },
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "put",
    path: "/api/org/{orgId}/managed-accounts/{id}",
    tags: ["Managed Accounts"],
    summary: "Update a managed account",
    description:
      "A full replace. Editing the scope changes what **future** drafts are drawn over and " +
      "nothing else: every approved invoice holds its own copy of the scope, so moving a cost " +
      "centre between customers cannot re-bill a period that has already been invoiced.",
    request: {
      params: accountIdParam,
      body: { content: { "application/json": { schema: ManagedAccountInput } }, required: true },
    },
    responses: {
      200: { description: "Updated", content: { "application/json": { schema: ManagedAccount } } },
      400: ErrorResponses[400],
      404: ErrorResponses[404],
      409: ErrorResponses[409],
    },
  });

  registry.registerPath({
    method: "delete",
    path: "/api/org/{orgId}/managed-accounts/{id}",
    tags: ["Managed Accounts"],
    summary: "Retire a managed account",
    description:
      "A soft delete: an issued invoice names its customer, and an invoice whose customer stopped " +
      "resolving is exactly the unreconcilable document this feature exists to prevent. Draft " +
      "invoices are removed with it; a draft was never issued.",
    request: { params: accountIdParam },
    responses: {
      200: { description: "Retired", content: { "application/json": { schema: Ok } } },
      404: ErrorResponses[404],
    },
  });

  /* -- scope tools -- */

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/managed-accounts/unassigned",
    tags: ["Managed Accounts"],
    summary: "Find spend no customer is billed for",
    description:
      "Spend in the period, by cost centre and account, that no managed account's scope " +
      "covers. Requires `costs:read` as well as `invoices:read`: it is a cost breakdown of the " +
      "whole organisation.",
    request: {
      params: OrgIdParam,
      query: strict({
        from: IsoDay.optional().openapi({
          description: "Defaults, with `to`, to the last full calendar month.",
        }),
        to: IsoDay.optional(),
      }),
    },
    responses: {
      200: {
        description: "Unassigned spend",
        content: { "application/json": { schema: UnassignedSpendReport } },
      },
      400: ErrorResponses[400],
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/managed-accounts/assignments/preview",
    tags: ["Managed Accounts"],
    summary: "Preview a bulk assignment",
    description:
      "What moving these cost centres and accounts would do: who holds each one today, the " +
      "spend that moves with it in the period, the totals leaving each customer, and how many " +
      "draft invoices will change. Nothing is written.",
    request: {
      params: OrgIdParam,
      body: {
        content: { "application/json": { schema: ManagedAccountAssignmentPreviewRequest } },
        required: true,
      },
    },
    responses: {
      200: {
        description: "The preview",
        content: { "application/json": { schema: ManagedAccountAssignmentPreview } },
      },
      400: ErrorResponses[400],
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/managed-accounts/assignments",
    tags: ["Managed Accounts"],
    summary: "Assign cost centres and accounts to a customer in bulk",
    description:
      "Takes each item off whichever customer holds it and gives it to `managedAccountId`, or " +
      "to nobody when that is null, in one transaction. Only drafts change: an approved " +
      "invoice carries its own copy of its scope.",
    request: {
      params: OrgIdParam,
      body: {
        content: { "application/json": { schema: ManagedAccountAssignment } },
        required: true,
      },
    },
    responses: {
      200: {
        description: "The customers whose scope changed, and the full list after",
        content: { "application/json": { schema: ManagedAccountAssignmentResult } },
      },
      400: ErrorResponses[400],
    },
  });

  /* -- billing profiles -- */

  const profileIdParam = OrgIdParam.extend({
    id: Uuid.openapi({ param: { name: "id", in: "path" } }),
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/billing-profiles",
    tags: ["Billing Profiles"],
    summary: "List billing profiles",
    request: { params: OrgIdParam },
    responses: {
      200: {
        description: "Profiles, name-sorted",
        content: { "application/json": { schema: z.array(BillingProfile) } },
      },
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/billing-profiles",
    tags: ["Billing Profiles"],
    summary: "Create a billing profile",
    request: {
      params: OrgIdParam,
      body: { content: { "application/json": { schema: BillingProfileInput } }, required: true },
    },
    responses: {
      200: { description: "Created", content: { "application/json": { schema: BillingProfile } } },
      400: ErrorResponses[400],
      409: ErrorResponses[409],
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/billing-profiles/{id}",
    tags: ["Billing Profiles"],
    summary: "Get a billing profile",
    request: { params: profileIdParam },
    responses: {
      200: {
        description: "The profile",
        content: { "application/json": { schema: BillingProfile } },
      },
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "put",
    path: "/api/org/{orgId}/billing-profiles/{id}",
    tags: ["Billing Profiles"],
    summary: "Update a billing profile",
    description:
      "A full replace, except `logo`, which is left as saved when absent. Draft invoices of the " +
      "assigned customers follow the change; approved invoices keep the copy frozen onto them.",
    request: {
      params: profileIdParam,
      body: { content: { "application/json": { schema: BillingProfileInput } }, required: true },
    },
    responses: {
      200: { description: "Updated", content: { "application/json": { schema: BillingProfile } } },
      400: ErrorResponses[400],
      404: ErrorResponses[404],
      409: ErrorResponses[409],
    },
  });

  registry.registerPath({
    method: "delete",
    path: "/api/org/{orgId}/billing-profiles/{id}",
    tags: ["Billing Profiles"],
    summary: "Delete a billing profile",
    description:
      "Refused with 409, naming them, while live customers are assigned: removing a profile " +
      "out from under a customer would change the address, tax and numbering of its next invoice.",
    request: { params: profileIdParam },
    responses: {
      200: { description: "Deleted", content: { "application/json": { schema: Ok } } },
      404: ErrorResponses[404],
      409: ErrorResponses[409],
    },
  });

  /* -- invoices -- */

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/invoices/{id}/pdf",
    tags: ["Invoices"],
    summary: "Download an invoice as PDF",
    description:
      "The document a customer files: addressee, lines, tax, total, due date and remittance " +
      "details, from the billing block frozen at approval. A draft is watermarked. The " +
      "collected-versus-adjusted derivation stays in the CSV.",
    request: { params: invoiceIdParam },
    responses: {
      200: {
        description: "PDF",
        content: PdfBody,
      },
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/invoices",
    tags: ["Invoices"],
    summary: "List invoices",
    description:
      "Summaries, newest period first. A draft's `totals` is null here rather than recomputed; " +
      "recomputing every draft would make opening the list one cost-data scan per draft, and " +
      "zero would be a lie the reader cannot detect.",
    request: {
      params: OrgIdParam,
      query: strict({
        managedAccountId: Uuid.optional(),
        status: InvoiceStatus.optional(),
      }),
    },
    responses: {
      200: {
        description: "Invoices",
        content: { "application/json": { schema: z.array(InvoiceSummary) } },
      },
      400: ErrorResponses[400],
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/invoices",
    tags: ["Invoices"],
    summary: "Raise a draft invoice",
    description:
      "Always lands in `draft`. Generating and issuing are two acts on two permissions: a " +
      "mistyped period must not be able to reach a customer without anyone having read the " +
      "numbers.",
    request: {
      params: OrgIdParam,
      body: { content: { "application/json": { schema: InvoiceInput } }, required: true },
    },
    responses: {
      200: { description: "Created", content: { "application/json": { schema: Invoice } } },
      400: ErrorResponses[400],
      404: ErrorResponses[404],
      409: ErrorResponses[409],
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/invoices/{id}",
    tags: ["Invoices"],
    summary: "Get an invoice",
    description:
      "**A draft recomputes from live spend; an approved, sent or void invoice does not.** " +
      "`live` says which happened. A frozen invoice returns the figures written at approval and " +
      "does not read cost data at all.",
    request: { params: invoiceIdParam },
    responses: {
      200: { description: "The invoice", content: { "application/json": { schema: Invoice } } },
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/invoices/{id}/export",
    tags: ["Invoices"],
    summary: "Download an invoice as CSV",
    description:
      "The derivation, not a rendered document: what was collected, what the rules added, the " +
      "rate and the day it was read, and the final figure; every column an accounts-payable " +
      "clerk needs to check the arithmetic. Same RFC 4180 quoting as the scheduled cost exports.",
    request: { params: invoiceIdParam },
    responses: {
      200: {
        description: "CSV",
        content: { "text/csv": { schema: z.string() } },
      },
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "put",
    path: "/api/org/{orgId}/invoices/{id}",
    tags: ["Invoices"],
    summary: "Edit a draft invoice",
    description:
      "Draft only. An approved, sent or void invoice is refused with 409 by the service, not " +
      "merely hidden by the UI; an issued invoice that silently changed after the customer " +
      "received it is the worst outcome this feature could produce.",
    request: {
      params: invoiceIdParam,
      body: { content: { "application/json": { schema: InvoiceUpdate } }, required: true },
    },
    responses: {
      200: { description: "Updated", content: { "application/json": { schema: Invoice } } },
      400: ErrorResponses[400],
      404: ErrorResponses[404],
      409: ErrorResponses[409],
    },
  });

  registry.registerPath({
    method: "delete",
    path: "/api/org/{orgId}/invoices/{id}",
    tags: ["Invoices"],
    summary: "Delete a draft invoice",
    description:
      "Draft only, and refused with 409 otherwise. An issued invoice is voided; deleting one " +
      "would erase a document a customer holds a copy of.",
    request: { params: invoiceIdParam },
    responses: {
      200: { description: "Deleted", content: { "application/json": { schema: Ok } } },
      404: ErrorResponses[404],
      409: ErrorResponses[409],
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/invoices/{id}/approve",
    tags: ["Invoices"],
    summary: "Approve an invoice; freeze its figures",
    description:
      "Computes the figures one last time and writes them onto the invoice together with the " +
      "exchange rates, the day they were read, the billing rules in force and the names " +
      "everything in scope had. From here the invoice is a document, not a query.\n\n" +
      "A distinct act from generation, on a distinct permission (`invoices:issue`), with its own " +
      "audit entry recording who approved what.\n\n" +
      "Refused with 409 when a currency in the invoice has no stated exchange rate: an approved " +
      "invoice has to be quotable as one number in the customer's currency.\n\n" +
      "Refused with 409, too, when the draft or its customer changed while the figures were " +
      "being computed: a different period, scope, currency, cost basis or billing-rules " +
      "setting. Nothing is approved in that case: freezing figures that describe a different " +
      "question would be worse than making the caller look again.",
    request: { params: invoiceIdParam },
    responses: {
      200: { description: "Approved", content: { "application/json": { schema: Invoice } } },
      404: ErrorResponses[404],
      409: ErrorResponses[409],
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/invoices/{id}/send",
    tags: ["Invoices"],
    summary: "Send an invoice to its customer",
    description:
      "Changes no figure; the document was frozen at approval. It records the **release** " +
      "(this may go to the customer, and this person said so), then emails the invoice to the " +
      "customer's contact addresses and its billing profile's To and Cc, as frozen at approval, " +
      "with the PDF and the CSV attached.\n\n" +
      "**200 even when delivery failed.** The release happened and is recorded either way; " +
      "`delivery` says what became of the transport. An error status would leave the caller " +
      "unable to tell which of the two failed. A failed delivery is visible, and re-sending " +
      "retries it.\n\n" +
      "Sending again needs `resend: true` only when the last attempt reached somebody, see " +
      "`InvoiceSendRequest`. The body may be omitted entirely for a first send.",
    request: {
      params: invoiceIdParam,
      body: { content: { "application/json": { schema: InvoiceSendRequest } }, required: false },
    },
    responses: {
      200: {
        description: "Released, with the delivery outcome",
        content: { "application/json": { schema: Invoice } },
      },
      400: ErrorResponses[400],
      404: ErrorResponses[404],
      409: ErrorResponses[409],
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/invoices/{id}/void",
    tags: ["Invoices"],
    summary: "Void an issued invoice",
    description:
      "The only correction there is. The original keeps every figure it was sent with: “we " +
      "billed you this, it was wrong, here is the corrected one” is a story a customer can " +
      "follow, and “we changed the invoice” is not.\n\n" +
      "With `supersede`, the void, the corrective draft and both directions of the link between " +
      "them are one transaction. Void is irreversible, so a half-applied correction would leave " +
      "a withdrawn invoice with no way forward; this call either applies whole or not at all.",
    request: {
      params: invoiceIdParam,
      body: { content: { "application/json": { schema: InvoiceVoidRequest } }, required: true },
    },
    responses: {
      200: {
        description: "Voided, with the corrective draft when one was requested",
        content: { "application/json": { schema: InvoiceVoidResponse } },
      },
      400: ErrorResponses[400],
      404: ErrorResponses[404],
      409: ErrorResponses[409],
    },
  });
}

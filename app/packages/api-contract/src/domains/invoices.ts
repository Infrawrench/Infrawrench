/**
 * Managed accounts and their invoices: `/api/org/:orgId/managed-accounts`
 * and `/api/org/:orgId/invoices`, the endpoint definitions.
 *
 * ## The permission split, and why it is its own family
 *
 * Reads ride **`invoices:read`**, not `costs:read`. Every other cost surface is
 * the organisation looking at its own spend; this one holds a customer's
 * contact details and the price that customer was quoted, which is commercial
 * information about a third party. A member who can read a cost graph has not
 * thereby been given the customer book.
 *
 * Preparation rides **`invoices:write`**: create a customer, raise a draft,
 * edit a period, delete a draft. All of it revisable, none of it visible
 * outside the organisation.
 *
 * Issuing rides **`invoices:issue`**: approve, send, void. Approval freezes
 * the numbers; sending states that the customer has them; voiding withdraws a
 * document already in their hands. None of the three can be taken back, and the
 * split is what lets an org have a billing clerk prepare a month's invoices
 * while only the finance lead issues them.
 *
 * Deliberately **not** `org:settings:write`, where billing rules and exchange
 * rates ride. Raising invoices is operational work that recurs every month, and
 * it should not require handing someone SSO, seats and the org's whole money
 * story.
 *
 * The bodies are the shared schemas the customer and invoice editors validate
 * with (`@infrawrench/api-contract/schemas`).
 */
import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/http-api";
import {
  BILLING_RULE_KINDS,
  COST_BASES,
  MANAGED_INVOICE_DELIVERY_STATUSES,
  MANAGED_INVOICE_STATUSES,
} from "@infrawrench/client-core";
import {
  BillingProfileTaxRate,
  ManagedAccountAssignment,
  ManagedAccountAssignmentPreview,
  ManagedAccountInput,
  ManagedAccountPricing,
  ManagedInvoiceInput,
  ManagedInvoiceSend,
  ManagedInvoiceUpdate,
  ManagedInvoiceVoid,
  NonEmptyString,
} from "../schemas";
import {
  DocumentedPermission,
  InvalidRequestMessage,
  RequiredPermission,
  SuccessDescription,
} from "../http/annotations";
import { withApiDefaults } from "../http/api-defaults";
import { BadRequest, Conflict, Forbidden, NotFound } from "../http/errors";
import { OrgAuth } from "../http/middleware-tags";
import { documentedAs, optionalRequestBody } from "../http/schemas/documented";
import { IsoDateTime, Ok, OrgIdParams, OrgParams, Uuid } from "../http/schemas/common";
import {
  BillingProfileBank,
  CurrencyAmounts,
  InvoiceDay,
  invoiceDay,
} from "../http/schemas/invoicing";
import { PricingEffect, PricingExpressionFailure, RerateCoverage } from "../http/schemas/pricing";

const CostBasis = Schema.Literals(COST_BASES);

/* ------------------------------------------------------------------ *
 * Managed accounts
 * ------------------------------------------------------------------ */

export const ManagedAccount = Schema.Struct({
  id: Uuid,
  name: Schema.String,
  contactName: Schema.NullOr(Schema.String),
  contactEmail: Schema.NullOr(Schema.String),
  billingAddress: Schema.NullOr(Schema.String),
  billingCurrency: Schema.String,
  costBasis: CostBasis,
  applyBillingRules: Schema.Boolean,
  pricing: ManagedAccountPricing,
  notes: Schema.NullOr(Schema.String),
  billingProfileId: Schema.NullOr(Uuid),
  costCentreIds: Schema.Array(Schema.String),
  accountIds: Schema.Array(Schema.String),
  invoiceCount: Schema.Int,
  createdByUserId: Schema.NullOr(Schema.String),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
}).annotate({
  identifier: "ManagedAccount",
  description:
    "A customer a managed service provider bills. A cost centre or cloud account belongs to at " +
    "most one managed account; billing the same money to two customers is refused at write " +
    "time with a 409 naming the other customer.",
});

/* -- scope tools -- */

export const UnassignedSpendReport = Schema.Struct({
  periodFrom: InvoiceDay,
  periodTo: InvoiceDay,
  rows: Schema.Array(
    Schema.Struct({
      kind: Schema.Literals(["cost_centre", "account", "unallocated"]).annotate({
        description:
          "`unallocated` is spend that resolved to no cost centre and no connected account " +
          "(a disconnected account, an uploaded source); it cannot be assigned.",
      }),
      id: Schema.NullOr(Schema.String),
      name: Schema.String.annotate({ description: "Cost centres carry their full path." }),
      pluginId: Schema.NullOr(Schema.String),
      amounts: CurrencyAmounts,
    }),
  ),
  totals: Schema.Struct({
    unassigned: CurrencyAmounts,
    assigned: CurrencyAmounts,
    all: CurrencyAmounts,
  }),
  assignable: Schema.Int,
}).annotate({
  identifier: "UnassignedSpendReport",
  description:
    "Spend in the period no customer is billed for. Resolved exactly the way an invoice " +
    "resolves it: allocation rules claim spend for cost centres first, and each account claims " +
    "only what no rule did. A cost centre is assigned when it or any ancestor is on a customer. " +
    "Raw spend on the amortized basis, before billing rules.",
});

/** What the preview reports; the request is the shared `ManagedAccountAssignmentPreview`. */
export const ManagedAccountAssignmentPreviewResult = Schema.Struct({
  periodFrom: InvoiceDay,
  periodTo: InvoiceDay,
  target: Schema.NullOr(Schema.Struct({ id: Uuid, name: Schema.String })),
  items: Schema.Array(
    Schema.Struct({
      kind: Schema.Literals(["cost_centre", "account"]),
      id: Schema.String,
      name: Schema.String,
      fromManagedAccountId: Schema.NullOr(Uuid),
      fromManagedAccountName: Schema.NullOr(Schema.String),
      amounts: CurrencyAmounts.annotate({
        description:
          "Spend that moves with the item: a cost centre's whole subtree, an account's spend no " +
          "cost centre claimed.",
      }),
      unchanged: Schema.Boolean,
    }),
  ),
  moves: Schema.Array(
    Schema.Struct({
      fromManagedAccountId: Schema.NullOr(Uuid),
      fromManagedAccountName: Schema.NullOr(Schema.String),
      amounts: CurrencyAmounts,
    }),
  ),
  total: CurrencyAmounts,
  affectedDrafts: Schema.Int,
  warnings: Schema.Array(Schema.String),
}).annotate({ identifier: "ManagedAccountAssignmentPreview" });

const ScopeIds = Schema.Struct({
  costCentreIds: Schema.Array(Schema.String),
  accountIds: Schema.Array(Schema.String),
});

export const ManagedAccountAssignmentResult = Schema.Struct({
  changes: Schema.Array(
    Schema.Struct({ id: Uuid, name: Schema.String, before: ScopeIds, after: ScopeIds }),
  ),
  accounts: Schema.Array(ManagedAccount),
}).annotate({ identifier: "ManagedAccountAssignmentResult" });

/* ------------------------------------------------------------------ *
 * Invoices
 * ------------------------------------------------------------------ */

export const InvoiceStatus = Schema.Literals(MANAGED_INVOICE_STATUSES).annotate({
  identifier: "InvoiceStatus",
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

const InvoiceLine = Schema.Struct({
  kind: Schema.Literals(["cost_centre", "account", "fixed", "tax"]).annotate({
    description:
      "`tax` lines come from the customer's billing profile: one per tax rate, on the " +
      "converted subtotal of every other line, always last.",
  }),
  refId: Schema.NullOr(Schema.String).annotate({
    description: "Cost-centre id, account id, or null for an org-level fixed charge or a tax.",
  }),
  label: Schema.String.annotate({
    description:
      "The name at issue time, frozen with the numbers; renaming a cost centre in March must " +
      "not retitle a line on January's invoice.",
  }),
  currency: Schema.String.annotate({ description: "The currency the providers billed in." }),
  collected: Schema.Finite.annotate({
    description: "What the providers charged for this scope, before any billing rule.",
  }),
  adjustment: Schema.Finite.annotate({
    description: "What the organisation's billing rules added or removed.",
  }),
  adjusted: Schema.Finite.annotate({ description: "`collected + adjustment`." }),
  rate: Schema.NullOr(Schema.Finite).annotate({
    description:
      "The rate applied to reach `billed`. 1 when the line is already in the invoice currency; " +
      "null when the organisation has stated no rate for this currency, in which case the " +
      "amount is carried in its own currency rather than dropped or invented.",
  }),
  billed: Schema.NullOr(Schema.Finite).annotate({
    description: "`adjusted × rate`, in the invoice currency.",
  }),
  effects: Schema.optionalKey(
    Schema.Array(Schema.Struct({ key: Schema.String, amount: Schema.Finite })).annotate({
      description:
        "What moved this line, in pipeline order and in the line's currency: one entry per " +
        "re-rating step, discount treatment or billing rule. Sums to `adjustment`. `key` " +
        "matches an entry in the derivation's `effects`. Absent on invoices approved before the " +
        "breakdown existed.",
    }),
  ),
}).annotate({
  identifier: "InvoiceLine",
  description:
    "One scope entry in one collected currency. Two currencies for one cost centre are two " +
    "lines, not one blended line, because the conversion is a separately reconcilable step.",
});

const InvoiceTotals = Schema.Struct({
  collected: CurrencyAmounts,
  adjustment: CurrencyAmounts,
  adjusted: CurrencyAmounts,
  billed: CurrencyAmounts.annotate({
    description:
      "Keyed by the invoice currency, plus any currency that could not be converted; which " +
      "keeps its own key so the total is never quietly short.",
  }),
}).annotate({
  identifier: "InvoiceTotals",
  description:
    "`collected + adjustment === adjusted` holds for every currency. That identity is what makes " +
    "an invoice reconcilable back to the spend that produced it, and it is checked before " +
    "anything is frozen.",
});

const InvoiceDerivation = Schema.Struct({
  costBasis: CostBasis,
  applyBillingRules: Schema.Boolean,
  rateDate: invoiceDay({
    description:
      "The day the exchange rates were read; always the period's last day. One rate for the " +
      "period rather than a per-day blend: “January, at the 31 January rate” is a sentence a " +
      "finance team can reproduce.",
  }),
  rates: Schema.Array(
    Schema.Struct({ currency: Schema.String, rate: Schema.Finite, effectiveFrom: InvoiceDay }),
  ),
  unconverted: Schema.Array(Schema.String).annotate({
    description:
      "Currencies the organisation had stated no usable rate for. A non-empty list blocks " +
      "approval: an invoice that cannot be expressed as one number in the customer's currency " +
      "must not be frozen.",
  }),
  rules: Schema.Array(
    Schema.Struct({
      id: Uuid,
      name: Schema.String,
      kind: Schema.Literals(BILLING_RULE_KINDS),
      summary: Schema.String,
    }),
  ),
  scope: Schema.Struct({
    costCentres: Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String })),
    accounts: Schema.Array(Schema.Struct({ id: Schema.String, label: Schema.String })),
  }),
  missingScope: Schema.Array(Schema.String).annotate({
    description:
      "Scope entries that no longer exist. Recorded rather than silently skipped; an invoice " +
      "that is quietly short is worse than one that says why.",
  }),
  pricing: Schema.optionalKey(ManagedAccountPricing).annotateKey({
    description: "The customer's pricing settings at issue time, frozen with the figures.",
  }),
  effects: Schema.optionalKey(
    Schema.Array(PricingEffect).annotate({
      description:
        "Every rule or setting that moved money, in pipeline order, with its total per currency: " +
        "the per-invoice answer to which rule changed what.",
    }),
  ),
  rerateCoverage: Schema.optionalKey(
    Schema.NullOr(RerateCoverage).annotate({
      description: "How much in-scope usage was re-rated from a list price. Null when off.",
    }),
  ),
  warnings: Schema.optionalKey(Schema.Array(Schema.String)),
  expressionFailures: Schema.optionalKey(Schema.Array(PricingExpressionFailure)),
}).annotate({
  identifier: "InvoiceDerivation",
  description:
    "Everything needed to re-derive the invoice by hand. Not decoration: an invoice a customer " +
    "cannot reconcile is an invoice a customer does not pay.",
});

const InvoiceDelivery = Schema.Struct({
  status: Schema.Literals(MANAGED_INVOICE_DELIVERY_STATUSES).annotate({
    description:
      "`pending` means an attempt was claimed and its outcome never recorded; the process " +
      "died mid-send, so whether the customer received it is unknown. It is not a failure and " +
      "is never retried automatically.",
  }),
  recipients: Schema.Array(Schema.String).annotate({
    description: "The addresses this attempt was made to, as the customer record had them then.",
  }),
  delivered: Schema.Int.annotate({ description: "How many the mail provider accepted." }),
  attemptedAt: IsoDateTime,
  deliveredAt: Schema.NullOr(IsoDateTime).annotate({
    description:
      "The last attempt that reached at least one address, or null when none ever has. Never " +
      "cleared by a later failure; it is a fact about the past, and it is what decides whether " +
      "sending again is a retry or a second copy.",
  }),
  attempts: Schema.Int,
  error: Schema.NullOr(Schema.String),
}).annotate({
  identifier: "InvoiceDelivery",
  description:
    "What became of the last attempt to email this invoice to its customer. Separate from the " +
    "figures in every sense: delivery records where a frozen document went and cannot restate " +
    "what it says.\n\n" +
    "**A partial delivery is terminal.** The mail provider has no idempotency key, so retrying " +
    "after some addresses succeeded would put a second copy of the same bill in inboxes that " +
    "already have it.",
});

const InvoiceBilling = Schema.Struct({
  profileId: Schema.NullOr(Uuid),
  profileName: Schema.NullOr(Schema.String),
  legalName: Schema.String,
  attention: Schema.NullOr(Schema.String),
  address: Schema.NullOr(Schema.String),
  taxId: Schema.NullOr(Schema.String),
  poNumber: Schema.NullOr(Schema.String),
  to: Schema.Array(Schema.String),
  cc: Schema.Array(Schema.String),
  paymentTermsDays: Schema.NullOr(Schema.Int),
  issueDate: InvoiceDay,
  dueDate: Schema.NullOr(InvoiceDay),
  taxRates: Schema.Array(BillingProfileTaxRate),
  bank: Schema.NullOr(BillingProfileBank),
  footer: Schema.NullOr(Schema.String),
  logoId: Schema.NullOr(Schema.String).annotate({
    description: "SHA-256 of the logo printed on the PDF, frozen with the invoice.",
  }),
  numberPrefix: Schema.String,
  numberIncludesYear: Schema.Boolean,
}).annotate({
  identifier: "InvoiceBilling",
  description:
    "Who the invoice is addressed to and how to pay it: the customer and its billing profile " +
    "resolved together. Live on a draft; written once at approval and read back verbatim after.",
});

const invoiceSummaryFields = {
  id: Uuid,
  managedAccountId: Uuid,
  managedAccountName: Schema.String,
  number: Schema.NullOr(Schema.String).annotate({
    description:
      "`INV-2026-0001`. Null while draft: numbers are assigned at approval so a deleted draft " +
      "cannot leave a gap in the sequence.",
    examples: ["INV-2026-0001"],
  }),
  status: InvoiceStatus,
  periodFrom: InvoiceDay,
  periodTo: InvoiceDay,
  currency: Schema.String,
  totals: Schema.NullOr(InvoiceTotals).annotate({
    description:
      "**Null for a draft**, null, not zero. A draft's figures are recomputed on read and the " +
      "list does not recompute; fetch the invoice by id for a draft's current numbers.",
  }),
  issuedAt: Schema.NullOr(IsoDateTime),
  sentAt: Schema.NullOr(IsoDateTime),
  delivery: Schema.NullOr(InvoiceDelivery).annotate({
    description:
      "The last delivery attempt, or null when none has been made; including on an invoice " +
      "marked sent by a deployment with no mail provider. “A person released this” and “we " +
      "delivered it” are different claims, and this field is only ever the second.",
  }),
  voidedAt: Schema.NullOr(IsoDateTime),
  voidReason: Schema.NullOr(Schema.String),
  supersedesInvoiceId: Schema.NullOr(Uuid),
  supersededByInvoiceId: Schema.NullOr(Uuid),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
};

export const InvoiceSummary = Schema.Struct(invoiceSummaryFields).annotate({
  identifier: "InvoiceSummary",
});

export const Invoice = Schema.Struct({
  ...invoiceSummaryFields,
  totals: InvoiceTotals,
  notes: Schema.NullOr(Schema.String),
  lines: Schema.Array(InvoiceLine),
  derivation: InvoiceDerivation,
  billing: Schema.NullOr(InvoiceBilling).annotate({
    description:
      "Addressee, recipients, terms and remittance details. Null on invoices approved before " +
      "billing profiles existed.",
  }),
  live: Schema.Boolean.annotate({
    description:
      "True when the figures in this response were recomputed for it; true for a draft, false " +
      "for everything else. Say so: “these numbers will move” and “these numbers are what we " +
      "sent” are different claims about the same fields.",
  }),
  computedAt: IsoDateTime,
  approvedByUserId: Schema.NullOr(Schema.String),
  sentByUserId: Schema.NullOr(Schema.String),
  voidedByUserId: Schema.NullOr(Schema.String),
  createdByUserId: Schema.NullOr(Schema.String),
}).annotate({ identifier: "Invoice" });

export const InvoiceVoidResponse = Schema.Struct({
  invoice: Invoice,
  replacement: Schema.NullOr(Invoice),
}).annotate({ identifier: "InvoiceVoidResponse" });

/** `?from=&to=` of the unassigned-spend finder, checked by the handler after both gates. */
export const UnassignedPeriodQuery = Schema.Struct({
  from: Schema.optionalKey(InvoiceDay),
  to: Schema.optionalKey(InvoiceDay),
});

/** `?managedAccountId=&status=` of the invoice list. */
const InvoiceListQuery = {
  // Checked only for being non-empty, documented as the customer's UUID.
  managedAccountId: Schema.optionalKey(
    NonEmptyString.annotate({
      format: "uuid",
      examples: ["00000000-0000-0000-0000-000000000000"],
    }),
  ),
  status: Schema.optionalKey(InvoiceStatus),
};

export class ManagedAccountsGroup extends HttpApiGroup.make("managedAccounts")
  .add(
    HttpApiEndpoint.get("list", "/", {
      params: OrgParams,
      success: Schema.Array(ManagedAccount),
    })
      .annotate(RequiredPermission, "invoices:read")
      .annotate(OpenApi.Summary, "List managed accounts")
      .annotate(
        OpenApi.Description,
        "The customers a managed service provider bills. A managed account references existing " +
          "cost centres rather than defining its own matching rules, so the spend on an invoice is " +
          "the same spend the showback report attributes to those centres.",
      )
      .annotate(SuccessDescription, "Customers, name-sorted"),
    // The finder and the preview check `invoices:read` and then `costs:read`
    // in the handler, before reading the request: this is a cost breakdown of
    // the whole org, not a view of the customer book, and a role that may see
    // invoices but not spend should not get spend through the side door. The
    // document states the stronger of the two.
    HttpApiEndpoint.get("unassigned", "/unassigned", {
      params: OrgParams,
      query: {
        from: Schema.optionalKey(
          documentedAs(
            invoiceDay({
              description: "Defaults, with `to`, to the last full calendar month.",
            }),
          ),
        ),
        to: Schema.optionalKey(documentedAs(InvoiceDay)),
      },
      success: UnassignedSpendReport,
      error: [BadRequest, Forbidden],
    })
      .annotate(DocumentedPermission, "costs:read")
      .annotate(OpenApi.Summary, "Find spend no customer is billed for")
      .annotate(
        OpenApi.Description,
        "Spend in the period, by cost centre and account, that no managed account's scope " +
          "covers. Requires `costs:read` as well as `invoices:read`: it is a cost breakdown of the " +
          "whole organisation.",
      )
      .annotate(SuccessDescription, "Unassigned spend")
      .annotate(InvalidRequestMessage, "Invalid period"),
    HttpApiEndpoint.post("previewAssignment", "/assignments/preview", {
      params: OrgParams,
      payload: ManagedAccountAssignmentPreview,
      success: ManagedAccountAssignmentPreviewResult,
      error: [BadRequest, Forbidden],
    })
      .annotate(DocumentedPermission, "costs:read")
      .annotate(OpenApi.Summary, "Preview a bulk assignment")
      .annotate(
        OpenApi.Description,
        "What moving these cost centres and accounts would do: who holds each one today, the " +
          "spend that moves with it in the period, the totals leaving each customer, and how many " +
          "draft invoices will change. Nothing is written.",
      )
      .annotate(SuccessDescription, "The preview")
      .annotate(InvalidRequestMessage, "Invalid assignment"),
    HttpApiEndpoint.post("assign", "/assignments", {
      params: OrgParams,
      payload: ManagedAccountAssignment,
      success: ManagedAccountAssignmentResult,
      error: BadRequest,
    })
      .annotate(RequiredPermission, "invoices:write")
      .annotate(OpenApi.Summary, "Assign cost centres and accounts to a customer in bulk")
      .annotate(
        OpenApi.Description,
        "Takes each item off whichever customer holds it and gives it to `managedAccountId`, or " +
          "to nobody when that is null, in one transaction. Only drafts change: an approved " +
          "invoice carries its own copy of its scope.",
      )
      .annotate(SuccessDescription, "The customers whose scope changed, and the full list after")
      .annotate(InvalidRequestMessage, "Invalid assignment"),
    HttpApiEndpoint.get("get", "/:id", {
      params: OrgIdParams,
      success: ManagedAccount,
      error: NotFound,
    })
      .annotate(RequiredPermission, "invoices:read")
      .annotate(OpenApi.Summary, "Get a managed account")
      .annotate(SuccessDescription, "The customer"),
    HttpApiEndpoint.post("create", "/", {
      params: OrgParams,
      payload: ManagedAccountInput,
      success: ManagedAccount,
      error: [BadRequest, Conflict],
    })
      .annotate(RequiredPermission, "invoices:write")
      .annotate(OpenApi.Summary, "Create a managed account")
      .annotate(
        OpenApi.Description,
        "Refused with 409 when a cost centre or account named here is already billed to another " +
          "customer. The error names the other customer, because “it conflicts” without saying with " +
          "whom sends the caller hunting.",
      )
      .annotate(SuccessDescription, "Created")
      .annotate(InvalidRequestMessage, "Invalid managed account"),
    HttpApiEndpoint.put("update", "/:id", {
      params: OrgIdParams,
      payload: ManagedAccountInput,
      success: ManagedAccount,
      error: [BadRequest, NotFound, Conflict],
    })
      .annotate(RequiredPermission, "invoices:write")
      .annotate(OpenApi.Summary, "Update a managed account")
      .annotate(
        OpenApi.Description,
        "A full replace. Editing the scope changes what **future** drafts are drawn over and " +
          "nothing else: every approved invoice holds its own copy of the scope, so moving a cost " +
          "centre between customers cannot re-bill a period that has already been invoiced.",
      )
      .annotate(SuccessDescription, "Updated")
      .annotate(InvalidRequestMessage, "Invalid managed account"),
    HttpApiEndpoint.delete("delete", "/:id", {
      params: OrgIdParams,
      success: Ok,
      error: NotFound,
    })
      .annotate(RequiredPermission, "invoices:write")
      .annotate(OpenApi.Summary, "Retire a managed account")
      .annotate(
        OpenApi.Description,
        "A soft delete: an issued invoice names its customer, and an invoice whose customer stopped " +
          "resolving is exactly the unreconcilable document this feature exists to prevent. Draft " +
          "invoices are removed with it; a draft was never issued.",
      )
      .annotate(SuccessDescription, "Retired"),
  )
  .prefix("/api/org/:orgId/managed-accounts")
  .middleware(OrgAuth)
  .annotate(OpenApi.Title, "Managed Accounts") {}

export class InvoicesGroup extends HttpApiGroup.make("invoices")
  .add(
    HttpApiEndpoint.get("pdf", "/:id/pdf", {
      params: OrgIdParams,
      success: Schema.String.annotate({ format: "binary" }).pipe(
        HttpApiSchema.asText({ contentType: "application/pdf" }),
      ),
      error: NotFound,
    })
      .annotate(RequiredPermission, "invoices:read")
      .annotate(OpenApi.Summary, "Download an invoice as PDF")
      .annotate(
        OpenApi.Description,
        "The document a customer files: addressee, lines, tax, total, due date and remittance " +
          "details, from the billing block frozen at approval. A draft is watermarked. The " +
          "collected-versus-adjusted derivation stays in the CSV.",
      )
      .annotate(SuccessDescription, "PDF"),
    HttpApiEndpoint.get("list", "/", {
      params: OrgParams,
      query: InvoiceListQuery,
      success: Schema.Array(InvoiceSummary),
      error: BadRequest,
    })
      .annotate(RequiredPermission, "invoices:read")
      .annotate(OpenApi.Summary, "List invoices")
      .annotate(
        OpenApi.Description,
        "Summaries, newest period first. A draft's `totals` is null here rather than recomputed; " +
          "recomputing every draft would make opening the list one cost-data scan per draft, and " +
          "zero would be a lie the reader cannot detect.",
      )
      .annotate(SuccessDescription, "Invoices")
      .annotate(InvalidRequestMessage, "Invalid filter"),
    HttpApiEndpoint.post("create", "/", {
      params: OrgParams,
      payload: ManagedInvoiceInput,
      success: Invoice,
      error: [BadRequest, NotFound, Conflict],
    })
      .annotate(RequiredPermission, "invoices:write")
      .annotate(OpenApi.Summary, "Raise a draft invoice")
      .annotate(
        OpenApi.Description,
        "Always lands in `draft`. Generating and issuing are two acts on two permissions: a " +
          "mistyped period must not be able to reach a customer without anyone having read the " +
          "numbers.",
      )
      .annotate(SuccessDescription, "Created")
      .annotate(InvalidRequestMessage, "Invalid invoice"),
    HttpApiEndpoint.get("get", "/:id", {
      params: OrgIdParams,
      success: Invoice,
      error: NotFound,
    })
      .annotate(RequiredPermission, "invoices:read")
      .annotate(OpenApi.Summary, "Get an invoice")
      .annotate(
        OpenApi.Description,
        "**A draft recomputes from live spend; an approved, sent or void invoice does not.** " +
          "`live` says which happened. A frozen invoice returns the figures written at approval and " +
          "does not read cost data at all.",
      )
      .annotate(SuccessDescription, "The invoice"),
    HttpApiEndpoint.get("export", "/:id/export", {
      params: OrgIdParams,
      success: Schema.String.pipe(HttpApiSchema.asText({ contentType: "text/csv" })),
      error: NotFound,
    })
      .annotate(RequiredPermission, "invoices:read")
      .annotate(OpenApi.Summary, "Download an invoice as CSV")
      .annotate(
        OpenApi.Description,
        "The derivation, not a rendered document: what was collected, what the rules added, the " +
          "rate and the day it was read, and the final figure; every column an accounts-payable " +
          "clerk needs to check the arithmetic. Same RFC 4180 quoting as the scheduled cost exports.",
      )
      .annotate(SuccessDescription, "CSV"),
    HttpApiEndpoint.put("update", "/:id", {
      params: OrgIdParams,
      payload: ManagedInvoiceUpdate,
      success: Invoice,
      error: [BadRequest, NotFound, Conflict],
    })
      .annotate(RequiredPermission, "invoices:write")
      .annotate(OpenApi.Summary, "Edit a draft invoice")
      .annotate(
        OpenApi.Description,
        "Draft only. An approved, sent or void invoice is refused with 409 by the service, not " +
          "merely hidden by the UI; an issued invoice that silently changed after the customer " +
          "received it is the worst outcome this feature could produce.",
      )
      .annotate(SuccessDescription, "Updated")
      .annotate(InvalidRequestMessage, "Invalid invoice"),
    HttpApiEndpoint.delete("delete", "/:id", {
      params: OrgIdParams,
      success: Ok,
      error: [NotFound, Conflict],
    })
      .annotate(RequiredPermission, "invoices:write")
      .annotate(OpenApi.Summary, "Delete a draft invoice")
      .annotate(
        OpenApi.Description,
        "Draft only, and refused with 409 otherwise. An issued invoice is voided; deleting one " +
          "would erase a document a customer holds a copy of.",
      )
      .annotate(SuccessDescription, "Deleted"),
    HttpApiEndpoint.post("approve", "/:id/approve", {
      params: OrgIdParams,
      success: Invoice,
      error: [NotFound, Conflict],
    })
      .annotate(RequiredPermission, "invoices:issue")
      .annotate(OpenApi.Summary, "Approve an invoice; freeze its figures")
      .annotate(
        OpenApi.Description,
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
      )
      .annotate(SuccessDescription, "Approved"),
    // The body is optional: `POST /send` with none is the ordinary first send.
    HttpApiEndpoint.post("send", "/:id/send", {
      params: OrgIdParams,
      payload: ManagedInvoiceSend,
      success: Invoice,
      error: [BadRequest, NotFound, Conflict],
    })
      .annotate(RequiredPermission, "invoices:issue")
      .annotate(OpenApi.Summary, "Send an invoice to its customer")
      .annotate(
        OpenApi.Description,
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
      )
      .annotate(SuccessDescription, "Released, with the delivery outcome")
      .annotate(InvalidRequestMessage, "Invalid send request")
      .annotate(OpenApi.Transform, optionalRequestBody),
    HttpApiEndpoint.post("void", "/:id/void", {
      params: OrgIdParams,
      payload: ManagedInvoiceVoid,
      success: InvoiceVoidResponse,
      error: [BadRequest, NotFound, Conflict],
    })
      .annotate(RequiredPermission, "invoices:issue")
      .annotate(OpenApi.Summary, "Void an issued invoice")
      .annotate(
        OpenApi.Description,
        "The only correction there is. The original keeps every figure it was sent with: “we " +
          "billed you this, it was wrong, here is the corrected one” is a story a customer can " +
          "follow, and “we changed the invoice” is not.\n\n" +
          "With `supersede`, the void, the corrective draft and both directions of the link between " +
          "them are one transaction. Void is irreversible, so a half-applied correction would leave " +
          "a withdrawn invoice with no way forward; this call either applies whole or not at all.",
      )
      .annotate(SuccessDescription, "Voided, with the corrective draft when one was requested")
      .annotate(InvalidRequestMessage, "Invalid void request"),
  )
  .prefix("/api/org/:orgId/invoices")
  .middleware(OrgAuth)
  .annotate(OpenApi.Title, "Invoices") {}

export class InvoicesApi extends withApiDefaults(
  HttpApi.make("invoices").add(ManagedAccountsGroup).add(InvoicesGroup),
) {}

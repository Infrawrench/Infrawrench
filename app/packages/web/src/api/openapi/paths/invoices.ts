import { z } from "../zod";
import { strict, ErrorResponses, Ok, OrgIdParam, Uuid, IsoDateTime } from "../common";
import type { BuildContext } from "../context";

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
        "frozen onto every invoice — so restating a rate later cannot restate history.",
      example: "GBP",
    }),
  costBasis: z
    .enum(["cash", "amortized"])
    .optional()
    .openapi({
      description:
        "Defaults to `amortized`. Charging a customer the whole cash value of a three-year " +
        "commitment in the month it was signed is not a bill anyone can budget against.",
    }),
  applyBillingRules: z
    .boolean()
    .optional()
    .openapi({
      description:
        "Defaults to true. False is a pass-through contract: the customer is billed exactly what " +
        "the providers charged, with no markup, discount or fixed fee applied.",
    }),
  notes: z.string().max(4000).nullish(),
  costCentreIds: z
    .array(z.string().min(1))
    .max(100)
    .default([])
    .openapi({
      description:
        "Cost centres whose spend belongs to this customer. **Subtrees are included** — naming a " +
        "parent bills every descendant, and naming both a parent and its child bills the child " +
        "once, not twice.\n\n" +
        "This is deliberately a list of existing cost centres rather than a rule of its own. " +
        "Which spend lands in which centre is already decided by the organisation's allocation " +
        "rules, and a second vocabulary over the same data would eventually disagree with the " +
        "first — at which point an invoice would stop matching the showback report the customer " +
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
  costBasis: z.enum(["cash", "amortized"]),
  applyBillingRules: z.boolean(),
  notes: z.string().nullable(),
  costCentreIds: z.array(z.string()),
  accountIds: z.array(z.string()),
  invoiceCount: z.number().int(),
  createdByUserId: z.string().nullable(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
}).openapi("ManagedAccount", {
  description:
    "A customer a managed service provider bills. A cost centre or cloud account belongs to at " +
    "most one managed account — billing the same money to two customers is refused at write " +
    "time with a 409 naming the other customer.",
});

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
  kind: z.enum(["cost_centre", "account", "fixed"]),
  refId: z
    .string()
    .nullable()
    .openapi({ description: "Cost-centre id, account id, or null for an org-level fixed charge." }),
  label: z.string().openapi({
    description:
      "The name at issue time, frozen with the numbers — renaming a cost centre in March must " +
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
      "Keyed by the invoice currency, plus any currency that could not be converted — which " +
      "keeps its own key so the total is never quietly short.",
  }),
}).openapi("InvoiceTotals", {
  description:
    "`collected + adjustment === adjusted` holds for every currency. That identity is what makes " +
    "an invoice reconcilable back to the spend that produced it, and it is checked before " +
    "anything is frozen.",
});

const InvoiceDerivation = strict({
  costBasis: z.enum(["cash", "amortized"]),
  applyBillingRules: z.boolean(),
  rateDate: IsoDay.openapi({
    description:
      "The day the exchange rates were read — always the period's last day. One rate for the " +
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
      kind: z.enum(["percentage", "fixed", "reallocation"]),
      summary: z.string(),
    }),
  ),
  scope: strict({
    costCentres: z.array(strict({ id: z.string(), name: z.string() })),
    accounts: z.array(strict({ id: z.string(), label: z.string() })),
  }),
  missingScope: z.array(z.string()).openapi({
    description:
      "Scope entries that no longer exist. Recorded rather than silently skipped — an invoice " +
      "that is quietly short is worse than one that says why.",
  }),
}).openapi("InvoiceDerivation", {
  description:
    "Everything needed to re-derive the invoice by hand. Not decoration: an invoice a customer " +
    "cannot reconcile is an invoice a customer does not pay.",
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
        "`INV-2026-0001`. Null while draft — numbers are assigned at approval so a deleted draft " +
        "cannot leave a gap in the sequence.",
      example: "INV-2026-0001",
    }),
  status: InvoiceStatus,
  periodFrom: IsoDay,
  periodTo: IsoDay,
  currency: z.string(),
  totals: InvoiceTotals.nullable().openapi({
    description:
      "**Null for a draft** — null, not zero. A draft's figures are recomputed on read and the " +
      "list does not recompute; fetch the invoice by id for a draft's current numbers.",
  }),
  issuedAt: IsoDateTime.nullable(),
  sentAt: IsoDateTime.nullable(),
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
  live: z.boolean().openapi({
    description:
      "True when the figures in this response were recomputed for it — true for a draft, false " +
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
      "The void invoice this one corrects. The original must already be void — a correction that " +
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
      "invoices are removed with it — a draft was never issued.",
    request: { params: accountIdParam },
    responses: {
      200: { description: "Retired", content: { "application/json": { schema: Ok } } },
      404: ErrorResponses[404],
    },
  });

  /* -- invoices -- */

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/invoices",
    tags: ["Invoices"],
    summary: "List invoices",
    description:
      "Summaries, newest period first. A draft's `totals` is null here rather than recomputed — " +
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
      "rate and the day it was read, and the final figure — every column an accounts-payable " +
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
      "merely hidden by the UI — an issued invoice that silently changed after the customer " +
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
    summary: "Approve an invoice — freeze its figures",
    description:
      "Computes the figures one last time and writes them onto the invoice together with the " +
      "exchange rates, the day they were read, the billing rules in force and the names " +
      "everything in scope had. From here the invoice is a document, not a query.\n\n" +
      "A distinct act from generation, on a distinct permission (`invoices:issue`), with its own " +
      "audit entry recording who approved what.\n\n" +
      "Refused with 409 when a currency in the invoice has no stated exchange rate: an approved " +
      "invoice has to be quotable as one number in the customer's currency.",
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
    summary: "Mark an approved invoice as sent",
    description:
      "Changes no figure. It records that the document left the building and who let it.\n\n" +
      "This deployment does not deliver invoices itself — `GET /invoices/{id}/export` produces " +
      "the artifact a human attaches to their own mail. The state transition and its audit trail " +
      "are the part that has to be right; a delivery channel can be added later without changing " +
      "a single stored figure.",
    request: { params: invoiceIdParam },
    responses: {
      200: { description: "Sent", content: { "application/json": { schema: Invoice } } },
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
      "The only correction there is. The original keeps every figure it was sent with — “we " +
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

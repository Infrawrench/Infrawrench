/**
 * Managed accounts (customers), their invoices and billing profiles, as
 * Effect schemas: POST/PUT /managed-accounts, POST/PUT /invoices, the void
 * and send actions, billing profiles and scope assignment.
 */
import { Effect, Schema } from "effect";
import {
  BILLING_PROFILE_LIMITS,
  MANAGED_ACCOUNT_LIMITS,
  MANAGED_INVOICE_LIMITS,
  type BillingProfileInput as BillingProfileInputContract,
  type ManagedInvoiceUpdate as ManagedInvoiceUpdateContract,
} from "@infrawrench/client-core";
import { maxLength, minLength } from "./checks";
import type { Exact } from "./contract";
import { ManagedAccountPricing } from "./billing-rules";
import { CostBasisValue } from "./cost-enums";
import { CurrencyCode, IsoDate, NonEmptyString } from "./primitives";

const InvoiceDay = IsoDate.annotate({ examples: ["2026-01-31"] });
const Text = (max: number) => Schema.String.check(maxLength(max));
const nullish = <S extends Schema.Top>(schema: S) => Schema.optionalKey(Schema.NullOr(schema));

/**
 * A managed account is a customer. No tag match, no priority, no rule of any
 * kind: which spend belongs to a customer is already answered by cost centres
 * and their allocation rules. Whether the scope ids exist and belong to no
 * other customer is the service's to decide.
 */
export const ManagedAccountInput = Schema.Struct({
  name: Schema.String.check(minLength(1), maxLength(MANAGED_ACCOUNT_LIMITS.maxNameLength)).annotate(
    { examples: ["Northwind Trading"] },
  ),
  contactName: nullish(Text(MANAGED_ACCOUNT_LIMITS.maxContactNameLength)),
  contactEmail: nullish(Text(MANAGED_ACCOUNT_LIMITS.maxContactEmailLength)),
  billingAddress: nullish(Text(MANAGED_ACCOUNT_LIMITS.maxAddressLength)),
  billingCurrency: CurrencyCode.annotate({
    description:
      "ISO 4217 code the customer is invoiced in. Spend collected in another currency is " +
      "converted through the organisation's own stated exchange rates, and the rate used is " +
      "frozen onto every invoice; so restating a rate later cannot restate history.",
    examples: ["GBP"],
  }),
  costBasis: Schema.optionalKey(
    CostBasisValue.annotate({
      description:
        "Defaults to `amortized`. Charging a customer the whole cash value of a three-year " +
        "commitment in the month it was signed is not a bill anyone can budget against. " +
        "`blended` spreads each commitment's discount evenly over all the usage it could " +
        "cover, so a customer is not billed more or less depending on which account the " +
        "provider happened to apply a shared commitment to.",
    }),
  ),
  applyBillingRules: Schema.optionalKey(
    Schema.Boolean.annotate({
      description:
        "Defaults to true. False is a pass-through contract: the customer is billed exactly what " +
        "the providers charged, with no markup, discount or fixed fee applied.",
    }),
  ),
  pricing: Schema.optionalKey(ManagedAccountPricing).annotateKey({
    description:
      "Re-rating to public pricing and discount treatment. Absent on update leaves the saved " +
      "settings unchanged; absent on create means nothing is re-rated and everything passes " +
      "through.",
  }),
  notes: nullish(Text(MANAGED_ACCOUNT_LIMITS.maxNotesLength)),
  billingProfileId: Schema.optionalKey(
    Schema.NullOr(NonEmptyString).annotate({
      description:
        "The billing profile this customer's invoices are addressed, taxed and numbered by. " +
        "Absent on update leaves the saved profile; null removes it.",
    }),
  ),
  costCentreIds: Schema.mutable(Schema.Array(NonEmptyString))
    .check(maxLength(MANAGED_ACCOUNT_LIMITS.maxCostCentres))
    .annotate({
      description:
        "Cost centres whose spend belongs to this customer. **Subtrees are included**; naming a " +
        "parent bills every descendant, and naming both a parent and its child bills the child " +
        "once, not twice.\n\n" +
        "This is deliberately a list of existing cost centres rather than a rule of its own. " +
        "Which spend lands in which centre is already decided by the organisation's allocation " +
        "rules, and a second vocabulary over the same data would eventually disagree with the " +
        "first: at which point an invoice would stop matching the showback report the customer " +
        "was shown.",
    })
    .pipe(Schema.withDecodingDefaultKey(Effect.sync(() => []))),
  accountIds: Schema.mutable(Schema.Array(NonEmptyString))
    .check(maxLength(MANAGED_ACCOUNT_LIMITS.maxAccounts))
    .annotate({
      description:
        "Cloud accounts whose spend belongs to this customer. Evaluated **after** every " +
        "allocation rule, so an account in scope claims only the spend no cost centre already " +
        "claimed. Every cost row therefore resolves exactly once: nothing is billed twice and " +
        "nothing goes missing.",
    })
    .pipe(Schema.withDecodingDefaultKey(Effect.sync(() => []))),
}).annotate({ identifier: "ManagedAccountInput" });

/**
 * Raising an invoice. No status field (a new invoice is always a draft) and
 * no currency or scope (both come from the customer).
 */
export const ManagedInvoiceInput = Schema.Struct({
  managedAccountId: NonEmptyString,
  periodFrom: InvoiceDay,
  periodTo: InvoiceDay,
  notes: nullish(Text(MANAGED_INVOICE_LIMITS.maxNotesLength)),
  supersedesInvoiceId: Schema.optionalKey(
    Schema.NullOr(NonEmptyString).annotate({
      description:
        "The void invoice this one corrects. The original must already be void; a correction that " +
        "leaves the original standing means the customer holds two live invoices for one period.",
    }),
  ),
}).annotate({
  identifier: "InvoiceInput",
  description:
    "A new invoice is always a draft. There is no status field and no scope field: generating " +
    "and issuing are two acts, and the scope comes from the customer.",
});

/** Editing a draft. Accepted only while the invoice is a draft; see the service. */
export const ManagedInvoiceUpdate = Schema.Struct({
  periodFrom: InvoiceDay,
  periodTo: InvoiceDay,
  notes: nullish(Text(MANAGED_INVOICE_LIMITS.maxNotesLength)),
}).annotate({ identifier: "InvoiceUpdate" });

/**
 * Voiding. `reason` is required: it is the only record of why a customer was
 * sent an invoice that was then withdrawn. `supersede` raises the corrective
 * draft in the same act.
 */
export const ManagedInvoiceVoid = Schema.Struct({
  reason: Schema.String.check(
    minLength(1),
    maxLength(MANAGED_INVOICE_LIMITS.maxVoidReasonLength),
  ).annotate({
    description:
      "Required. The only record of why a customer was sent an invoice that was then withdrawn.",
  }),
  supersede: Schema.Boolean.annotate({
    description:
      "Raise the corrective draft in the same call, linked both ways to the original. Doing it " +
      "in one call is what keeps the pair from being left half-made by a failed second request.",
  }).pipe(Schema.withDecodingDefaultKey(Effect.succeed(false))),
}).annotate({ identifier: "InvoiceVoidRequest" });

/**
 * Sending. `resend` is the caller saying, in as many words, that a second
 * copy of an invoice that already landed is meant; a retry after a delivery
 * that reached nobody needs no flag.
 */
export const ManagedInvoiceSend = Schema.Struct({
  resend: Schema.Boolean.annotate({
    description:
      "Send another copy of an invoice that has already reached somebody. Required only in " +
      "that case: retrying a delivery that reached nobody (`failed`, `no_targets`) needs no " +
      "flag, because there is no inbox to duplicate into. Refused with 409 without it when the " +
      "last attempt landed, or when its outcome is unknown (`pending`).",
  }).pipe(Schema.withDecodingDefaultKey(Effect.succeed(false))),
}).annotate({ identifier: "InvoiceSendRequest" });

const P = BILLING_PROFILE_LIMITS;

export const BillingProfileTaxRate = Schema.Struct({
  name: Schema.String.check(minLength(1), maxLength(P.maxTaxNameLength)).annotate({
    examples: ["VAT"],
  }),
  rate: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 100 })).annotate({
    description: "Percent.",
    examples: [20],
  }),
}).annotate({
  identifier: "BillingProfileTaxRate",
  description:
    "A tax applied to the invoice subtotal as its own line. Several rates each apply to the " +
    "same subtotal; they do not compound.",
});

export const BillingProfileBankInput = Schema.Struct({
  accountName: nullish(Text(P.maxBankFieldLength)),
  bankName: nullish(Text(P.maxBankFieldLength)),
  iban: nullish(Text(64)),
  bic: nullish(Text(11)),
  accountNumber: nullish(Text(64)),
  routingNumber: nullish(Text(64)),
  instructions: nullish(Text(P.maxInstructionsLength)),
}).annotate({ identifier: "BillingProfileBankInput" });

/**
 * A billing profile write. Shape and bounds only: the IBAN checksum, the
 * prefix rules and the logo's decodability are `normalizeBillingProfileInput`
 * and the server's, so the editor and the API refuse with the same sentence.
 */
export const BillingProfileInput = Schema.Struct({
  name: Schema.String.check(minLength(1), maxLength(P.maxNameLength)).annotate({
    description: "What the profile is called in pickers. Not printed on the invoice.",
    examples: ["EU customers"],
  }),
  legalName: nullish(
    Text(P.maxLegalNameLength).annotate({
      description: "The legal entity invoices are addressed to. Null leaves each customer's name.",
    }),
  ),
  address: nullish(
    Text(P.maxAddressLength).annotate({
      description: "Printed under the legal name. Null leaves each customer's billing address.",
    }),
  ),
  taxId: nullish(Text(P.maxTaxIdLength).annotate({ description: "Tax ID or VAT number." })),
  poNumber: nullish(
    Text(P.maxPoNumberLength).annotate({ description: "Purchase-order reference." }),
  ),
  toEmails: Schema.optionalKey(
    Schema.mutable(Schema.Array(Text(P.maxEmailLength)))
      .check(maxLength(P.maxEmails))
      .annotate({
        description:
          "Addresses invoices are emailed to, **in addition to** each customer's own contact email.",
      }),
  ),
  ccEmails: Schema.optionalKey(
    Schema.mutable(Schema.Array(Text(P.maxEmailLength)))
      .check(maxLength(P.maxEmails))
      .annotate({
        description: "Addresses that receive a copy. Each address gets its own message.",
      }),
  ),
  currency: nullish(
    CurrencyCode.annotate({
      description:
        "ISO 4217. When set, invoices for every assigned customer are issued in this currency " +
        "instead of the customer's billing currency.",
    }),
  ),
  paymentTermsDays: nullish(
    Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: P.maxPaymentTermsDays })).annotate({
      description: "Net N days from the issue date. Null prints no due date; 0 is due on receipt.",
    }),
  ),
  numberPrefix: Schema.optionalKey(
    Schema.String.check(minLength(1), maxLength(P.maxPrefixLength)).annotate({
      description:
        "Starts with a letter; letters, digits and hyphens. Defaults to `INV`. Profiles sharing a " +
        "prefix share a sequence.",
      examples: ["INV"],
    }),
  ),
  numberIncludesYear: Schema.optionalKey(
    Schema.Boolean.annotate({
      description:
        "Defaults to true: `INV-2026-0001`, with the sequence restarting each year of the period " +
        "end. False gives `INV-0001` and one sequence for ever.",
    }),
  ),
  numberStart: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: P.maxNumberStart })).annotate({
      description:
        "The lowest sequence number issued, for continuing a sequence from another system.",
    }),
  ),
  taxRates: Schema.optionalKey(
    Schema.mutable(Schema.Array(BillingProfileTaxRate)).check(maxLength(P.maxTaxRates)),
  ),
  bank: nullish(BillingProfileBankInput),
  footer: nullish(
    Text(P.maxFooterLength).annotate({
      description: "Printed at the bottom of every page of the PDF.",
    }),
  ),
  // A data URL: base64 of at most `maxLogoBytes`, plus the prefix.
  logo: nullish(
    Text(Math.ceil((P.maxLogoBytes * 4) / 3) + 64).annotate({
      description:
        "A PNG or JPEG `data:` URL of at most 100 KB, printed at the top of the PDF. Interlaced " +
        "and 16-bit PNGs and CMYK JPEGs are refused. Absent on update leaves the saved logo; null " +
        "removes it.",
    }),
  ),
}).annotate({ identifier: "BillingProfileInput" });

const assignmentFields = {
  managedAccountId: Schema.NullOr(NonEmptyString).annotate({
    description: "The customer to assign to, or null to take the items off every customer.",
  }),
  costCentreIds: Schema.mutable(Schema.Array(NonEmptyString))
    .check(maxLength(500))
    .pipe(Schema.withDecodingDefaultKey(Effect.sync(() => []))),
  accountIds: Schema.mutable(Schema.Array(NonEmptyString))
    .check(maxLength(500))
    .pipe(Schema.withDecodingDefaultKey(Effect.sync(() => []))),
};

/**
 * Moving cost centres and accounts onto one customer, or off every customer
 * with a null `managedAccountId`.
 */
export const ManagedAccountAssignment = Schema.Struct(assignmentFields).annotate({
  identifier: "ManagedAccountAssignment",
});

/** The assignment preview: the same body plus an optional period. */
export const ManagedAccountAssignmentPreview = Schema.Struct({
  ...assignmentFields,
  periodFrom: Schema.optionalKey(InvoiceDay),
  periodTo: Schema.optionalKey(InvoiceDay),
}).annotate({
  identifier: "ManagedAccountAssignmentPreviewRequest",
  description: "The period whose spend is previewed defaults to the last full calendar month.",
});

export type ManagedAccountSchemasMatchContract = [
  Exact<typeof ManagedInvoiceUpdate.Type, ManagedInvoiceUpdateContract>,
  Exact<typeof BillingProfileInput.Type, BillingProfileInputContract>,
];
[true, true] satisfies ManagedAccountSchemasMatchContract;

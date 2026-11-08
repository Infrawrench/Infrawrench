/**
 * Pieces of the managed-service-provider surface that more than one domain
 * documents: a billing profile's remittance details appear on the profile
 * itself (`/billing-profiles`) and, frozen, on every approved invoice
 * (`/invoices`).
 */
import { Schema } from "effect";
import { maxLength, pattern } from "@infrawrench/ui/schemas";

/**
 * A calendar day on an invoice, `YYYY-MM-DD`, as the service holds it. A
 * factory, since a description has to be annotated before the check to
 * survive into the document.
 */
export const invoiceDay = (annotations: { readonly description?: string } = {}) =>
  Schema.String.annotate({ format: "date", examples: ["2026-01-31"], ...annotations }).check(
    pattern(/^\d{4}-\d{2}-\d{2}$/),
  );

export const InvoiceDay = invoiceDay();

/** Currency code to an amount in the currency's major unit. */
export const CurrencyAmounts = Schema.Record(Schema.String, Schema.Finite).annotate({
  description: "Currency code → amount in the currency's major unit.",
});

const bankText = (max: number, annotations?: { readonly description: string }) =>
  Schema.NullOr(Schema.String.check(maxLength(max))).annotate(annotations ?? {});

export const BillingProfileBank = Schema.Struct({
  accountName: bankText(120),
  bankName: bankText(120),
  iban: bankText(64, {
    description:
      "Checked against its mod-97 digits and stored grouped in fours. Masked to its last four " +
      "characters in audit entries.",
  }),
  bic: bankText(11, { description: "SWIFT / BIC." }),
  accountNumber: bankText(64, {
    description: "For banking systems without IBANs. Masked in audit entries.",
  }),
  routingNumber: bankText(64, { description: "Sort code, ABA routing number, BSB." }),
  instructions: bankText(2000, {
    description: "Free-text remittance instructions, printed under the bank details.",
  }),
}).annotate({ identifier: "BillingProfileBank" });

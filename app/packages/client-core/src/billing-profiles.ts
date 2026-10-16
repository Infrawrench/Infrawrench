/**
 * Billing profiles: the reusable half of an invoice that is not a number.
 *
 * A managed account (customer) says *whose* spend is billed. A billing profile
 * says *how the document reads*: the legal entity it is addressed to, who it is
 * emailed to, the tax lines, the payment terms and remittance details, and how
 * it is numbered. Several customers can share one profile (a parent company
 * with a managed account per business unit, or every customer billed from the
 * same entity on the same terms), which is the point of making it an object of
 * its own rather than more fields on each customer.
 *
 * ## Precedence
 *
 * The profile wins where it says something; the customer fills the gaps. A
 * profile with no legal name leaves each customer's own name on the invoice,
 * one with no address leaves each customer's billing address, and one with no
 * currency leaves each customer's billing currency. Emails are the exception:
 * they are a **union**. The customer's contact email still receives every
 * invoice, and the profile's `to` list is added to it, because silently
 * dropping a contact someone typed onto the customer is the kind of change
 * nobody notices until an invoice goes unpaid.
 *
 * ## Freezing
 *
 * A draft reads its profile live, exactly as it reads its spend live. Approval
 * resolves the profile into a {@link ManagedInvoiceBilling} snapshot and writes
 * it onto the invoice with the figures, so editing a profile's bank details or
 * tax rate later cannot rewrite an invoice a customer already holds. The tax
 * lines are figures (they sit in `lines` and in the totals) so they freeze with
 * the rest of the arithmetic.
 *
 * Pure: no I/O, so the server, the UI and the CLI share one reading of every
 * rule here.
 */

/* ------------------------------------------------------------------ *
 * Shapes
 * ------------------------------------------------------------------ */

export const BILLING_PROFILE_LIMITS = {
  maxPerOrg: 100,
  maxNameLength: 120,
  maxLegalNameLength: 200,
  maxAddressLength: 1000,
  maxTaxIdLength: 64,
  maxPoNumberLength: 64,
  maxEmails: 20,
  maxEmailLength: 254,
  maxPaymentTermsDays: 365,
  maxPrefixLength: 16,
  maxNumberStart: 999_999_999,
  maxTaxRates: 5,
  maxTaxNameLength: 40,
  maxBankFieldLength: 120,
  maxInstructionsLength: 2000,
  maxFooterLength: 2000,
  /** Decoded bytes. A logo is printed at a few centimetres; this is generous. */
  maxLogoBytes: 100 * 1024,
} as const;

/** A tax applied to the invoice subtotal, as its own line. */
export interface BillingProfileTaxRate {
  /** "VAT", "GST", "Sales tax". Printed on the line. */
  name: string;
  /** Percent, 0 to 100, at most four decimal places. */
  rate: number;
}

/**
 * Where the customer pays. Every field optional: some organisations print an
 * IBAN, some an account and routing number, some only a sentence.
 *
 * `iban` and `accountNumber` are masked in audit entries
 * ({@link maskBillingProfileBank}); they are printed in full on the invoice,
 * because that is where a customer needs them.
 */
export interface BillingProfileBank {
  accountName: string | null;
  bankName: string | null;
  iban: string | null;
  /** SWIFT / BIC. */
  bic: string | null;
  /** For banking systems without IBANs. */
  accountNumber: string | null;
  /** Sort code, ABA routing number, BSB: whatever the account number needs. */
  routingNumber: string | null;
  /** Free-text remittance instructions, printed under the bank details. */
  instructions: string | null;
}

export interface BillingProfileInput {
  /** What the profile is called in pickers. Not printed on the invoice. */
  name: string;
  /** The legal entity the invoice is addressed to. Null leaves each customer's name. */
  legalName?: string | null | undefined;
  /** Postal address under the legal name. Null leaves each customer's billing address. */
  address?: string | null | undefined;
  /** The customer's tax ID or VAT number, printed under the address. */
  taxId?: string | null | undefined;
  /** Purchase-order reference the customer asked to be quoted. */
  poNumber?: string | null | undefined;
  /** Addresses the invoice is emailed to, in addition to each customer's contact. */
  toEmails?: string[] | undefined;
  /** Addresses that receive a copy. */
  ccEmails?: string[] | undefined;
  /** ISO 4217. Null leaves each customer's billing currency. */
  currency?: string | null | undefined;
  /** Net N days from the issue date. Null prints no due date; 0 is due on receipt. */
  paymentTermsDays?: number | null | undefined;
  /** `INV` → `INV-2026-0001`. Letters, digits and hyphens. */
  numberPrefix?: string | undefined;
  /** Whether the number carries the year of the period end. Default true. */
  numberIncludesYear?: boolean | undefined;
  /** The first sequence number, for continuing a sequence from another system. */
  numberStart?: number | undefined;
  taxRates?: BillingProfileTaxRate[] | undefined;
  bank?: BillingProfileBank | null | undefined;
  /** Printed at the bottom of every invoice: terms, a thank-you, a registration number. */
  footer?: string | null | undefined;
  /**
   * PNG or JPEG as a `data:` URL, printed at the top of the PDF. Absent on an
   * update leaves the saved logo; null removes it.
   */
  logo?: string | null | undefined;
}

export interface BillingProfile {
  id: string;
  name: string;
  legalName: string | null;
  address: string | null;
  taxId: string | null;
  poNumber: string | null;
  toEmails: string[];
  ccEmails: string[];
  currency: string | null;
  paymentTermsDays: number | null;
  numberPrefix: string;
  numberIncludesYear: boolean;
  numberStart: number;
  taxRates: BillingProfileTaxRate[];
  bank: BillingProfileBank | null;
  footer: string | null;
  logo: string | null;
  /** Live customers assigned to this profile. */
  managedAccountIds: string[];
  createdByUserId: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * What an invoice says about who it is for and how to pay it: the profile and
 * the customer resolved together. Written onto the invoice at approval and read
 * back verbatim after, the same way the figures are.
 */
export interface ManagedInvoiceBilling {
  /** The profile it was resolved from, or null when the customer had none. */
  profileId: string | null;
  profileName: string | null;
  /** The entity the invoice is addressed to. */
  legalName: string;
  /** "Attn:" line, from the customer's contact name. */
  attention: string | null;
  address: string | null;
  taxId: string | null;
  poNumber: string | null;
  /** Who the invoice is emailed to. */
  to: string[];
  /** Who receives a copy. */
  cc: string[];
  paymentTermsDays: number | null;
  /** YYYY-MM-DD: the approval day once frozen, today on a draft. */
  issueDate: string;
  /** `issueDate + paymentTermsDays`, or null when the profile states no terms. */
  dueDate: string | null;
  taxRates: BillingProfileTaxRate[];
  bank: BillingProfileBank | null;
  footer: string | null;
  /** Content hash of the logo printed on the PDF; null for none. */
  logoId: string | null;
  numberPrefix: string;
  numberIncludesYear: boolean;
}

export const DEFAULT_INVOICE_NUMBER_PREFIX = "INV";

/* ------------------------------------------------------------------ *
 * Normalisation
 * ------------------------------------------------------------------ */

/** A normalised profile write: every field present, trimmed and checked. */
export interface NormalizedBillingProfileInput {
  name: string;
  legalName: string | null;
  address: string | null;
  taxId: string | null;
  poNumber: string | null;
  toEmails: string[];
  ccEmails: string[];
  currency: string | null;
  paymentTermsDays: number | null;
  numberPrefix: string;
  numberIncludesYear: boolean;
  numberStart: number;
  taxRates: BillingProfileTaxRate[];
  bank: BillingProfileBank | null;
  footer: string | null;
  /** Undefined: leave the saved logo. */
  logo: string | null | undefined;
}

const EMAIL_PATTERN = /^[^\s@,;]+@[^\s@,;.]+(\.[^\s@,;.]+)+$/;
const PREFIX_PATTERN = /^[A-Za-z][A-Za-z0-9-]*$/;
const BIC_PATTERN = /^[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}([A-Z0-9]{3})?$/;
const LOGO_PATTERN = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/]+={0,2})$/;

class ProfileInputError extends Error {}

function text(value: unknown, max: number, label: string): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = String(value).trim();
  if (!trimmed) return null;
  if (trimmed.length > max)
    throw new ProfileInputError(`${label} must be ${max} characters or fewer`);
  return trimmed;
}

function emails(value: unknown, label: string): string[] {
  const list = Array.isArray(value) ? value : [];
  const out: string[] = [];
  for (const raw of list) {
    const email = String(raw ?? "")
      .trim()
      .toLowerCase();
    if (!email) continue;
    if (email.length > BILLING_PROFILE_LIMITS.maxEmailLength || !EMAIL_PATTERN.test(email)) {
      throw new ProfileInputError(`${label}: "${String(raw).trim()}" is not an email address`);
    }
    if (!out.includes(email)) out.push(email);
  }
  if (out.length > BILLING_PROFILE_LIMITS.maxEmails) {
    throw new ProfileInputError(
      `${label} may hold at most ${BILLING_PROFILE_LIMITS.maxEmails} addresses`,
    );
  }
  return out;
}

/**
 * Whether an IBAN's check digits hold (ISO 13616 mod 97). Spaces are ignored
 * and letters are case-insensitive, the way people copy them from a bank
 * letter.
 */
export function ibanIsValid(raw: string): boolean {
  const iban = raw.replace(/\s+/g, "").toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(iban)) return false;
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let remainder = 0;
  for (const ch of rearranged) {
    const digits = ch >= "A" && ch <= "Z" ? String(ch.charCodeAt(0) - 55) : ch;
    for (const d of digits) remainder = (remainder * 10 + Number(d)) % 97;
  }
  return remainder === 1;
}

/** An IBAN grouped in fours, as it is printed on a bank letter. */
export function formatIban(raw: string): string {
  return raw
    .replace(/\s+/g, "")
    .toUpperCase()
    .replace(/(.{4})/g, "$1 ")
    .trim();
}

function bank(value: unknown): BillingProfileBank | null {
  if (value === null || value === undefined || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const max = BILLING_PROFILE_LIMITS.maxBankFieldLength;
  const ibanRaw = text(v["iban"], 64, "IBAN");
  if (ibanRaw !== null && !ibanIsValid(ibanRaw)) {
    throw new ProfileInputError(
      "That IBAN's check digits don't add up. Copy it again from the bank's own letter.",
    );
  }
  const bicRaw = text(v["bic"], 11, "SWIFT/BIC");
  const bic = bicRaw === null ? null : bicRaw.replace(/\s+/g, "").toUpperCase();
  if (bic !== null && !BIC_PATTERN.test(bic)) {
    throw new ProfileInputError("A SWIFT/BIC code is 8 or 11 letters and digits, like DEUTDEFF");
  }
  const out: BillingProfileBank = {
    accountName: text(v["accountName"], max, "Account name"),
    bankName: text(v["bankName"], max, "Bank name"),
    iban: ibanRaw === null ? null : formatIban(ibanRaw),
    bic,
    accountNumber: text(v["accountNumber"], 64, "Account number"),
    routingNumber: text(v["routingNumber"], 64, "Routing number"),
    instructions: text(
      v["instructions"],
      BILLING_PROFILE_LIMITS.maxInstructionsLength,
      "Remittance instructions",
    ),
  };
  return Object.values(out).some((f) => f !== null) ? out : null;
}

/** Decoded size of a base64 payload, without decoding it. */
function base64Bytes(payload: string): number {
  const padding = payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0;
  return Math.floor((payload.length * 3) / 4) - padding;
}

/**
 * Check a logo data URL's shape and size. Whether the image actually decodes
 * is the server's question (it is the one that has to draw it).
 */
export function billingProfileLogoError(logo: string): string | null {
  const m = LOGO_PATTERN.exec(logo);
  if (!m) return "The logo must be a PNG or JPEG image";
  if (base64Bytes(m[2]!) > BILLING_PROFILE_LIMITS.maxLogoBytes) {
    return `The logo must be ${Math.round(BILLING_PROFILE_LIMITS.maxLogoBytes / 1024)} KB or smaller`;
  }
  return null;
}

/**
 * Trim, lowercase and check everything a profile write carries. Returns the
 * normalised value or the first problem, in words meant for the person who
 * typed it.
 */
export function normalizeBillingProfileInput(
  input: BillingProfileInput,
):
  | { value: NormalizedBillingProfileInput; error?: undefined }
  | { value?: undefined; error: string } {
  try {
    const name = text(input.name, BILLING_PROFILE_LIMITS.maxNameLength, "Name");
    if (!name) return { error: "A billing profile needs a name" };

    let currency: string | null = null;
    if (input.currency !== null && input.currency !== undefined && String(input.currency).trim()) {
      currency = String(input.currency).trim().toUpperCase();
      if (!/^[A-Z]{3}$/.test(currency)) {
        return { error: "Currency must be a three-letter ISO 4217 code" };
      }
    }

    let paymentTermsDays: number | null = null;
    if (input.paymentTermsDays !== null && input.paymentTermsDays !== undefined) {
      const days = Number(input.paymentTermsDays);
      if (
        !Number.isInteger(days) ||
        days < 0 ||
        days > BILLING_PROFILE_LIMITS.maxPaymentTermsDays
      ) {
        return {
          error: `Payment terms must be a whole number of days from 0 to ${BILLING_PROFILE_LIMITS.maxPaymentTermsDays}`,
        };
      }
      paymentTermsDays = days;
    }

    const numberPrefix = (input.numberPrefix ?? DEFAULT_INVOICE_NUMBER_PREFIX).trim();
    if (
      !numberPrefix ||
      numberPrefix.length > BILLING_PROFILE_LIMITS.maxPrefixLength ||
      !PREFIX_PATTERN.test(numberPrefix) ||
      numberPrefix.endsWith("-")
    ) {
      return {
        error: `The invoice number prefix must start with a letter and use only letters, digits and hyphens (at most ${BILLING_PROFILE_LIMITS.maxPrefixLength})`,
      };
    }

    const numberStart = input.numberStart === undefined ? 1 : Number(input.numberStart);
    if (
      !Number.isInteger(numberStart) ||
      numberStart < 1 ||
      numberStart > BILLING_PROFILE_LIMITS.maxNumberStart
    ) {
      return { error: "The first invoice number must be a whole number of at least 1" };
    }

    const taxRates: BillingProfileTaxRate[] = [];
    for (const raw of Array.isArray(input.taxRates) ? input.taxRates : []) {
      const taxName = text(raw?.name, BILLING_PROFILE_LIMITS.maxTaxNameLength, "Tax name");
      if (!taxName) return { error: "Every tax line needs a name, like VAT or GST" };
      const rate = Number(raw?.rate);
      if (!Number.isFinite(rate) || rate < 0 || rate > 100) {
        return { error: `${taxName}: the rate must be a percentage from 0 to 100` };
      }
      if (Math.round(rate * 1e4) / 1e4 !== rate) {
        return { error: `${taxName}: the rate may have at most four decimal places` };
      }
      taxRates.push({ name: taxName, rate });
    }
    if (taxRates.length > BILLING_PROFILE_LIMITS.maxTaxRates) {
      return { error: `A profile may apply at most ${BILLING_PROFILE_LIMITS.maxTaxRates} taxes` };
    }

    let logo: string | null | undefined;
    if (input.logo === undefined) logo = undefined;
    else if (input.logo === null || !String(input.logo).trim()) logo = null;
    else {
      logo = String(input.logo).trim();
      const logoError = billingProfileLogoError(logo);
      if (logoError) return { error: logoError };
    }

    return {
      value: {
        name,
        legalName: text(input.legalName, BILLING_PROFILE_LIMITS.maxLegalNameLength, "Legal name"),
        address: text(input.address, BILLING_PROFILE_LIMITS.maxAddressLength, "Address"),
        taxId: text(input.taxId, BILLING_PROFILE_LIMITS.maxTaxIdLength, "Tax ID"),
        poNumber: text(input.poNumber, BILLING_PROFILE_LIMITS.maxPoNumberLength, "PO number"),
        toEmails: emails(input.toEmails, "To"),
        ccEmails: emails(input.ccEmails, "Cc"),
        currency,
        paymentTermsDays,
        numberPrefix,
        numberIncludesYear: input.numberIncludesYear !== false,
        numberStart,
        taxRates,
        bank: bank(input.bank),
        footer: text(input.footer, BILLING_PROFILE_LIMITS.maxFooterLength, "Footer"),
        logo,
      },
    };
  } catch (e) {
    if (e instanceof ProfileInputError) return { error: e.message };
    throw e;
  }
}

/* ------------------------------------------------------------------ *
 * Invoice numbers
 * ------------------------------------------------------------------ */

export interface InvoiceNumberFormat {
  prefix: string;
  includeYear: boolean;
}

export const DEFAULT_INVOICE_NUMBER_FORMAT: InvoiceNumberFormat = {
  prefix: DEFAULT_INVOICE_NUMBER_PREFIX,
  includeYear: true,
};

/** `INV-2026-0001`, or `ACME-0042` without the year. */
export function formatInvoiceNumber(
  format: InvoiceNumberFormat,
  year: number,
  sequence: number,
): string {
  const seq = String(sequence).padStart(4, "0");
  return format.includeYear ? `${format.prefix}-${year}-${seq}` : `${format.prefix}-${seq}`;
}

/**
 * The sequence back out of a number in this format; null when it isn't one.
 * Anchored on the whole prefix, so `INV-UK-2026-0001` is not read as an `INV`
 * number.
 */
export function parseInvoiceNumber(
  format: InvoiceNumberFormat,
  value: string,
): { year: number | null; sequence: number } | null {
  const prefix = format.prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (format.includeYear) {
    const m = new RegExp(`^${prefix}-(\\d{4})-(\\d{4,})$`).exec(value);
    return m ? { year: Number(m[1]), sequence: Number(m[2]) } : null;
  }
  const m = new RegExp(`^${prefix}-(\\d{4,})$`).exec(value);
  return m ? { year: null, sequence: Number(m[1]) } : null;
}

/**
 * The next number in a sequence, given every number already issued with this
 * prefix. One past the highest in the same year (or overall without the year),
 * never below `start`, and never one that is already taken: a prefix like
 * `INV-2026` could otherwise produce a string another format already issued.
 */
export function nextInvoiceNumber(
  format: InvoiceNumberFormat,
  year: number,
  start: number,
  existing: readonly string[],
): string {
  let highest = 0;
  for (const number of existing) {
    const parsed = parseInvoiceNumber(format, number);
    if (!parsed) continue;
    if (format.includeYear && parsed.year !== year) continue;
    if (parsed.sequence > highest) highest = parsed.sequence;
  }
  const taken = new Set(existing);
  let sequence = Math.max(highest + 1, start);
  let candidate = formatInvoiceNumber(format, year, sequence);
  while (taken.has(candidate)) {
    sequence += 1;
    candidate = formatInvoiceNumber(format, year, sequence);
  }
  return candidate;
}

/* ------------------------------------------------------------------ *
 * Resolution
 * ------------------------------------------------------------------ */

/** The customer fields a billing snapshot draws on. */
export interface BillingCustomerFields {
  name: string;
  contactName: string | null;
  contactEmail: string | null;
  billingAddress: string | null;
  billingCurrency: string;
}

/** The profile fields a billing snapshot draws on. */
export type BillingProfileFields = Pick<
  BillingProfile,
  | "id"
  | "name"
  | "legalName"
  | "address"
  | "taxId"
  | "poNumber"
  | "toEmails"
  | "ccEmails"
  | "currency"
  | "paymentTermsDays"
  | "numberPrefix"
  | "numberIncludesYear"
  | "taxRates"
  | "bank"
  | "footer"
>;

/** Split a customer's contact email field (comma or semicolon separated). */
export function splitContactEmails(value: string | null | undefined): string[] {
  const out: string[] = [];
  for (const raw of String(value ?? "").split(/[,;]/)) {
    const email = raw.trim().toLowerCase();
    if (email && !out.includes(email)) out.push(email);
  }
  return out;
}

/** `YYYY-MM-DD` plus N days, in UTC. */
export function addDaysToDay(day: string, days: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** The currency an invoice for this customer is issued in. */
export function invoiceCurrencyFor(
  customer: Pick<BillingCustomerFields, "billingCurrency">,
  profile: Pick<BillingProfileFields, "currency"> | null | undefined,
): string {
  return profile?.currency ?? customer.billingCurrency;
}

/**
 * Resolve what an invoice says about its addressee and terms. See the module
 * header for the precedence; `logoId` is the caller's (it is a content hash
 * the server computes when it stores the image).
 */
export function resolveInvoiceBilling(
  customer: BillingCustomerFields,
  profile: BillingProfileFields | null | undefined,
  issueDate: string,
  logoId: string | null = null,
): ManagedInvoiceBilling {
  const to = splitContactEmails(customer.contactEmail);
  for (const email of profile?.toEmails ?? []) if (!to.includes(email)) to.push(email);
  // Someone on both lists gets one copy, addressed to them.
  const cc = (profile?.ccEmails ?? []).filter((email) => !to.includes(email));
  const terms = profile?.paymentTermsDays ?? null;
  return {
    profileId: profile?.id ?? null,
    profileName: profile?.name ?? null,
    legalName: profile?.legalName ?? customer.name,
    attention: customer.contactName,
    address: profile?.address ?? customer.billingAddress,
    taxId: profile?.taxId ?? null,
    poNumber: profile?.poNumber ?? null,
    to,
    cc,
    paymentTermsDays: terms,
    issueDate,
    dueDate: terms === null ? null : addDaysToDay(issueDate, terms),
    taxRates: profile?.taxRates ?? [],
    bank: profile?.bank ?? null,
    footer: profile?.footer ?? null,
    logoId,
    numberPrefix: profile?.numberPrefix ?? DEFAULT_INVOICE_NUMBER_PREFIX,
    numberIncludesYear: profile?.numberIncludesYear ?? true,
  };
}

/** "Net 30", "Due on receipt", or null when no terms are stated. */
export function describePaymentTerms(days: number | null): string | null {
  if (days === null) return null;
  return days === 0 ? "Due on receipt" : `Net ${days}`;
}

/* ------------------------------------------------------------------ *
 * Tax lines
 * ------------------------------------------------------------------ */

/** The currency's minor-unit digits (2 for USD, 0 for JPY), 2 when unknown. */
export function currencyFractionDigits(currency: string): number {
  try {
    return (
      new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions()
        .maximumFractionDigits ?? 2
    );
  } catch {
    return 2;
  }
}

function roundTo(value: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

/** "VAT (20%)". */
export function describeTaxRate(tax: BillingProfileTaxRate): string {
  return `${tax.name} (${tax.rate}%)`;
}

/**
 * The tax lines for an invoice: one per rate, each on the **same** subtotal
 * (taxes do not compound), rounded to the currency's minor unit.
 *
 * The subtotal is every non-tax line that converted into the invoice currency.
 * A line with no exchange rate has no invoice-currency amount to tax, and an
 * invoice carrying one cannot be approved anyway, so it is left out rather
 * than taxed in the wrong currency.
 *
 * A tax line has nothing collected: the whole amount is an adjustment, which
 * keeps `collected + adjustment = adjusted` true for it as for every other
 * line, and lets the reconciliation check cover it unchanged.
 */
export function managedInvoiceTaxLines<
  L extends { kind: string; billed: number | null; currency: string },
>(
  lines: readonly L[],
  invoiceCurrency: string,
  taxRates: readonly BillingProfileTaxRate[],
): Array<{
  kind: "tax";
  refId: null;
  label: string;
  currency: string;
  collected: number;
  adjustment: number;
  adjusted: number;
  rate: number;
  billed: number;
}> {
  if (taxRates.length === 0) return [];
  const digits = currencyFractionDigits(invoiceCurrency);
  let subtotal = 0;
  for (const line of lines) {
    if (line.kind === "tax" || line.billed === null) continue;
    subtotal += line.billed;
  }
  subtotal = roundTo(subtotal, 6);
  return taxRates
    .map((tax) => {
      const amount = roundTo((subtotal * tax.rate) / 100, digits);
      return {
        kind: "tax" as const,
        refId: null,
        label: describeTaxRate(tax),
        currency: invoiceCurrency,
        collected: 0,
        adjustment: amount,
        adjusted: amount,
        rate: 1,
        billed: amount,
      };
    })
    .filter((line) => line.billed !== 0 || subtotal !== 0);
}

/* ------------------------------------------------------------------ *
 * Audit
 * ------------------------------------------------------------------ */

/** Everything but the last four characters, so an auditor can tell accounts apart. */
export function maskSecretTail(value: string | null): string | null {
  if (value === null) return null;
  const compact = value.replace(/\s+/g, "");
  if (compact.length <= 4) return "••••";
  return `•••• ${compact.slice(-4)}`;
}

/** Bank details as they may appear in an audit entry. */
export function maskBillingProfileBank(bank: BillingProfileBank | null): BillingProfileBank | null {
  if (!bank) return null;
  return {
    ...bank,
    iban: maskSecretTail(bank.iban),
    accountNumber: maskSecretTail(bank.accountNumber),
    // Free text can hold an account number too, and an audit entry is read
    // by more people than the invoice is.
    instructions: bank.instructions === null ? null : "(set)",
  };
}

type AuditValue = string | number | boolean | null | string[] | BillingProfileTaxRate[] | object;

/** The fields a profile change is described by in the audit log. */
const AUDITED_FIELDS = [
  "name",
  "legalName",
  "address",
  "taxId",
  "poNumber",
  "toEmails",
  "ccEmails",
  "currency",
  "paymentTermsDays",
  "numberPrefix",
  "numberIncludesYear",
  "numberStart",
  "taxRates",
  "bank",
  "footer",
  "logo",
] as const;

type AuditedProfile = Pick<BillingProfile, (typeof AUDITED_FIELDS)[number]>;

function auditValue(field: (typeof AUDITED_FIELDS)[number], profile: AuditedProfile): AuditValue {
  if (field === "bank") return maskBillingProfileBank(profile.bank);
  // The image itself is not an audit fact; that it changed is.
  if (field === "logo") return profile.logo ? "(image)" : null;
  return profile[field] as AuditValue;
}

/**
 * What changed between two versions of a profile, field by field, with the
 * bank account numbers masked and the logo reduced to whether there is one.
 * `before` null describes a creation.
 */
export function billingProfileAuditChanges(
  before: AuditedProfile | null,
  after: AuditedProfile,
): Record<string, { from: AuditValue; to: AuditValue }> {
  const changes: Record<string, { from: AuditValue; to: AuditValue }> = {};
  for (const field of AUDITED_FIELDS) {
    const from = before ? auditValue(field, before) : null;
    const to = auditValue(field, after);
    const changed =
      field === "logo"
        ? (before?.logo ?? null) !== after.logo
        : JSON.stringify(from) !== JSON.stringify(to) ||
          // Two IBANs ending in the same four digits mask identically; the
          // change still happened.
          (field === "bank" && JSON.stringify(before?.bank ?? null) !== JSON.stringify(after.bank));
    if (changed && (before !== null || to !== null)) changes[field] = { from, to };
  }
  return changes;
}

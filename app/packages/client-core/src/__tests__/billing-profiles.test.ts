import { describe, expect, it } from "vitest";
import {
  billingProfileAuditChanges,
  ibanIsValid,
  managedInvoiceTaxLines,
  maskBillingProfileBank,
  nextInvoiceNumber,
  normalizeBillingProfileInput,
  parseInvoiceNumber,
  resolveInvoiceBilling,
  type BillingProfile,
} from "../billing-profiles";
import {
  formatManagedInvoiceNumber,
  managedInvoiceReconciles,
  parseManagedInvoiceNumber,
  sumManagedInvoiceLines,
} from "../managed-accounts";

function profile(overrides: Partial<BillingProfile> = {}): BillingProfile {
  return {
    id: "bp-1",
    name: "EU customers",
    legalName: null,
    address: null,
    taxId: null,
    poNumber: null,
    toEmails: [],
    ccEmails: [],
    currency: null,
    paymentTermsDays: null,
    numberPrefix: "INV",
    numberIncludesYear: true,
    numberStart: 1,
    taxRates: [],
    bank: null,
    footer: null,
    logo: null,
    managedAccountIds: [],
    createdByUserId: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

const customer = {
  name: "Northwind Trading",
  contactName: "Ada",
  contactEmail: "ap@northwind.example; Ops@Northwind.example",
  billingAddress: "1 Quay St",
  billingCurrency: "GBP",
};

describe("normalizeBillingProfileInput", () => {
  it("trims, lowercases emails and fills the defaults", () => {
    const result = normalizeBillingProfileInput({
      name: "  EU  ",
      toEmails: [" AP@Example.com ", "ap@example.com", ""],
      currency: "eur",
    });
    expect(result.error).toBeUndefined();
    expect(result.value).toMatchObject({
      name: "EU",
      toEmails: ["ap@example.com"],
      currency: "EUR",
      numberPrefix: "INV",
      numberIncludesYear: true,
      numberStart: 1,
      paymentTermsDays: null,
      bank: null,
      logo: undefined,
    });
  });

  it("refuses what a person would want to be told about", () => {
    expect(normalizeBillingProfileInput({ name: "" }).error).toMatch(/needs a name/);
    expect(normalizeBillingProfileInput({ name: "x", toEmails: ["nope"] }).error).toMatch(
      /not an email/,
    );
    expect(normalizeBillingProfileInput({ name: "x", currency: "EURO" }).error).toMatch(/ISO 4217/);
    expect(normalizeBillingProfileInput({ name: "x", paymentTermsDays: 1.5 }).error).toMatch(
      /whole number of days/,
    );
    expect(normalizeBillingProfileInput({ name: "x", numberPrefix: "IN V" }).error).toMatch(
      /prefix/,
    );
    expect(normalizeBillingProfileInput({ name: "x", numberPrefix: "INV-" }).error).toMatch(
      /prefix/,
    );
    expect(
      normalizeBillingProfileInput({ name: "x", taxRates: [{ name: "VAT", rate: 120 }] }).error,
    ).toMatch(/0 to 100/);
    expect(
      normalizeBillingProfileInput({ name: "x", bank: { iban: "GB00 0000 0000 0000" } as never })
        .error,
    ).toMatch(/IBAN/);
    expect(
      normalizeBillingProfileInput({ name: "x", bank: { bic: "NOPE" } as never }).error,
    ).toMatch(/SWIFT/);
    expect(
      normalizeBillingProfileInput({ name: "x", logo: "data:image/gif;base64,AAAA" }).error,
    ).toMatch(/PNG or JPEG/);
  });

  it("formats a valid IBAN in groups of four and drops an all-empty bank block", () => {
    const withBank = normalizeBillingProfileInput({
      name: "x",
      bank: { iban: "gb82west12345698765432", bic: "westgb2l" } as never,
    });
    expect(withBank.value?.bank).toMatchObject({
      iban: "GB82 WEST 1234 5698 7654 32",
      bic: "WESTGB2L",
    });
    const empty = normalizeBillingProfileInput({ name: "x", bank: { iban: "  " } as never });
    expect(empty.value?.bank).toBeNull();
  });

  it("distinguishes leaving the logo alone from removing it", () => {
    expect(normalizeBillingProfileInput({ name: "x" }).value?.logo).toBeUndefined();
    expect(normalizeBillingProfileInput({ name: "x", logo: null }).value?.logo).toBeNull();
  });
});

describe("ibanIsValid", () => {
  it("checks the mod-97 digits", () => {
    expect(ibanIsValid("GB82 WEST 1234 5698 7654 32")).toBe(true);
    expect(ibanIsValid("DE89370400440532013000")).toBe(true);
    expect(ibanIsValid("GB83 WEST 1234 5698 7654 32")).toBe(false);
    expect(ibanIsValid("not an iban")).toBe(false);
  });
});

describe("invoice numbers", () => {
  it("keeps the historic format", () => {
    expect(formatManagedInvoiceNumber(2026, 7)).toBe("INV-2026-0007");
    expect(parseManagedInvoiceNumber("INV-2026-0007")).toEqual({ year: 2026, sequence: 7 });
  });

  it("anchors on the whole prefix", () => {
    const fmt = { prefix: "INV", includeYear: true };
    expect(parseInvoiceNumber(fmt, "INV-UK-2026-0001")).toBeNull();
    expect(parseInvoiceNumber({ prefix: "NW", includeYear: false }, "NW-0042")).toEqual({
      year: null,
      sequence: 42,
    });
  });

  it("continues the sequence per prefix and year, from the start number", () => {
    const fmt = { prefix: "NW", includeYear: true };
    expect(nextInvoiceNumber(fmt, 2026, 1, ["NW-2026-0003", "NW-2025-0099", "INV-2026-0500"])).toBe(
      "NW-2026-0004",
    );
    expect(nextInvoiceNumber(fmt, 2026, 100, ["NW-2026-0003"])).toBe("NW-2026-0100");
    expect(nextInvoiceNumber({ prefix: "NW", includeYear: false }, 2026, 1, ["NW-0009"])).toBe(
      "NW-0010",
    );
  });

  it("never hands out a number another format already issued", () => {
    // `INV-2026` without the year produces strings an `INV` + year format owns.
    const fmt = { prefix: "INV-2026", includeYear: false };
    expect(nextInvoiceNumber(fmt, 2026, 1, ["INV-2026-0001"])).toBe("INV-2026-0002");
  });
});

describe("resolveInvoiceBilling", () => {
  it("falls back to the customer where the profile is silent", () => {
    const billing = resolveInvoiceBilling(customer, null, "2026-02-01");
    expect(billing).toMatchObject({
      profileId: null,
      legalName: "Northwind Trading",
      attention: "Ada",
      address: "1 Quay St",
      to: ["ap@northwind.example", "ops@northwind.example"],
      cc: [],
      dueDate: null,
      numberPrefix: "INV",
    });
  });

  it("lets the profile win where it speaks, and unions the recipients", () => {
    const billing = resolveInvoiceBilling(
      customer,
      profile({
        legalName: "Northwind GmbH",
        address: "Hauptstrasse 1",
        toEmails: ["billing@northwind.example", "ap@northwind.example"],
        ccEmails: ["ar@fabrikam.example", "billing@northwind.example"],
        paymentTermsDays: 30,
        numberPrefix: "NW",
      }),
      "2026-01-31",
    );
    expect(billing.legalName).toBe("Northwind GmbH");
    expect(billing.address).toBe("Hauptstrasse 1");
    expect(billing.to).toEqual([
      "ap@northwind.example",
      "ops@northwind.example",
      "billing@northwind.example",
    ]);
    // Someone on both lists gets the one addressed copy.
    expect(billing.cc).toEqual(["ar@fabrikam.example"]);
    expect(billing.dueDate).toBe("2026-03-02");
    expect(billing.numberPrefix).toBe("NW");
  });
});

describe("managedInvoiceTaxLines", () => {
  const lines = [
    {
      kind: "cost_centre",
      currency: "USD",
      collected: 100,
      adjustment: 15,
      adjusted: 115,
      rate: 0.8,
      billed: 92,
    },
    {
      kind: "fixed",
      currency: "GBP",
      collected: 0,
      adjustment: 8.5,
      adjusted: 8.5,
      rate: 1,
      billed: 8.5,
    },
    {
      kind: "account",
      currency: "SEK",
      collected: 50,
      adjustment: 0,
      adjusted: 50,
      rate: null,
      billed: null,
    },
  ];

  it("taxes the converted subtotal once per rate, without compounding", () => {
    const taxes = managedInvoiceTaxLines(lines, "GBP", [
      { name: "VAT", rate: 20 },
      { name: "Levy", rate: 1.5 },
    ]);
    expect(taxes.map((t) => [t.label, t.billed])).toEqual([
      ["VAT (20%)", 20.1],
      ["Levy (1.5%)", 1.51],
    ]);
  });

  it("rounds to the currency's minor unit", () => {
    const [tax] = managedInvoiceTaxLines(
      [{ kind: "cost_centre", currency: "JPY", billed: 1001 }],
      "JPY",
      [{ name: "Consumption tax", rate: 10 }],
    );
    expect(tax!.billed).toBe(100);
  });

  it("keeps the invoice reconcilable", () => {
    const all = [...lines, ...managedInvoiceTaxLines(lines, "GBP", [{ name: "VAT", rate: 20 }])];
    expect(managedInvoiceReconciles(sumManagedInvoiceLines(all as never, "GBP"))).toBe(true);
  });

  it("adds nothing without rates or spend", () => {
    expect(managedInvoiceTaxLines(lines, "GBP", [])).toEqual([]);
    expect(managedInvoiceTaxLines([], "GBP", [{ name: "VAT", rate: 20 }])).toEqual([]);
  });
});

describe("audit masking", () => {
  const bank = {
    accountName: "Fabrikam Ltd",
    bankName: "West Bank",
    iban: "GB82 WEST 1234 5698 7654 32",
    bic: "WESTGB2L",
    accountNumber: "98765432",
    routingNumber: "12-34-56",
    instructions: "Account 98765432, quote the invoice number",
  };

  it("keeps only the tail of account numbers and hides free text", () => {
    expect(maskBillingProfileBank(bank)).toEqual({
      ...bank,
      iban: "•••• 5432",
      accountNumber: "•••• 5432",
      instructions: "(set)",
    });
  });

  it("describes a change without the full account number or the image", () => {
    const before = profile({ bank, logo: "data:image/png;base64,AAAA" });
    const after = profile({
      bank: { ...bank, iban: "DE89 3704 0044 0532 0130 00" },
      logo: "data:image/png;base64,BBBB",
      paymentTermsDays: 14,
    });
    const changes = billingProfileAuditChanges(before, after);
    expect(Object.keys(changes).sort()).toEqual(["bank", "logo", "paymentTermsDays"]);
    expect(JSON.stringify(changes)).not.toContain("3704 0044");
    expect(JSON.stringify(changes)).not.toContain("98765432");
    expect(changes["logo"]).toEqual({ from: "(image)", to: "(image)" });
  });

  it("notices an IBAN change that masks identically", () => {
    const before = profile({ bank: { ...bank, iban: "GB82 WEST 1234 5698 7654 32" } });
    const after = profile({ bank: { ...bank, iban: "GB33 BUKB 2020 1555 5555 5432" } });
    expect(Object.keys(billingProfileAuditChanges(before, after))).toEqual(["bank"]);
  });
});

import { describe, expect, it } from "vitest";
import {
  dedupeScopeCentres,
  describeManagedInvoiceTotal,
  formatManagedInvoiceNumber,
  managedAccountScopeConflicts,
  managedInvoiceBlocker,
  managedInvoiceIsFrozen,
  managedInvoiceReconciles,
  parseManagedInvoiceNumber,
  sumManagedInvoiceLines,
  type ManagedInvoiceLine,
} from "../managed-accounts";

function line(over: Partial<ManagedInvoiceLine> = {}): ManagedInvoiceLine {
  return {
    kind: "cost_centre",
    refId: "cc-1",
    label: "Platform",
    currency: "USD",
    collected: 1000,
    adjustment: 150,
    adjusted: 1150,
    rate: 0.8,
    billed: 920,
    ...over,
  };
}

/**
 * `managedInvoiceBlocker` is the single statement of the state machine, used by
 * the service to refuse and by the UI to disable. If the two ever disagreed,
 * one of them would be lying to a user about what is possible — so both call
 * this, and this is what is pinned.
 */
describe("managedInvoiceBlocker", () => {
  it("lets a draft be edited, deleted and approved, and nothing else", () => {
    const draft = { status: "draft" as const };
    expect(managedInvoiceBlocker(draft, "edit")).toBeNull();
    expect(managedInvoiceBlocker(draft, "delete")).toBeNull();
    expect(managedInvoiceBlocker(draft, "approve")).toBeNull();
    expect(managedInvoiceBlocker(draft, "send")).toMatch(/Approve this invoice before sending/);
    expect(managedInvoiceBlocker(draft, "void")).toMatch(/never issued/);
  });

  it("lets an approved invoice be sent or voided, and never edited or deleted", () => {
    const approved = { status: "approved" as const };
    expect(managedInvoiceBlocker(approved, "send")).toBeNull();
    expect(managedInvoiceBlocker(approved, "void")).toBeNull();
    expect(managedInvoiceBlocker(approved, "approve")).toMatch(/Only a draft/);
    expect(managedInvoiceBlocker(approved, "edit")).toMatch(/frozen/);
    expect(managedInvoiceBlocker(approved, "delete")).toMatch(/Void it and raise a corrective/);
  });

  it("lets a sent invoice only be voided", () => {
    const sent = { status: "sent" as const };
    expect(managedInvoiceBlocker(sent, "void")).toBeNull();
    expect(managedInvoiceBlocker(sent, "send")).toMatch(/already been marked as sent/);
    expect(managedInvoiceBlocker(sent, "edit")).toMatch(/sent to the customer/);
    expect(managedInvoiceBlocker(sent, "delete")).toMatch(/sent to the customer/);
  });

  it("makes a void invoice terminal", () => {
    const dead = { status: "void" as const };
    for (const action of ["edit", "delete", "approve", "send"] as const) {
      expect(managedInvoiceBlocker(dead, action)).toMatch(/historical record/);
    }
    expect(managedInvoiceBlocker(dead, "void")).toMatch(/already void/);
  });

  it("blocks approval while a currency has no stated rate", () => {
    const blocked = managedInvoiceBlocker(
      { status: "draft", derivation: { unconverted: ["SEK", "NOK"] } },
      "approve",
    );
    expect(blocked).toMatch(/SEK, NOK/);
    expect(blocked).toMatch(/Settings → Currency/);
    // …but only approval. A draft with an unconvertible line is still editable.
    expect(
      managedInvoiceBlocker({ status: "draft", derivation: { unconverted: ["SEK"] } }, "edit"),
    ).toBeNull();
  });

  it("agrees with managedInvoiceIsFrozen about which statuses recompute", () => {
    expect(managedInvoiceIsFrozen("draft")).toBe(false);
    for (const status of ["approved", "sent", "void"] as const) {
      expect(managedInvoiceIsFrozen(status)).toBe(true);
      expect(managedInvoiceBlocker({ status }, "edit")).not.toBeNull();
    }
  });
});

describe("sumManagedInvoiceLines", () => {
  it("keeps collected + adjustment === adjusted per currency", () => {
    const totals = sumManagedInvoiceLines(
      [
        line(),
        line({
          currency: "EUR",
          collected: 500,
          adjustment: 75,
          adjusted: 575,
          rate: 0.85,
          billed: 488.75,
        }),
      ],
      "GBP",
    );
    expect(totals.collected).toEqual({ USD: 1000, EUR: 500 });
    expect(totals.adjustment).toEqual({ USD: 150, EUR: 75 });
    expect(totals.adjusted).toEqual({ USD: 1150, EUR: 575 });
    expect(totals.billed).toEqual({ GBP: 1408.75 });
    expect(managedInvoiceReconciles(totals)).toBe(true);
  });

  it("carries an unconvertible line in its own currency rather than dropping it", () => {
    const totals = sumManagedInvoiceLines(
      [
        line(),
        line({
          currency: "SEK",
          collected: 4000,
          adjustment: 0,
          adjusted: 4000,
          rate: null,
          billed: null,
        }),
      ],
      "GBP",
    );
    // The SEK is visibly there. Omitting it would understate the invoice, which
    // is the worst arithmetic failure this could have.
    expect(totals.billed).toEqual({ GBP: 920, SEK: 4000 });
  });

  it("reports a negative adjustment (a discount) without breaking the identity", () => {
    const totals = sumManagedInvoiceLines(
      [
        line({
          collected: 1000,
          adjustment: -100,
          adjusted: 900,
          rate: 1,
          billed: 900,
          currency: "GBP",
        }),
      ],
      "GBP",
    );
    expect(managedInvoiceReconciles(totals)).toBe(true);
    expect(totals.billed).toEqual({ GBP: 900 });
  });
});

describe("managedInvoiceReconciles", () => {
  it("catches a total that does not add up", () => {
    expect(
      managedInvoiceReconciles({
        collected: { USD: 1000 },
        adjustment: { USD: 150 },
        adjusted: { USD: 1200 },
        billed: { GBP: 960 },
      }),
    ).toBe(false);
  });

  it("tolerates accumulated rounding below half a millionth", () => {
    expect(
      managedInvoiceReconciles({
        collected: { USD: 1000 },
        adjustment: { USD: 150 },
        adjusted: { USD: 1150.0000002 },
        billed: {},
      }),
    ).toBe(true);
  });
});

describe("dedupeScopeCentres", () => {
  const parentOf = new Map<string, string | null>([
    ["eng", null],
    ["platform", "eng"],
    ["search", "platform"],
    ["sales", null],
  ]);

  it("drops a descendant when an ancestor is also selected", () => {
    // A line quotes a centre's subtree, so keeping both would bill Search twice.
    expect(dedupeScopeCentres(["eng", "search"], parentOf)).toEqual(["eng"]);
    expect(dedupeScopeCentres(["platform", "search"], parentOf)).toEqual(["platform"]);
    expect(dedupeScopeCentres(["eng", "platform", "search"], parentOf)).toEqual(["eng"]);
  });

  it("keeps unrelated centres", () => {
    expect(dedupeScopeCentres(["platform", "sales"], parentOf)).toEqual(["platform", "sales"]);
  });

  it("survives a cycle in the tree rather than looping forever", () => {
    const cyclic = new Map<string, string | null>([
      ["a", "b"],
      ["b", "a"],
    ]);
    expect(dedupeScopeCentres(["a"], cyclic)).toEqual(["a"]);
  });
});

describe("managedAccountScopeConflicts", () => {
  const others = [
    { id: "c1", name: "Northwind", costCentreIds: ["platform"], accountIds: ["acc-1"] },
    { id: "c2", name: "Contoso", costCentreIds: ["sales"], accountIds: [] },
  ];

  it("names the customer already billed for a centre", () => {
    const conflicts = managedAccountScopeConflicts(
      { costCentreIds: ["platform"], accountIds: [] },
      others,
    );
    expect(conflicts).toEqual([{ kind: "cost_centre", id: "platform", ownerName: "Northwind" }]);
  });

  it("catches an account claimed twice", () => {
    const conflicts = managedAccountScopeConflicts(
      { costCentreIds: [], accountIds: ["acc-1"] },
      others,
    );
    expect(conflicts[0]!.kind).toBe("account");
    expect(conflicts[0]!.ownerName).toBe("Northwind");
  });

  it("is silent when nothing overlaps", () => {
    expect(
      managedAccountScopeConflicts({ costCentreIds: ["marketing"], accountIds: [] }, others),
    ).toEqual([]);
  });
});

describe("invoice numbers", () => {
  it("pads to four digits and round-trips", () => {
    expect(formatManagedInvoiceNumber(2026, 1)).toBe("INV-2026-0001");
    expect(formatManagedInvoiceNumber(2026, 1234)).toBe("INV-2026-1234");
    expect(parseManagedInvoiceNumber("INV-2026-0042")).toEqual({ year: 2026, sequence: 42 });
  });

  it("keeps parsing past four digits, so a busy year does not wrap", () => {
    expect(parseManagedInvoiceNumber("INV-2026-12345")).toEqual({ year: 2026, sequence: 12345 });
  });

  it("rejects anything that is not one of ours", () => {
    expect(parseManagedInvoiceNumber("2026-0001")).toBeNull();
    expect(parseManagedInvoiceNumber("INV-26-0001")).toBeNull();
  });
});

describe("describeManagedInvoiceTotal", () => {
  it("says so rather than showing zero when a draft has no computed total", () => {
    expect(describeManagedInvoiceTotal(null, "GBP")).toBe("not computed");
  });

  it("puts the invoice currency first", () => {
    expect(
      describeManagedInvoiceTotal(
        { collected: {}, adjustment: {}, adjusted: {}, billed: { SEK: 4000, GBP: 1200.5 } },
        "GBP",
      ),
    ).toBe("1200.50 GBP + 4000.00 SEK");
  });
});

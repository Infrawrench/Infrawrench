import { capacityDeclarations, resolveCapacityLimit } from "@infrawrench/plugin-base";
import { describe, expect, it } from "vitest";
import { mapBudget } from "../mappers.js";
import { BudgetResourceType } from "../resource-types.js";

// A budget as `GET /organizations/{org}/settings/billing/budgets` returns it.
const BUDGET = {
  id: "b-1",
  budget_type: "ProductPricing" as const,
  budget_product_sku: "actions",
  budget_scope: "organization",
  budget_entity_name: "acme",
  budget_amount: 200,
  prevent_further_usage: true,
  budget_alerting: { will_alert: true, alert_recipients: ["octocat"] },
};

describe("budget runway", () => {
  it("measures this month's spend against a budget that stops usage", () => {
    const budget = mapBudget("acct", BUDGET, 120);
    expect(budget.fields["spentThisMonth"]).toBe(120);
    expect(budget.fields["stopsAt"]).toBe(200);
    const [decl] = capacityDeclarations(BudgetResourceType);
    expect(decl!.valueKey).toBe("spentThisMonth");
    expect(decl!.declaration.cycle?.period).toBe("monthly");
    expect(resolveCapacityLimit(decl!.declaration.limit, budget.fields)?.limit).toBe(200);
  });

  it("states no limit for an alert-only budget or a licence budget", () => {
    const alertOnly = mapBudget("acct", { ...BUDGET, prevent_further_usage: false }, 120);
    expect(alertOnly.fields["stopsAt"]).toBeUndefined();
    const licences = mapBudget(
      "acct",
      { ...BUDGET, budget_type: "SkuPricing", budget_product_sku: "ghas_licenses" },
      120,
    );
    expect(licences.fields["stopsAt"]).toBeUndefined();
  });
});

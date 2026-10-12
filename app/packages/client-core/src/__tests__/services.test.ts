import { describe, expect, it } from "vitest";
import {
  SERVICE_DEFAULTS,
  describeServiceRule,
  normalizeServiceRule,
  serviceRuleMatches,
  slugifyServiceName,
  validateServiceInput,
  type ServiceMembershipRule,
} from "../services";

const rule = (r: Partial<ServiceMembershipRule>): ServiceMembershipRule => normalizeServiceRule(r);

const target = {
  pluginId: "aws",
  accountId: "acct-1",
  displayName: "checkout-db-prod",
  fields: { tags: { Service: "checkout", env: "prod" } },
};

describe("serviceRuleMatches", () => {
  it("matches a tag key case-insensitively and its value exactly", () => {
    expect(
      serviceRuleMatches(rule({ kind: "tag", key: "service", value: "checkout" }), target),
    ).toBe(true);
    expect(
      serviceRuleMatches(rule({ kind: "tag", key: "service", value: "Checkout" }), target),
    ).toBe(false);
  });

  it("treats a tag rule without a value as any value", () => {
    expect(serviceRuleMatches(rule({ kind: "tag", key: "env" }), target)).toBe(true);
    expect(serviceRuleMatches(rule({ kind: "tag", key: "team" }), target)).toBe(false);
  });

  it("never matches a resource that carries no tags", () => {
    expect(
      serviceRuleMatches(rule({ kind: "tag", key: "env" }), { ...target, fields: { size: "s" } }),
    ).toBe(false);
  });

  it("matches names by each mode, case-insensitively", () => {
    expect(serviceRuleMatches(rule({ kind: "name", value: "CHECKOUT" }), target)).toBe(true);
    expect(
      serviceRuleMatches(rule({ kind: "name", value: "checkout", nameMatch: "prefix" }), target),
    ).toBe(true);
    expect(
      serviceRuleMatches(rule({ kind: "name", value: "-prod", nameMatch: "suffix" }), target),
    ).toBe(true);
    expect(
      serviceRuleMatches(rule({ kind: "name", value: "checkout", nameMatch: "exact" }), target),
    ).toBe(false);
  });

  it("narrows by provider and account", () => {
    expect(
      serviceRuleMatches(rule({ kind: "name", value: "checkout", pluginId: "gcp" }), target),
    ).toBe(false);
    expect(
      serviceRuleMatches(rule({ kind: "name", value: "checkout", accountId: "acct-1" }), target),
    ).toBe(true);
  });

  it("leaves virtual tag rules to the server", () => {
    expect(
      serviceRuleMatches(rule({ kind: "virtual_tag", key: "team", value: "payments" }), target),
    ).toBe(false);
  });
});

describe("normalizeServiceRule", () => {
  it("nulls the key of a name rule and defaults its match mode", () => {
    expect(rule({ kind: "name", key: "ignored", value: " api " })).toEqual({
      kind: "name",
      key: null,
      value: "api",
      nameMatch: "contains",
      pluginId: null,
      accountId: null,
    });
  });

  it("drops the match mode from a tag rule", () => {
    expect(rule({ kind: "tag", key: "env", nameMatch: "exact" }).nameMatch).toBeNull();
  });
});

describe("slugifyServiceName", () => {
  it("lower-cases and dashes", () => {
    expect(slugifyServiceName("Checkout API (v2)")).toBe("checkout-api-v2");
    expect(slugifyServiceName("  Café  Search ")).toBe("cafe-search");
    expect(slugifyServiceName("!!!")).toBe("");
  });
});

describe("validateServiceInput", () => {
  const base = { ...SERVICE_DEFAULTS, name: "Checkout API" };

  it("accepts a minimal service", () => {
    expect(validateServiceInput(base)).toBeNull();
  });

  it("rejects a bad slug, tier, link and rule", () => {
    expect(validateServiceInput({ ...base, slug: "-bad" })).toMatch(/slug/);
    expect(validateServiceInput({ ...base, tier: 5 as never })).toMatch(/tier/);
    expect(
      validateServiceInput({ ...base, links: [{ label: "Repo", url: "ftp://example.com" }] }),
    ).toMatch(/http/);
    expect(
      validateServiceInput({ ...base, rules: [rule({ kind: "virtual_tag", key: "team" })] }),
    ).toMatch(/virtual tag value/);
  });

  it("requires a currency with a budget", () => {
    expect(validateServiceInput({ ...base, monthlyBudget: 100 })).toMatch(/currency/);
    expect(validateServiceInput({ ...base, monthlyBudget: 100, budgetCurrency: "USD" })).toBeNull();
  });
});

describe("describeServiceRule", () => {
  it("reads as a phrase", () => {
    expect(describeServiceRule(rule({ kind: "tag", key: "service", value: "checkout" }))).toBe(
      "tagged service=checkout",
    );
    expect(describeServiceRule(rule({ kind: "name", value: "api", nameMatch: "prefix" }))).toBe(
      'name starts with "api"',
    );
  });
});

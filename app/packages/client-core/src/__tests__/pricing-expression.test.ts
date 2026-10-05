/**
 * The pricing expression language: what it accepts, what it refuses, and that
 * nothing a user types can reach anything but the fields of one cost line.
 */
import { describe, expect, it } from "vitest";
import {
  PRICING_EXPRESSION_LIMITS,
  PricingExpressionError,
  PricingExpressionRuntimeError,
  compilePricingExpression,
  evaluatePricingExpression,
  pricingExpressionError,
  type PricingExpressionContext,
} from "../pricing-expression";

function ctx(over: Partial<PricingExpressionContext> = {}): PricingExpressionContext {
  return {
    cost: 100,
    collected: 100,
    listCost: 120,
    usage: 50,
    unit: "Hrs",
    service: "AmazonEC2",
    provider: "aws",
    account: "acc-1",
    accountName: "Production",
    region: "us-east-1",
    chargeType: "usage",
    currency: "USD",
    month: "2026-09",
    customer: "Northwind",
    tags: new Map([["env", "prod"]]),
    ...over,
  };
}

function run(source: string, over: Partial<PricingExpressionContext> = {}): number {
  return evaluatePricingExpression(compilePricingExpression(source), ctx(over));
}

function errorOf(source: string): { message: string; position: number } {
  const e = pricingExpressionError(source);
  if (!e) throw new Error(`expected "${source}" to be refused`);
  return e;
}

describe("pricing expressions: evaluation", () => {
  it("evaluates the example from the docs", () => {
    const src = 'if service == "AmazonEC2" and tag.env == "prod" then cost * 1.1';
    expect(run(src)).toBeCloseTo(110);
    expect(run(src, { tags: new Map([["env", "dev"]]) })).toBe(100);
  });

  it("leaves a line unchanged when a top-level if has no else", () => {
    expect(run('if provider == "gcp" then cost * 2')).toBe(100);
  });

  it("supports else and else-if chains", () => {
    const src =
      'if region == "eu-west-1" then cost * 1.2 else if region == "us-east-1" then cost * 1.1 else cost';
    expect(run(src)).toBeCloseTo(110);
    expect(run(src, { region: "eu-west-1" })).toBeCloseTo(120);
    expect(run(src, { region: "ap-south-1" })).toBe(100);
  });

  it("respects arithmetic precedence and parentheses", () => {
    expect(run("cost + 2 * 3")).toBe(106);
    expect(run("(cost + 2) * 3")).toBe(306);
    expect(run("-cost + 1")).toBe(-99);
    expect(run("cost - 1 - 1")).toBe(98);
    expect(run("cost / 4 / 5")).toBe(5);
  });

  it("reads list_cost, falling back to collected when there is no list price", () => {
    expect(run("max(cost, list_cost)")).toBe(120);
    expect(run("list_cost", { listCost: null })).toBe(100);
    expect(
      run("if has_list_price then list_cost else cost * 1.05", { listCost: null }),
    ).toBeCloseTo(105);
  });

  it("supports in, not in, and the string functions", () => {
    expect(run('if service in ["AmazonEC2", "AmazonRDS"] then cost * 2')).toBe(200);
    expect(run('if service not in ["AmazonEC2"] then cost * 2')).toBe(100);
    expect(run('if starts_with(service, "Amazon") then 1 else 0')).toBe(1);
    expect(run('if contains(lower(account_name), "prod") then 1 else 0')).toBe(1);
    expect(run('if ends_with(unit, "rs") then 1 else 0')).toBe(1);
    expect(run('if has_tag("env") and not has_tag("team") then 1 else 0')).toBe(1);
  });

  it("reads tags with special characters through the bracket form", () => {
    expect(
      run('if tag["cost-centre"] == "a/b" then 7 else 0', {
        tags: new Map([["cost-centre", "a/b"]]),
      }),
    ).toBe(7);
  });

  it("reads a missing tag as the empty string", () => {
    expect(run('if tag.team == "" then 1 else 0')).toBe(1);
  });

  it("rounds, clamps and takes absolute values", () => {
    expect(run("round(cost / 3)")).toBe(33.33);
    expect(run("round(cost / 3, 0)")).toBe(33);
    expect(run("min(cost, 50, 75)")).toBe(50);
    expect(run("abs(0 - cost)")).toBe(100);
  });

  it("collects the tag keys and fields an expression reads", () => {
    const c = compilePricingExpression(
      'if tag.env == "prod" and has_tag("team") then cost else usage',
    );
    expect(c.tagKeys).toEqual(["env", "team"]);
    expect(c.fields).toEqual(["cost", "usage"]);
  });

  it("short-circuits and/or, so a guarded division is safe", () => {
    expect(run("if usage > 0 and cost / usage > 1 then 1 else 0", { usage: 0 })).toBe(0);
  });
});

describe("pricing expressions: runtime errors", () => {
  it("refuses division by zero rather than producing infinity", () => {
    expect(() => run("cost / 0")).toThrow(PricingExpressionRuntimeError);
  });

  it("refuses implausibly large results", () => {
    expect(() => run("cost * 1e20")).toThrow(PricingExpressionRuntimeError);
  });

  it("refuses round() outside 0 to 6 places", () => {
    expect(() => run("round(cost, 9)")).toThrow(PricingExpressionRuntimeError);
  });
});

describe("pricing expressions: parse and type errors", () => {
  it.each([
    ["", "The expression is empty."],
    ["cost *", "ends too early"],
    ["cost = 1", 'Use "=="'],
    ['service == "x" && cost > 1', 'Use "and"'],
    ["!true", 'Use "not"'],
    ["(cost", 'closing ")"'],
    ['"unterminated', "never closed"],
    ["foo", '"foo" is not a field'],
    ["eval(cost)", '"eval" is not a function'],
    ["cost cost", "should have ended"],
    ["service == 1", "Cannot compare"],
    ['cost + "a"', "works on numbers"],
    ['service == "EC2"', "must give the line's new cost"],
    ["if cost then 1", "must be true or false"],
    ['if true then "a" else "b"', "must give the line's new cost"],
    ["cost * if true then 2", 'needs an "else"'],
    ["1 < 2 < 3", "cannot be chained"],
    ["min(cost)", "takes 2 to 16 arguments"],
    ['service in "abc"', "needs a list"],
    ['cost in [1, "a"]', "same kind"],
    ["12abc", "is not a number"],
    ["tag", "Read a tag as"],
    ["tag[env]", "quoted key"],
    ["cost; drop table", '";" is not allowed'],
    ["`cost`", '"`" is not allowed'],
  ])("refuses %j", (source, fragment) => {
    expect(errorOf(source).message).toContain(fragment);
  });

  it("points at the offending character", () => {
    expect(errorOf("cost * $").position).toBe(7);
    expect(errorOf('cost + "x"').position).toBe(5);
  });

  it("throws a PricingExpressionError, never anything else", () => {
    expect(() => compilePricingExpression("cost +")).toThrow(PricingExpressionError);
  });
});

describe("pricing expressions: hostile input", () => {
  it("cannot reach prototypes through fields, functions or tags", () => {
    expect(errorOf("__proto__").message).toContain("is not a field");
    expect(errorOf("constructor").message).toContain("is not a field");
    expect(errorOf("toString(cost)").message).toContain("is not a function");
    expect(errorOf("hasOwnProperty(cost, cost)").message).toContain("is not a function");
    expect(errorOf("__proto__(cost)").message).toContain("is not a function");
    // A tag is a Map lookup: these are just keys nobody set.
    expect(run('if tag.__proto__ == "" and tag.constructor == "" then 1 else 0')).toBe(1);
    expect(run('if tag["__proto__"] == "" then 1 else 0')).toBe(1);
  });

  it("does not interpret code, template syntax or SQL inside strings", () => {
    const payloads = [
      "'; DROP TABLE cost_daily; --",
      "${process.exit(1)}",
      '") or 1=1 --',
      "<script>alert(1)</script>",
      "require('child_process')",
    ];
    for (const p of payloads) {
      const quoted = JSON.stringify(p).replace(/^"|"$/g, "").replace(/\\"/g, '\\"');
      const src = `if service == "${quoted}" then 0 else cost`;
      expect(pricingExpressionError(src)).toBeNull();
      expect(run(src)).toBe(100);
    }
  });

  it("refuses an over-long source before reading it", () => {
    const src = "cost" + " + 1".repeat(PRICING_EXPRESSION_LIMITS.maxLength);
    expect(errorOf(src).message).toContain("at most");
  });

  it("refuses deep nesting without overflowing the stack", () => {
    expect(errorOf("(".repeat(5000) + "cost" + ")".repeat(5000)).message).toContain("at most");
    expect(errorOf("(".repeat(100) + "cost" + ")".repeat(100)).message).toContain("nests more");
    expect(errorOf("-".repeat(100) + "cost").message).toContain("nests more");
    expect(errorOf("not ".repeat(100) + "true").message).toContain("nests more");
  });

  it("refuses too many tokens", () => {
    const src = Array.from({ length: 400 }, () => "1").join("+");
    expect(errorOf(src).message).toMatch(/tokens|too large/);
  });

  it("refuses a long chain of terms", () => {
    const src = Array.from({ length: 250 }, () => "cost").join("+");
    expect(errorOf(src).message).toMatch(/too large|tokens/);
  });

  it("refuses huge string literals and huge lists", () => {
    expect(errorOf(`if service == "${"a".repeat(300)}" then 1`).message).toContain("at most");
    const list = Array.from({ length: 250 }, (_, i) => i).join(",");
    expect(errorOf(`if cost in [${list}] then 1`).message).toMatch(/at most|tokens|too large/);
  });

  it("refuses numbers that overflow", () => {
    expect(errorOf("cost * 1e999").message).toContain("too large");
  });

  it("refuses control characters and unicode operators", () => {
    expect(pricingExpressionError("cost\u0000")).not.toBeNull();
    expect(pricingExpressionError("cost × 2")).not.toBeNull();
    expect(pricingExpressionError("cost ")).not.toBeNull();
  });

  it("does not allow line breaks inside strings", () => {
    expect(errorOf('if service == "a\nb" then 1').message).toContain("span lines");
  });

  it("only allows escaping quotes and backslashes", () => {
    expect(run('if service == "a\\"b" then 1 else 0', { service: 'a"b' })).toBe(1);
    expect(errorOf('if service == "a\\nb" then 1').message).toContain("can be escaped");
  });

  it("never evaluates anything beyond the context", () => {
    // Every field resolves to a value from the context and nothing else.
    const c = ctx({ service: "x" });
    const compiled = compilePricingExpression('if service == "x" then usage else 0');
    expect(evaluatePricingExpression(compiled, c)).toBe(50);
  });
});

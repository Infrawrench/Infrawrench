/**
 * The four properties billing rules rest on, tested against the **actual SQL**
 * the readers emit rather than against a restatement of it.
 *
 * 1. **One scan.** Rules compile into the statement that was going to run
 *    anyway. No query per rule, no post-processing of rows in application code.
 * 2. **Raw is never mutated.** The collected figure comes back from the same
 *    pass as the literal stored column, untouched by any factor, and no
 *    statement anywhere writes to `cost_daily`.
 * 3. **Markups compose.** Two matching 10% rules give ×1.21, not ×1.10.
 * 4. **Reallocation conserves money.** Tested as an invariant over generated
 *    rule sets and rows, not as an example: the total after reallocation equals
 *    the total before, for every input.
 *
 * The evaluator below parses and runs the emitted expressions, so this file
 * fails if the SQL and the intent ever diverge — the same stance
 * `commitment-coverage-basis.test.ts` takes toward the amortized expression.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { compileBillingRules, type BillingRule } from "@infrawrench/client-core";

const captured: Array<{ sql: string; params: Record<string, unknown> }> = [];

vi.mock("../clickhouse/client", () => ({
  isClickHouseConfigured: () => true,
  getClickHouseClient: () => ({
    query: async ({
      query,
      query_params,
    }: {
      query: string;
      query_params: Record<string, unknown>;
    }) => {
      captured.push({ sql: query, params: query_params });
      return { json: async () => [] };
    },
  }),
}));

const { queryCosts, getShowbackSpend } = await import("../clickhouse/cost-readers");

/* ── A tiny evaluator for the emitted expressions ──────────────────────────── */

interface Row {
  amount: number;
  amortized_amount: number;
  amortized_reported: number;
  account_id: string;
  plugin_id: string;
  service: string;
  charge_type: string;
  tags: Record<string, string>;
  currency: string;
}

function row(over: Partial<Row> = {}): Row {
  return {
    amount: 100,
    amortized_amount: 0,
    amortized_reported: 0,
    account_id: "acct-a",
    plugin_id: "aws",
    service: "AmazonEC2",
    charge_type: "usage",
    tags: {},
    currency: "USD",
    ...over,
  };
}

type Value = string | number | boolean;

/**
 * Evaluate a ClickHouse expression of the subset these readers emit:
 * `if(...)`, `multiIf(...)`, `mapContains(tags, {p:String})`,
 * `tags[{p:String}]`, bound parameters, columns, numeric literals, `''`, `*`,
 * `=`, `!=`, `AND`, `OR`, and a bare `1`.
 *
 * Deliberately narrow. Anything the compiler starts emitting that is not in
 * this grammar throws rather than being silently skipped, so a new construct
 * cannot slip past these invariants unexamined.
 */
function evaluate(expr: string, r: Row, params: Record<string, unknown>): Value {
  let i = 0;
  const s = expr;

  const ws = () => {
    while (i < s.length && /\s/.test(s[i]!)) i++;
  };
  const eat = (text: string): boolean => {
    ws();
    if (s.startsWith(text, i)) {
      i += text.length;
      return true;
    }
    return false;
  };
  const expect_ = (text: string) => {
    if (!eat(text)) throw new Error(`expected "${text}" at ${i} in: ${s}`);
  };
  const truthy = (v: Value): boolean => v === true || v === 1;

  const param = (): Value => {
    // `{name:String}` — the only way a rule's own values reach the SQL.
    expect_("{");
    const end = s.indexOf("}", i);
    const [name] = s.slice(i, end).split(":");
    i = end + 1;
    const value = params[name!.trim()];
    if (value === undefined) throw new Error(`unbound parameter ${name} in: ${s}`);
    return value as Value;
  };

  const orExpr = (): Value => {
    let left = andExpr();
    for (;;) {
      ws();
      if (!eat("OR ")) return left;
      const right = andExpr();
      left = truthy(left) || truthy(right);
    }
  };
  const andExpr = (): Value => {
    let left = cmpExpr();
    for (;;) {
      ws();
      if (!eat("AND ")) return left;
      const right = cmpExpr();
      left = truthy(left) && truthy(right);
    }
  };
  const cmpExpr = (): Value => {
    const left = mulExpr();
    ws();
    if (eat("!=")) return left !== mulExpr();
    // Guard against consuming the `=` of a `!=` — `!=` is tried first.
    if (eat("=")) return left === mulExpr();
    return left;
  };
  const mulExpr = (): Value => {
    let left = primary();
    for (;;) {
      ws();
      if (!eat("*")) return left;
      left = Number(left) * Number(primary());
    }
  };
  const primary = (): Value => {
    ws();
    if (eat("(")) {
      const v = orExpr();
      expect_(")");
      return v;
    }
    if (eat("if(")) {
      const cond = orExpr();
      expect_(",");
      const a = orExpr();
      expect_(",");
      const b = orExpr();
      expect_(")");
      return truthy(cond) ? a : b;
    }
    if (eat("multiIf(")) {
      const arms: Value[] = [];
      for (;;) {
        arms.push(orExpr());
        if (eat(")")) break;
        expect_(",");
      }
      // (cond, value) pairs followed by one default.
      for (let k = 0; k + 1 < arms.length; k += 2) {
        if (truthy(arms[k]!)) return arms[k + 1]!;
      }
      return arms[arms.length - 1]!;
    }
    if (eat("mapContains(tags,")) {
      const key = String(param());
      expect_(")");
      return Object.prototype.hasOwnProperty.call(r.tags, key);
    }
    if (eat("tags[")) {
      const key = String(param());
      expect_("]");
      return r.tags[key] ?? "";
    }
    ws();
    if (s[i] === "{") return param();
    if (eat("''")) return "";
    const numberMatch = /^-?\d+(\.\d+)?/.exec(s.slice(i));
    if (numberMatch) {
      i += numberMatch[0].length;
      return Number(numberMatch[0]);
    }
    const identMatch = /^[a-z_][a-z0-9_]*/.exec(s.slice(i));
    if (identMatch) {
      i += identMatch[0].length;
      const name = identMatch[0];
      if (!(name in r)) throw new Error(`unknown column "${name}" in: ${s}`);
      return (r as unknown as Record<string, Value>)[name]!;
    }
    throw new Error(`cannot parse at ${i} in: ${s}`);
  };

  const value = orExpr();
  ws();
  if (i !== s.length) throw new Error(`trailing input at ${i} in: ${s}`);
  return value;
}

/** The expression a `SELECT` column is aliased from, e.g. `AS amount`. */
function selectExpr(sql: string, alias: string): string {
  const at = sql.indexOf(` AS ${alias}`);
  if (at < 0) throw new Error(`no column aliased ${alias} in:\n${sql}`);
  let depth = 0;
  let start = 0;
  for (let k = at - 1; k >= 0; k--) {
    const ch = sql[k]!;
    if (ch === ")") depth++;
    else if (ch === "(") depth--;
    else if (depth === 0 && ch === ",") {
      start = k + 1;
      break;
    }
  }
  // `>=` and not `>`: the first column starts at index 0 with no comma before
  // it, so `start` is still 0 and the SELECT keyword itself must be stripped.
  const select = sql.lastIndexOf("SELECT", at);
  if (select >= start) start = select + "SELECT".length;
  return sql.slice(start, at).trim();
}

/** `sum(X)` → `X`. */
function unsum(expr: string): string {
  const match = /^sum\((.*)\)$/s.exec(expr);
  if (!match) throw new Error(`expected a sum(): ${expr}`);
  return match[1]!;
}

/* ── Fixtures ──────────────────────────────────────────────────────────────── */

let seq = 0;
function rule(over: Partial<BillingRule> & Pick<BillingRule, "adjustment">): BillingRule {
  seq += 1;
  return {
    id: `rule-${seq}`,
    name: `Rule ${seq}`,
    description: null,
    enabled: true,
    priority: seq,
    match: {},
    createdAt: `2026-01-0${(seq % 9) + 1}T00:00:00.000Z`,
    updatedAt: `2026-01-0${(seq % 9) + 1}T00:00:00.000Z`,
    ...over,
  };
}

const markup = (percent: number, match: BillingRule["match"] = {}, priority = 0) =>
  rule({ adjustment: { kind: "percentage", percent }, match, priority });

const move = (
  targetKind: "cost_centre" | "account",
  targetId: string,
  match: BillingRule["match"] = {},
  priority = 0,
) => rule({ adjustment: { kind: "reallocation", targetKind, targetId }, match, priority });

const baseQuery = {
  from: "2026-08-01",
  to: "2026-08-31",
  binning: "daily" as const,
  groupBy: "account" as const,
  filters: [],
};

beforeEach(() => {
  captured.length = 0;
  seq = 0;
});

/* ── 1. One scan ───────────────────────────────────────────────────────────── */

describe("rules compile into the query, not around it", () => {
  it("issues exactly one statement no matter how many rules are in force", async () => {
    const rules = [
      markup(10, { pluginId: "aws" }, 0),
      markup(5, { service: "AmazonEC2" }, 1),
      move("cost_centre", "cc-platform", { tagKey: "team", tagValue: "platform" }, 2),
      move("account", "acct-shared", { service: "AmazonEKS" }, 3),
    ];
    await queryCosts("org", { ...baseQuery, adjustments: compileBillingRules(rules) });

    expect(captured).toHaveLength(1);
    expect(captured[0]!.sql.match(/FROM cost_daily/g)).toHaveLength(1);
  });

  it("keeps the showback report to one scan with rules layered on", async () => {
    await getShowbackSpend(
      "org",
      [{ costCentreId: "cc-a", match: { tagKey: "team", tagValue: "search" } }],
      "2026-08-01",
      "2026-08-31",
      undefined,
      compileBillingRules([markup(15), move("cost_centre", "cc-shared", { service: "AmazonEKS" })]),
    );
    expect(captured).toHaveLength(1);
    expect(captured[0]!.sql.match(/FROM cost_daily/g)).toHaveLength(1);
  });

  it("emits the statement it always did when no rules are passed", async () => {
    await queryCosts("org", baseQuery);
    const withoutRules = captured[0]!.sql;
    expect(withoutRules).not.toContain("raw_amount");
    expect(unsum(selectExpr(withoutRules, "amount"))).toBe("amount");
    expect(selectExpr(withoutRules, "grp")).toBe("account_id");
  });
});

/* ── 2. Raw is never mutated ───────────────────────────────────────────────── */

describe("collected spend is never touched", () => {
  it("returns the literal stored column as the raw aggregate, in the same scan", async () => {
    await queryCosts("org", {
      ...baseQuery,
      adjustments: compileBillingRules([markup(50), move("account", "acct-z")]),
    });
    const { sql } = captured[0]!;
    // Not "contains amount" — *is* the column, with nothing applied to it.
    expect(unsum(selectExpr(sql, "raw_amount"))).toBe("amount");
    expect(captured).toHaveLength(1);
  });

  it("never writes: every statement a rule takes part in is a SELECT", async () => {
    await queryCosts("org", { ...baseQuery, adjustments: compileBillingRules([markup(25)]) });
    await getShowbackSpend("org", [], "2026-08-01", "2026-08-31", undefined, {
      factors: [],
      reallocations: [],
      fixed: [],
    });
    for (const { sql } of captured) {
      expect(sql.trimStart().startsWith("SELECT")).toBe(true);
      expect(sql).not.toMatch(/\b(INSERT|ALTER|UPDATE|DELETE)\b/i);
    }
  });

  it("follows the amortized basis on both figures, so they stay comparable", async () => {
    await queryCosts("org", {
      ...baseQuery,
      costBasis: "amortized",
      adjustments: compileBillingRules([markup(10)]),
    });
    const { sql } = captured[0]!;
    const raw = unsum(selectExpr(sql, "raw_amount"));
    expect(raw).toContain("amortized_amount");
    expect(unsum(selectExpr(sql, "amount"))).toContain(raw);
  });
});

/* ── 3. Markups compose ────────────────────────────────────────────────────── */

describe("percentage rules compose", () => {
  async function factorFor(rules: BillingRule[], r: Row): Promise<number> {
    captured.length = 0;
    await queryCosts("org", { ...baseQuery, adjustments: compileBillingRules(rules) });
    const { sql, params } = captured[0]!;
    return Number(evaluate(unsum(selectExpr(sql, "amount")), r, params)) / r.amount;
  }

  it("multiplies two matching 10% markups to 21%, not 20%", async () => {
    const factor = await factorFor([markup(10, { pluginId: "aws" }), markup(10)], row());
    expect(factor).toBeCloseTo(1.21, 10);
  });

  it("applies a discount and a markup together", async () => {
    // +20% overhead recovery, then a 15% negotiated discount: 1.2 × 0.85.
    const factor = await factorFor([markup(20), markup(-15)], row());
    expect(factor).toBeCloseTo(1.02, 10);
  });

  it("is order-independent — priority never changes the arithmetic", async () => {
    const a = await factorFor([markup(10, {}, 0), markup(-30, {}, 1)], row());
    const b = await factorFor([markup(-30, {}, 0), markup(10, {}, 1)], row());
    expect(a).toBeCloseTo(b, 12);
  });

  it("leaves a row no rule matches at exactly 1", async () => {
    const factor = await factorFor(
      [markup(500, { pluginId: "gcp" }), markup(300, { tagKey: "team", tagValue: "search" })],
      row({ plugin_id: "aws", tags: { team: "platform" } }),
    );
    expect(factor).toBe(1);
  });

  it("applies only the arms whose match holds, on a row several could claim", async () => {
    const r = row({ plugin_id: "aws", service: "AmazonEC2", tags: { team: "platform" } });
    const factor = await factorFor(
      [
        markup(10, { pluginId: "aws" }), // matches
        markup(10, { service: "AmazonEC2" }), // matches
        markup(100, { service: "AmazonS3" }), // does not
        markup(10, { tagKey: "team", tagValue: "platform" }), // matches
      ],
      r,
    );
    expect(factor).toBeCloseTo(1.1 ** 3, 10);
  });

  it("respects a charge-type match, so a markup can skip credits", async () => {
    const rules = [markup(30, { chargeType: "usage" })];
    expect(await factorFor(rules, row({ charge_type: "usage" }))).toBeCloseTo(1.3, 10);
    expect(await factorFor(rules, row({ charge_type: "credit" }))).toBe(1);
  });

  it("ignores disabled rules entirely", async () => {
    const off = rule({ adjustment: { kind: "percentage", percent: 900 }, enabled: false });
    expect(await factorFor([off], row())).toBe(1);
  });
});

/* ── 4. Reallocation conserves money ───────────────────────────────────────── */

describe("reallocation moves money without creating or destroying it", () => {
  it("does not appear in the money expression at all", async () => {
    // The structural half of the invariant: reallocation targets are bound as
    // `br*t` parameters, and the summed expression must not reference one.
    await queryCosts("org", {
      ...baseQuery,
      adjustments: compileBillingRules([
        move("account", "acct-shared", { service: "AmazonEKS" }),
        move("cost_centre", "cc-platform"),
      ]),
    });
    const { sql } = captured[0]!;
    expect(unsum(selectExpr(sql, "amount"))).toBe("amount");
    expect(selectExpr(sql, "grp")).toContain("multiIf");
  });

  /**
   * The behavioural half, as a property rather than an example: over many
   * generated rule sets and row sets, the total after reallocation equals the
   * total before. A deterministic PRNG so a failure is reproducible.
   */
  it("conserves the total over generated rule sets and rows", async () => {
    let seed = 0x2f6e2b1;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
    const accounts = ["acct-a", "acct-b", "acct-c"];
    const services = ["AmazonEC2", "AmazonS3", "AmazonEKS"];
    const teams = ["platform", "search", "growth"];

    for (let trial = 0; trial < 40; trial++) {
      seq = 0;
      const rules: BillingRule[] = [];
      const ruleCount = 1 + Math.floor(rand() * 4);
      for (let k = 0; k < ruleCount; k++) {
        const match: BillingRule["match"] = {};
        if (rand() < 0.5) match.accountId = pick(accounts);
        if (rand() < 0.5) match.service = pick(services);
        if (rand() < 0.4) {
          match.tagKey = "team";
          match.tagValue = pick(teams);
        }
        rules.push(
          rand() < 0.5
            ? move(pick(["account", "cost_centre"] as const), `target-${k}`, match, k)
            : move("account", pick(accounts), match, k),
        );
      }

      const rows: Row[] = [];
      for (let k = 0; k < 25; k++) {
        rows.push(
          row({
            amount: Math.round(rand() * 100_000) / 100,
            account_id: pick(accounts),
            service: pick(services),
            tags: { team: pick(teams) },
          }),
        );
      }

      captured.length = 0;
      await queryCosts("org", { ...baseQuery, adjustments: compileBillingRules(rules) });
      const { sql, params } = captured[0]!;
      const grpExpr = selectExpr(sql, "grp");
      const moneyExpr = unsum(selectExpr(sql, "amount"));

      const before = rows.reduce((sum, r) => sum + r.amount, 0);
      const byGroup = new Map<string, number>();
      for (const r of rows) {
        const key = String(evaluate(grpExpr, r, params));
        byGroup.set(key, (byGroup.get(key) ?? 0) + Number(evaluate(moneyExpr, r, params)));
      }
      const after = [...byGroup.values()].reduce((sum, v) => sum + v, 0);
      expect(after).toBeCloseTo(before, 8);
    }
  });

  it("moves a row exactly once — a later rule cannot re-claim it", async () => {
    // Two rules both match; first-match-wins means the second never fires, and
    // the row lands on `acct-first`.
    await queryCosts("org", {
      ...baseQuery,
      adjustments: compileBillingRules([
        move("account", "acct-first", { service: "AmazonEKS" }, 0),
        move("account", "acct-second", { service: "AmazonEKS" }, 1),
      ]),
    });
    const { sql, params } = captured[0]!;
    const r = row({ service: "AmazonEKS", account_id: "acct-a" });
    expect(evaluate(selectExpr(sql, "grp"), r, params)).toBe("acct-first");
  });

  it("lets a cost-centre rule consume a row the account expression then leaves alone", async () => {
    // The cross-kind case: the centre rule wins on priority, so the account
    // grouping must be unchanged — not re-attributed by the later account rule.
    // Otherwise the graph and the showback report would disagree about whether
    // that row moved.
    const rules = [
      move("cost_centre", "cc-platform", { service: "AmazonEKS" }, 0),
      move("account", "acct-second", { service: "AmazonEKS" }, 1),
    ];
    await queryCosts("org", { ...baseQuery, adjustments: compileBillingRules(rules) });
    const q = captured[0]!;
    const r = row({ service: "AmazonEKS", account_id: "acct-a" });
    expect(evaluate(selectExpr(q.sql, "grp"), r, q.params)).toBe("acct-a");

    captured.length = 0;
    await getShowbackSpend(
      "org",
      [{ costCentreId: "cc-original", match: {} }],
      "2026-08-01",
      "2026-08-31",
      undefined,
      compileBillingRules(rules),
    );
    const s = captured[0]!;
    expect(evaluate(selectExpr(s.sql, "centre"), r, s.params)).toBe("cc-platform");
  });

  it("falls through to the allocation rules for a row no billing rule claims", async () => {
    await getShowbackSpend(
      "org",
      [{ costCentreId: "cc-original", match: {} }],
      "2026-08-01",
      "2026-08-31",
      undefined,
      compileBillingRules([move("cost_centre", "cc-shared", { service: "AmazonEKS" })]),
    );
    const { sql, params } = captured[0]!;
    expect(evaluate(selectExpr(sql, "centre"), row({ service: "AmazonEC2" }), params)).toBe(
      "cc-original",
    );
  });
});

/* ── Markups and reallocation together ─────────────────────────────────────── */

describe("a markup and a reallocation on the same row", () => {
  it("marks the amount up and books it to the new owner", async () => {
    await queryCosts("org", {
      ...baseQuery,
      adjustments: compileBillingRules([
        markup(20, { service: "AmazonEKS" }, 0),
        move("account", "acct-platform", { service: "AmazonEKS" }, 1),
      ]),
    });
    const { sql, params } = captured[0]!;
    const r = row({ amount: 500, service: "AmazonEKS", account_id: "acct-a" });
    expect(evaluate(selectExpr(sql, "grp"), r, params)).toBe("acct-platform");
    expect(evaluate(unsum(selectExpr(sql, "amount")), r, params)).toBeCloseTo(600, 10);
    expect(evaluate(unsum(selectExpr(sql, "raw_amount")), r, params)).toBe(500);
  });
});

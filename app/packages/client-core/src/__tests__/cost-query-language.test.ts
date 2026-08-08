import { describe, expect, it } from "vitest";
import {
  COST_QUERY_LANGUAGE_SUMMARY,
  CostQueryFormatError,
  CostQueryParseError,
  formatCostQuery,
  isValidCostQuery,
  parseCostQuery,
} from "../cost-query-language";
import { COST_DIMENSIONS, type CostFilter } from "../costs";

/** Parse and assert it failed, returning the error for inspection. */
function parseError(source: string): CostQueryParseError {
  try {
    parseCostQuery(source);
  } catch (e) {
    if (e instanceof CostQueryParseError) return e;
    throw e;
  }
  throw new Error(`Expected a parse error for: ${source}`);
}

describe("parseCostQuery — the supported forms", () => {
  it("treats an empty query as no filter at all", () => {
    expect(parseCostQuery("")).toEqual([]);
    expect(parseCostQuery("   \n\t ")).toEqual([]);
  });

  it("compiles = to a single-value in", () => {
    expect(parseCostQuery("provider = 'aws'")).toEqual([
      { dimension: "provider", op: "in", values: ["aws"] },
    ]);
  });

  it("compiles != to a single-value not_in", () => {
    expect(parseCostQuery("region != 'us-east-1'")).toEqual([
      { dimension: "region", op: "not_in", values: ["us-east-1"] },
    ]);
  });

  it("compiles IN to a multi-value in", () => {
    expect(parseCostQuery("service IN ('AmazonEC2', 'AmazonS3')")).toEqual([
      { dimension: "service", op: "in", values: ["AmazonEC2", "AmazonS3"] },
    ]);
  });

  it("compiles NOT IN to a multi-value not_in", () => {
    expect(parseCostQuery("charge_type NOT IN ('credit','refund')")).toEqual([
      { dimension: "charge_type", op: "not_in", values: ["credit", "refund"] },
    ]);
  });

  it("ANDs terms into the conjunction the structure already is", () => {
    expect(parseCostQuery("provider = 'aws' AND region != 'eu-west-1'")).toEqual([
      { dimension: "provider", op: "in", values: ["aws"] },
      { dimension: "region", op: "not_in", values: ["eu-west-1"] },
    ]);
  });

  it("carries a tag key alongside the value", () => {
    expect(parseCostQuery("tag['owner'] = 'platform'")).toEqual([
      { dimension: "tag", op: "in", values: ["platform"], tagKey: "owner" },
    ]);
  });

  it("accepts a tag list and a double-quoted key", () => {
    expect(parseCostQuery('tag["env"] NOT IN ("dev", "staging")')).toEqual([
      { dimension: "tag", op: "not_in", values: ["dev", "staging"], tagKey: "env" },
    ]);
  });

  it("accepts every dimension the structured filter accepts", () => {
    for (const dimension of COST_DIMENSIONS) {
      const source = dimension === "tag" ? "tag['k'] = 'v'" : `${dimension} = 'v'`;
      expect(parseCostQuery(source)[0]!.dimension).toBe(dimension);
    }
  });

  it("treats keywords and dimension names as case-insensitive", () => {
    const lower = parseCostQuery("provider in ('aws') and service not in ('s3')");
    const upper = parseCostQuery("PROVIDER IN ('aws') AND Service NOT IN ('s3')");
    expect(upper).toEqual(lower);
  });

  it("ignores whitespace, including newlines between terms", () => {
    expect(parseCostQuery("  provider\n  =\n  'aws'\nAND\tregion = 'us-east-1'  ")).toEqual([
      { dimension: "provider", op: "in", values: ["aws"] },
      { dimension: "region", op: "in", values: ["us-east-1"] },
    ]);
  });

  it("keeps repeated values rather than silently deduplicating a filter", () => {
    expect(parseCostQuery("provider IN ('aws','aws')")[0]!.values).toEqual(["aws", "aws"]);
  });

  it("allows the same dimension twice — the terms simply AND", () => {
    expect(parseCostQuery("service = 'a' AND service != 'b'")).toHaveLength(2);
  });
});

describe("parseCostQuery — strings and escapes", () => {
  it("accepts single and double quotes interchangeably", () => {
    expect(parseCostQuery('provider = "aws"')).toEqual(parseCostQuery("provider = 'aws'"));
  });

  it("reads a doubled quote as a literal quote, SQL style", () => {
    expect(parseCostQuery("service = 'it''s'")[0]!.values).toEqual(["it's"]);
    expect(parseCostQuery('service = "say ""hi"""')[0]!.values).toEqual(['say "hi"']);
  });

  it("reads backslash escapes", () => {
    expect(parseCostQuery("service = 'it\\'s'")[0]!.values).toEqual(["it's"]);
    expect(parseCostQuery("service = 'a\\\\b'")[0]!.values).toEqual(["a\\b"]);
    expect(parseCostQuery("service = 'a\\nb'")[0]!.values).toEqual(["a\nb"]);
  });

  it("keeps a quote of the other kind literal", () => {
    expect(parseCostQuery('service = "it\'s"')[0]!.values).toEqual(["it's"]);
  });

  it("rejects an unknown escape rather than silently dropping the backslash", () => {
    // 'C:\Users' quietly becoming C:Users is a corrupted filter value, which is
    // worse than a query that refuses to run.
    const error = parseError("resource = 'C:\\Users'");
    expect(error.message).toContain("Unknown escape sequence \\U");
    expect(error.offset).toBe("resource = 'C:".length);
  });

  it("reports an unterminated string at its opening quote", () => {
    const error = parseError("provider = 'aws");
    expect(error.message).toContain("Unterminated string");
    expect(error.offset).toBe("provider = ".length);
  });

  it("preserves whitespace and unicode inside values", () => {
    expect(parseCostQuery("service = ' Amazon  Ünicode ☁️ '")[0]!.values).toEqual([
      " Amazon  Ünicode ☁️ ",
    ]);
  });

  it("accepts an empty string as a value — absent is a real dimension value", () => {
    expect(parseCostQuery("region = ''")[0]!.values).toEqual([""]);
  });
});

describe("parseCostQuery — errors are useful", () => {
  it("names the valid dimensions and suggests the nearest on a typo", () => {
    const error = parseError("provder = 'aws'");
    expect(error.offset).toBe(0);
    expect(error.length).toBe("provder".length);
    expect(error.message).toContain('Unknown dimension "provder"');
    expect(error.message).toContain('Did you mean "provider"');
    for (const dimension of COST_DIMENSIONS) expect(error.message).toContain(dimension);
    expect(error.expected).toEqual([...COST_DIMENSIONS]);
  });

  it("still lists the dimensions when nothing is close enough to suggest", () => {
    const error = parseError("zzzzzzzzzz = 'x'");
    expect(error.message).not.toContain("Did you mean");
    expect(error.message).toContain("Valid dimensions are");
  });

  it("points at the offending token, not the start of the query", () => {
    const error = parseError("provider = 'aws' AND regionn = 'x'");
    expect(error.offset).toBe("provider = 'aws' AND ".length);
  });

  it("rejects OR with an explanation instead of running an AND", () => {
    const error = parseError("provider = 'aws' OR provider = 'gcp'");
    expect(error.message).toContain("OR is not supported");
    expect(error.message).toContain("IN ('a', 'b')");
    expect(error.offset).toBe("provider = 'aws' ".length);
    expect(error.expected).toEqual(["AND"]);
  });

  it("rejects comparison operators the filter cannot express", () => {
    expect(parseError("provider > 'aws'").message).toContain("=, !=, IN and NOT IN");
    expect(parseError("service LIKE 'Amazon%'").message).toContain("LIKE is not supported");
  });

  it("rejects a lone ! as an operator", () => {
    const error = parseError("provider ! 'aws'");
    expect(error.message).toContain('Expected "!="');
    expect(error.offset).toBe("provider ".length);
  });

  it("insists the tag dimension carries a key", () => {
    const error = parseError("tag = 'platform'");
    expect(error.message).toContain("tag['owner'] = 'platform'");
  });

  it("rejects an empty tag key", () => {
    expect(parseError("tag[''] = 'x'").message).toContain("tag key cannot be empty");
  });

  it("rejects an unquoted value", () => {
    const error = parseError("provider = aws");
    expect(error.message).toContain("Expected a quoted value");
    expect(error.offset).toBe("provider = ".length);
  });

  it("rejects an empty IN list, which would match nothing", () => {
    expect(parseError("provider IN ()").message).toContain("at least one value");
  });

  it("rejects a trailing comma in a list", () => {
    const error = parseError("provider IN ('aws',)");
    expect(error.message).toContain("Expected a quoted value");
  });

  it("rejects two terms with no AND between them", () => {
    const error = parseError("provider = 'aws' region = 'x'");
    expect(error.message).toContain("Expected AND or the end of the query");
    expect(error.offset).toBe("provider = 'aws' ".length);
  });

  it("reports a truncated query at the end of the input", () => {
    const error = parseError("provider =");
    expect(error.message).toContain("the end of the query");
    expect(error.offset).toBe("provider =".length);
  });

  it("annotates the query with a caret under the span", () => {
    const error = parseError("provider = 'aws' AND regionn = 'x'");
    const lines = error.annotated().split("\n");
    expect(lines[1]).toBe("  provider = 'aws' AND regionn = 'x'");
    expect(lines[2]).toBe(`  ${" ".repeat("provider = 'aws' AND ".length)}${"^".repeat(7)}`);
  });

  it("never lets an offset fall outside the source", () => {
    for (const source of ["", "provider", "provider =", "tag[", "provider IN ("]) {
      let error: CostQueryParseError | null = null;
      try {
        parseCostQuery(source);
      } catch (e) {
        error = e as CostQueryParseError;
      }
      if (error) {
        expect(error.offset).toBeGreaterThanOrEqual(0);
        expect(error.offset).toBeLessThanOrEqual(source.length);
      }
    }
  });
});

describe("isValidCostQuery", () => {
  it("answers without throwing", () => {
    expect(isValidCostQuery("provider = 'aws'")).toBe(true);
    expect(isValidCostQuery("")).toBe(true);
    expect(isValidCostQuery("provider = ")).toBe(false);
  });
});

describe("formatCostQuery", () => {
  it("renders single values with = and != ", () => {
    expect(formatCostQuery([{ dimension: "provider", op: "in", values: ["aws"] }])).toBe(
      "provider = 'aws'",
    );
    expect(formatCostQuery([{ dimension: "region", op: "not_in", values: ["us-east-1"] }])).toBe(
      "region != 'us-east-1'",
    );
  });

  it("renders several values as a list", () => {
    expect(formatCostQuery([{ dimension: "service", op: "in", values: ["a", "b"] }])).toBe(
      "service IN ('a', 'b')",
    );
    expect(formatCostQuery([{ dimension: "service", op: "not_in", values: ["a", "b"] }])).toBe(
      "service NOT IN ('a', 'b')",
    );
  });

  it("renders a tag key in brackets", () => {
    expect(
      formatCostQuery([{ dimension: "tag", op: "in", values: ["platform"], tagKey: "owner" }]),
    ).toBe("tag['owner'] = 'platform'");
  });

  it("joins terms with AND", () => {
    expect(
      formatCostQuery([
        { dimension: "provider", op: "in", values: ["aws"] },
        { dimension: "tag", op: "not_in", values: ["dev"], tagKey: "env" },
      ]),
    ).toBe("provider = 'aws' AND tag['env'] != 'dev'");
  });

  it("escapes quotes, backslashes and newlines so the result is one line", () => {
    const text = formatCostQuery([
      { dimension: "resource", op: "in", values: ["it's", "a\\b", "x\ny"] },
    ]);
    expect(text).toBe("resource IN ('it\\'s', 'a\\\\b', 'x\\ny')");
    expect(text).not.toContain("\n");
  });

  it("skips value-less rows, which is what a half-added editor row looks like", () => {
    expect(
      formatCostQuery([
        { dimension: "provider", op: "in", values: [] },
        { dimension: "region", op: "in", values: ["eu-west-1"] },
      ]),
    ).toBe("region = 'eu-west-1'");
    expect(formatCostQuery([])).toBe("");
  });

  it("refuses to render a tag filter with no key rather than invent one", () => {
    expect(() => formatCostQuery([{ dimension: "tag", op: "in", values: ["x"] }])).toThrow(
      CostQueryFormatError,
    );
    try {
      formatCostQuery([
        { dimension: "provider", op: "in", values: ["aws"] },
        { dimension: "tag", op: "in", values: ["x"] },
      ]);
    } catch (e) {
      expect((e as CostQueryFormatError).index).toBe(1);
    }
  });
});

/* ------------------------------------------------------------------ *
 * Round-trip — the property, over generated inputs rather than examples.
 * ------------------------------------------------------------------ */

/**
 * A small deterministic PRNG so a failure is reproducible from its seed. The
 * generated corpus is the point of these tests: hand-picked examples check the
 * cases the author thought of, and the round trip has to hold for the ones they
 * did not — values carrying quotes, backslashes, keywords, brackets, commas and
 * empty strings, in every operator and dimension combination.
 */
function makeRandom(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x1_0000_0000;
  };
}

/** Value fragments chosen to attack the tokenizer, not to look realistic. */
const VALUE_FRAGMENTS = [
  "aws",
  "AmazonEC2",
  "us-east-1",
  "",
  " ",
  "it's",
  'say "hi"',
  "back\\slash",
  "AND",
  "or",
  "NOT IN",
  "tag['x']",
  "comma,separated",
  "(parens)",
  "=",
  "!=",
  "line\nbreak",
  "tab\there",
  "Ünicode ☁️",
  "'",
  '"',
  "\\",
  "''",
  "%",
  "0",
];

const TAG_KEYS = ["owner", "env", "cost centre", "it's", "a\\b", '"q"', "team.name"];

function randomFilter(random: () => number): CostFilter {
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;
  const dimension = pick(COST_DIMENSIONS);
  const op = random() < 0.5 ? "in" : "not_in";
  const count = 1 + Math.floor(random() * 4);
  const values = Array.from({ length: count }, () => pick(VALUE_FRAGMENTS));
  return dimension === "tag"
    ? { dimension, op, values, tagKey: pick(TAG_KEYS) }
    : { dimension, op, values };
}

describe("round trip", () => {
  it("parse(format(filters)) === filters, over 2000 generated filter lists", () => {
    const random = makeRandom(0x5eed);
    for (let i = 0; i < 2000; i += 1) {
      const filters = Array.from({ length: 1 + Math.floor(random() * 4) }, () =>
        randomFilter(random),
      );
      const text = formatCostQuery(filters);
      let round: CostFilter[];
      try {
        round = parseCostQuery(text);
      } catch (e) {
        throw new Error(
          `Rendered query failed to parse: ${text}\n${(e as CostQueryParseError).message}`,
        );
      }
      expect(round).toEqual(filters);
    }
  });

  it("format(parse(format(filters))) === format(filters) — rendering is canonical", () => {
    const random = makeRandom(0xc0ffee);
    for (let i = 0; i < 500; i += 1) {
      const filters = Array.from({ length: 1 + Math.floor(random() * 3) }, () =>
        randomFilter(random),
      );
      const once = formatCostQuery(filters);
      expect(formatCostQuery(parseCostQuery(once))).toBe(once);
    }
  });

  it("normalises hand-written text through the structure", () => {
    // Text → structure → text is a *normalisation*, not an identity: the row
    // editor has no way to remember that the user typed `in ( 'a' )`.
    expect(formatCostQuery(parseCostQuery("PROVIDER  in ( 'aws' )"))).toBe("provider = 'aws'");
    expect(formatCostQuery(parseCostQuery('tag["env"] not in ("a","b")'))).toBe(
      "tag['env'] NOT IN ('a', 'b')",
    );
  });

  it("survives every dimension × operator × arity combination", () => {
    for (const dimension of COST_DIMENSIONS) {
      for (const op of ["in", "not_in"] as const) {
        for (const values of [["one"], ["one", "two"], ["one", "two", "three"]]) {
          const filter: CostFilter =
            dimension === "tag"
              ? { dimension, op, values, tagKey: "k" }
              : { dimension, op, values };
          expect(parseCostQuery(formatCostQuery([filter]))).toEqual([filter]);
        }
      }
    }
  });
});

describe("documentation constants", () => {
  it("derives the language summary from COST_DIMENSIONS rather than a second list", () => {
    for (const dimension of COST_DIMENSIONS) {
      expect(COST_QUERY_LANGUAGE_SUMMARY).toContain(dimension);
    }
  });
});

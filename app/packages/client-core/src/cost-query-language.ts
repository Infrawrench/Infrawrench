/**
 * The cost query language — a small SQL-like text form for the *existing*
 * cost filter.
 *
 * `CostFilter[]` is a good shape for a row editor and a poor shape for
 * everything else: an API caller, a CLI flag, a script, or a line pasted into a
 * ticket. This module is the text front-end for that same structure, and
 * nothing more. It compiles to `CostFilter[]` and renders `CostFilter[]` back
 * out, so the filter rows and the text box are two views of one object and a
 * user can move between them without losing anything.
 *
 * Three properties are deliberate, and each one is a constraint rather than a
 * convenience:
 *
 * 1. **It is a front-end, not a query engine.** Anything the structured filter
 *    cannot express is a parse error here, never a new branch downstream.
 *    There is exactly one execution path (`clickhouse/cost-readers.ts`), one
 *    set of bound parameters, and therefore one security surface — the text
 *    never reaches SQL, only the compiled `CostFilter[]` does, and its values
 *    go through the same `{name:Array(String)}` binding they always did.
 * 2. **It round-trips.** `parseCostQuery(formatCostQuery(f))` deep-equals `f`
 *    for every filter list the API would accept.
 * 3. **Errors carry an offset.** A query language with vague errors is worse
 *    than the JSON blob it replaces, so every failure knows where it happened,
 *    what was expected there, and — for a misspelled dimension — what the real
 *    names are.
 *
 * Pure and dependency-free (no DOM, no Node APIs) so web, desktop, mobile, the
 * CLI and the server all share one parser rather than four that disagree.
 */

import { COST_DIMENSIONS, type CostDimensionId, type CostFilter } from "./costs";

/* ------------------------------------------------------------------ *
 * Errors
 * ------------------------------------------------------------------ */

/**
 * A query that could not be compiled, and where.
 *
 * `offset`/`length` describe a span in the *original* source, so a UI can
 * underline it and a terminal can put a caret under it. `expected` names what
 * would have been valid at that point — the dimension names when one is
 * misspelled, the operators when one is unsupported.
 */
export class CostQueryParseError extends Error {
  override readonly name = "CostQueryParseError";
  /** Zero-based character offset into `source` where the problem starts. */
  readonly offset: number;
  /** Length of the offending span; at least 1, clamped to the source end. */
  readonly length: number;
  readonly source: string;
  /** What would have been valid here, when there is a finite set of answers. */
  readonly expected: readonly string[];

  constructor(
    message: string,
    source: string,
    offset: number,
    length = 1,
    expected: readonly string[] = [],
  ) {
    super(message);
    this.source = source;
    this.offset = Math.max(0, Math.min(offset, source.length));
    this.length = Math.max(1, length);
    this.expected = expected;
  }

  /**
   * The message with the query and a caret under the offending span — what the
   * CLI prints and what an API error body can carry verbatim.
   */
  annotated(): string {
    const caretPad = " ".repeat(this.offset);
    const caret = "^".repeat(Math.max(1, Math.min(this.length, this.source.length - this.offset)));
    return `${this.message}\n  ${this.source}\n  ${caretPad}${caret}`;
  }
}

/**
 * A `CostFilter[]` that has no text form.
 *
 * Only one filter is genuinely inexpressible: a `tag` filter with no key,
 * because the language has nowhere to put the missing key. Rather than invent a
 * placeholder that would parse back into a *different* filter, rendering fails
 * loudly — the editors that can hold a half-finished row are the ones that get
 * this, and they can say "finish the row" instead of silently dropping it.
 */
export class CostQueryFormatError extends Error {
  override readonly name = "CostQueryFormatError";
  /** Index into the filter array that could not be rendered. */
  readonly index: number;

  constructor(message: string, index: number) {
    super(message);
    this.index = index;
  }
}

/* ------------------------------------------------------------------ *
 * Tokenizer
 * ------------------------------------------------------------------ */

type TokenKind = "ident" | "string" | "punct" | "eof";

interface Token {
  kind: TokenKind;
  /** Source text of the token (the raw literal, quotes included, for strings). */
  text: string;
  /** Decoded value for strings; the source text otherwise. */
  value: string;
  start: number;
  end: number;
}

const IDENT_START = /[A-Za-z_]/;
const IDENT_PART = /[A-Za-z0-9_]/;
const WHITESPACE = /[ \t\r\n]/;

/**
 * String escapes, deliberately small.
 *
 * Both SQL's doubled quote (`'it''s'`) and backslash escapes (`'it\'s'`) are
 * accepted, because people reach for both and neither is a surprise. An
 * *unrecognised* escape is an error rather than a silent pass-through: silently
 * turning `'C:\Users'` into `C:Users` would corrupt a filter value with no
 * indication, and a value that means something else is worse than a query that
 * refuses to run.
 */
const ESCAPES: Record<string, string> = {
  "\\": "\\",
  "'": "'",
  '"': '"',
  n: "\n",
  t: "\t",
};

function readString(source: string, start: number): Token {
  const quote = source[start]!;
  let i = start + 1;
  let value = "";
  while (i < source.length) {
    const ch = source[i]!;
    if (ch === quote) {
      // A doubled quote is a literal quote — SQL's own escape.
      if (source[i + 1] === quote) {
        value += quote;
        i += 2;
        continue;
      }
      return { kind: "string", text: source.slice(start, i + 1), value, start, end: i + 1 };
    }
    if (ch === "\\") {
      const next = source[i + 1];
      if (next === undefined) {
        throw new CostQueryParseError(
          "Unterminated string — the query ends inside a quoted value.",
          source,
          start,
          source.length - start,
        );
      }
      const decoded = ESCAPES[next];
      if (decoded === undefined) {
        throw new CostQueryParseError(
          `Unknown escape sequence \\${next}. Valid escapes are \\\\ \\' \\" \\n \\t, or double the quote (''), and a lone backslash must be written \\\\.`,
          source,
          i,
          2,
        );
      }
      value += decoded;
      i += 2;
      continue;
    }
    value += ch;
    i += 1;
  }
  throw new CostQueryParseError(
    `Unterminated string — no closing ${quote} before the end of the query.`,
    source,
    start,
    source.length - start,
  );
}

/**
 * Characters that start an operator the *structured* filter cannot express.
 * Recognising them explicitly is the whole point: `spend > 100` failing with
 * "unexpected character" tells the user nothing, while naming the four
 * supported operators tells them everything.
 */
const UNSUPPORTED_OPERATOR_CHARS = new Set(["<", ">", "~", "%"]);

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i]!;
    if (WHITESPACE.test(ch)) {
      i += 1;
      continue;
    }
    if (ch === "'" || ch === '"') {
      const token = readString(source, i);
      tokens.push(token);
      i = token.end;
      continue;
    }
    if (IDENT_START.test(ch)) {
      let j = i + 1;
      while (j < source.length && IDENT_PART.test(source[j]!)) j += 1;
      const text = source.slice(i, j);
      tokens.push({ kind: "ident", text, value: text, start: i, end: j });
      i = j;
      continue;
    }
    if (ch === "!") {
      if (source[i + 1] === "=") {
        tokens.push({ kind: "punct", text: "!=", value: "!=", start: i, end: i + 2 });
        i += 2;
        continue;
      }
      throw new CostQueryParseError(
        'Expected "!=" — a lone "!" is not an operator.',
        source,
        i,
        1,
        ["!="],
      );
    }
    if (ch === "=" || ch === "(" || ch === ")" || ch === "," || ch === "[" || ch === "]") {
      tokens.push({ kind: "punct", text: ch, value: ch, start: i, end: i + 1 });
      i += 1;
      continue;
    }
    if (UNSUPPORTED_OPERATOR_CHARS.has(ch)) {
      throw new CostQueryParseError(
        `"${ch}" is not supported. Cost filters compare for equality only: =, !=, IN and NOT IN.`,
        source,
        i,
        1,
        ["=", "!=", "IN", "NOT IN"],
      );
    }
    throw new CostQueryParseError(`Unexpected character "${ch}".`, source, i, 1);
  }
  tokens.push({ kind: "eof", text: "", value: "", start: source.length, end: source.length });
  return tokens;
}

/* ------------------------------------------------------------------ *
 * "Did you mean…" for a misspelled dimension
 * ------------------------------------------------------------------ */

/** Levenshtein distance, bounded by nothing clever — the inputs are tiny. */
function editDistance(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  let prev = Array.from({ length: cols }, (_, j) => j);
  for (let i = 1; i < rows; i += 1) {
    const row = [i, ...new Array<number>(cols - 1).fill(0)];
    for (let j = 1; j < cols; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row[j] = Math.min(prev[j]! + 1, row[j - 1]! + 1, prev[j - 1]! + cost);
    }
    prev = row;
  }
  return prev[cols - 1]!;
}

/** The closest dimension name, when one is close enough to be worth naming. */
function suggestDimension(name: string): CostDimensionId | null {
  let best: CostDimensionId | null = null;
  let bestDistance = Infinity;
  for (const dimension of COST_DIMENSIONS) {
    const distance = editDistance(name.toLowerCase(), dimension);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = dimension;
    }
  }
  // Half the word wrong is not a typo, it is a different word.
  return best !== null && bestDistance <= Math.max(2, Math.floor(name.length / 2)) ? best : null;
}

/* ------------------------------------------------------------------ *
 * Parser — recursive descent over the token list
 * ------------------------------------------------------------------ */

/**
 * The grammar, in full:
 *
 *   query      := ε | term ( AND term )*
 *   term       := dimension operator value
 *   dimension  := IDENT | "tag" "[" string "]"
 *   operator   := "=" | "!=" | IN | NOT IN
 *   value      := string                            (for "=" and "!=")
 *              |  "(" string ( "," string )* ")"    (for IN and NOT IN)
 *
 * Keywords are case-insensitive; strings are single- or double-quoted.
 */
export const COST_QUERY_GRAMMAR = [
  "query     := ε | term (AND term)*",
  "term      := dimension operator value",
  "dimension := name | tag['key']",
  "operator  := = | != | IN | NOT IN",
  "value     := 'text' | ('a', 'b', …)",
].join("\n");

/**
 * Longest query the API accepts.
 *
 * The tokenizer is linear and allocates nothing per character beyond the token
 * list, so this is not a safety bound so much as a sanity one: a filter a human
 * wrote is two orders of magnitude shorter, and anything longer is a client
 * bug worth failing loudly at the edge rather than parsing.
 */
export const COST_QUERY_MAX_LENGTH = 4000;

/** One line naming the language and its shape, for help text and tool docs. */
export const COST_QUERY_LANGUAGE_SUMMARY =
  "A conjunction of equality terms over the cost dimensions: " +
  `${COST_DIMENSIONS.join(", ")}. ` +
  "Supported forms are `dimension = 'value'`, `dimension != 'value'`, " +
  "`dimension IN ('a','b')`, `dimension NOT IN ('a','b')` and `tag['owner'] = 'platform'`, " +
  "joined by AND. Keywords are case-insensitive. OR is not supported — the filter is a " +
  "conjunction, so use IN ('a','b') to accept several values of one dimension.";

class Parser {
  private index = 0;

  constructor(
    private readonly source: string,
    private readonly tokens: Token[],
  ) {}

  private peek(): Token {
    return this.tokens[this.index]!;
  }

  private next(): Token {
    const token = this.tokens[this.index]!;
    if (token.kind !== "eof") this.index += 1;
    return token;
  }

  /**
   * The error for a token, ready to `throw`. Returned rather than thrown so
   * every call site reads `throw this.fail(...)` — the control flow is visible
   * at the call site instead of depending on a `never` return type.
   */
  private fail(
    message: string,
    token: Token,
    expected: readonly string[] = [],
  ): CostQueryParseError {
    return new CostQueryParseError(
      message,
      this.source,
      token.start,
      Math.max(1, token.end - token.start),
      expected,
    );
  }

  /** Human name for a token, for "expected X, found Y" messages. */
  private describe(token: Token): string {
    if (token.kind === "eof") return "the end of the query";
    if (token.kind === "string") return `the value ${token.text}`;
    return `"${token.text}"`;
  }

  parse(): CostFilter[] {
    if (this.peek().kind === "eof") return [];

    const filters: CostFilter[] = [];
    for (;;) {
      filters.push(this.parseTerm());
      const token = this.peek();
      if (token.kind === "eof") break;
      if (token.kind === "ident" && token.value.toLowerCase() === "and") {
        this.next();
        continue;
      }
      if (token.kind === "ident" && token.value.toLowerCase() === "or") {
        // The whole reason this is a parse error and not a feature: the stored
        // filter is a conjunction, and there is nowhere in `CostFilter[]` to
        // record a disjunction. Accepting OR would mean either silently
        // running an AND (a wrong number, quietly) or growing a second
        // execution path. Rejecting it costs the user one edit.
        throw this.fail(
          "OR is not supported. A cost filter is a conjunction of terms, so several values of " +
            "one dimension go in a list — write dimension IN ('a', 'b') — and unrelated " +
            "alternatives need separate queries.",
          token,
          ["AND"],
        );
      }
      throw this.fail(
        `Expected AND or the end of the query, found ${this.describe(token)}.`,
        token,
        ["AND"],
      );
    }
    return filters;
  }

  private parseTerm(): CostFilter {
    const { dimension, tagKey } = this.parseDimension();
    const { op, values } = this.parseOperatorAndValues();
    return dimension === "tag" ? { dimension, op, values, tagKey } : { dimension, op, values };
  }

  private parseDimension(): { dimension: CostDimensionId; tagKey?: string } {
    const token = this.next();
    if (token.kind !== "ident") {
      throw this.fail(
        `Expected a dimension name, found ${this.describe(token)}.`,
        token,
        COST_DIMENSIONS,
      );
    }
    const name = token.value.toLowerCase();

    if (name === "tag") {
      const bracket = this.peek();
      if (bracket.kind !== "punct" || bracket.text !== "[") {
        throw this.fail(
          "The tag dimension needs a key: write tag['owner'] = 'platform'.",
          bracket.kind === "eof" ? token : bracket,
          ["["],
        );
      }
      this.next();
      const key = this.next();
      if (key.kind !== "string") {
        throw this.fail(
          `Expected a quoted tag key, found ${this.describe(key)}. Write tag['owner'] = 'platform'.`,
          key,
        );
      }
      if (key.value === "") {
        throw this.fail("A tag key cannot be empty.", key);
      }
      const close = this.next();
      if (close.kind !== "punct" || close.text !== "]") {
        throw this.fail(`Expected "]" after the tag key, found ${this.describe(close)}.`, close, [
          "]",
        ]);
      }
      return { dimension: "tag", tagKey: key.value };
    }

    const match = COST_DIMENSIONS.find((d) => d === name);
    if (!match) {
      const suggestion = suggestDimension(name);
      throw this.fail(
        `Unknown dimension "${token.text}".${suggestion ? ` Did you mean "${suggestion}"?` : ""} ` +
          `Valid dimensions are ${COST_DIMENSIONS.join(", ")}.`,
        token,
        COST_DIMENSIONS,
      );
    }
    return { dimension: match };
  }

  private parseOperatorAndValues(): { op: CostFilter["op"]; values: string[] } {
    const token = this.next();

    if (token.kind === "punct" && (token.text === "=" || token.text === "!=")) {
      const value = this.next();
      if (value.kind !== "string") {
        throw this.fail(
          `Expected a quoted value after "${token.text}", found ${this.describe(value)}. ` +
            "Values are quoted: service = 'AmazonEC2'.",
          value,
        );
      }
      return { op: token.text === "=" ? "in" : "not_in", values: [value.value] };
    }

    if (token.kind === "ident") {
      const keyword = token.value.toLowerCase();
      if (keyword === "in") return { op: "in", values: this.parseValueList() };
      if (keyword === "not") {
        const inToken = this.next();
        if (inToken.kind !== "ident" || inToken.value.toLowerCase() !== "in") {
          throw this.fail(`Expected IN after NOT, found ${this.describe(inToken)}.`, inToken, [
            "IN",
          ]);
        }
        return { op: "not_in", values: this.parseValueList() };
      }
      if (keyword === "like" || keyword === "contains" || keyword === "matches") {
        throw this.fail(
          `${token.text.toUpperCase()} is not supported. Cost filters compare for equality only: ` +
            "=, !=, IN and NOT IN.",
          token,
          ["=", "!=", "IN", "NOT IN"],
        );
      }
    }

    throw this.fail(`Expected =, !=, IN or NOT IN, found ${this.describe(token)}.`, token, [
      "=",
      "!=",
      "IN",
      "NOT IN",
    ]);
  }

  private parseValueList(): string[] {
    const open = this.next();
    if (open.kind !== "punct" || open.text !== "(") {
      throw this.fail(
        `Expected "(" after IN, found ${this.describe(open)}. Write IN ('a', 'b').`,
        open,
        ["("],
      );
    }
    const closeImmediately = this.peek();
    if (closeImmediately.kind === "punct" && closeImmediately.text === ")") {
      throw this.fail(
        "An empty list matches nothing. Give IN at least one value, or drop the term.",
        closeImmediately,
      );
    }

    const values: string[] = [];
    for (;;) {
      const value = this.next();
      if (value.kind !== "string") {
        throw this.fail(
          `Expected a quoted value, found ${this.describe(value)}. Write IN ('a', 'b').`,
          value,
        );
      }
      values.push(value.value);
      const separator = this.next();
      if (separator.kind === "punct" && separator.text === ",") continue;
      if (separator.kind === "punct" && separator.text === ")") return values;
      throw this.fail(`Expected "," or ")", found ${this.describe(separator)}.`, separator, [
        ",",
        ")",
      ]);
    }
  }
}

/**
 * Compile a query into the structured filter it is a front-end for.
 *
 * An empty (or whitespace-only) query is `[]` — no filter, the same as an empty
 * row editor — rather than an error, so a text box a user has cleared behaves
 * the way a text box a user has cleared should.
 *
 * @throws {CostQueryParseError} with an offset, a message, and the valid
 * alternatives at that position.
 */
export function parseCostQuery(source: string): CostFilter[] {
  return new Parser(source, tokenize(source)).parse();
}

/** `true` when the query compiles; for a cheap "is this valid" check. */
export function isValidCostQuery(source: string): boolean {
  try {
    parseCostQuery(source);
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ *
 * Rendering — the other half of the round trip
 * ------------------------------------------------------------------ */

/**
 * Quote a value as a single-quoted literal.
 *
 * The backslash is escaped first, so a value that already contains one cannot
 * combine with a following quote's escape to mean something else. Newlines and
 * tabs are escaped too — not for correctness (the tokenizer keeps literal
 * whitespace inside a string) but so a rendered query is always one line.
 */
function quote(value: string): string {
  const escaped = value
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/\n/g, "\\n")
    .replace(/\t/g, "\\t");
  return `'${escaped}'`;
}

/**
 * Render a structured filter back to query text.
 *
 * The rendering is canonical: a single value always uses `=` / `!=` and several
 * always use `IN` / `NOT IN`, so `parseCostQuery(formatCostQuery(f))` is `f`
 * exactly, and `formatCostQuery(parseCostQuery(text))` is a normalised form of
 * `text`.
 *
 * Filters with no values are skipped — an empty `values` is what a freshly
 * added editor row looks like, it expresses nothing, and the editors already
 * drop those before saving. A `tag` filter with no key is the one thing that
 * cannot be rendered at all, and throws.
 *
 * @throws {CostQueryFormatError} for a tag filter with no key.
 */
export function formatCostQuery(filters: readonly CostFilter[]): string {
  const terms: string[] = [];
  filters.forEach((filter, index) => {
    if (filter.values.length === 0) return;
    let name: string;
    if (filter.dimension === "tag") {
      if (!filter.tagKey) {
        throw new CostQueryFormatError(
          "A tag filter needs a key before it can be written as a query.",
          index,
        );
      }
      name = `tag[${quote(filter.tagKey)}]`;
    } else {
      name = filter.dimension;
    }
    if (filter.values.length === 1) {
      terms.push(`${name} ${filter.op === "in" ? "=" : "!="} ${quote(filter.values[0]!)}`);
    } else {
      const list = filter.values.map(quote).join(", ");
      terms.push(`${name} ${filter.op === "in" ? "IN" : "NOT IN"} (${list})`);
    }
  });
  return terms.join(" AND ");
}
